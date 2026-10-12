# ADR 001 — IFC engine

- **Status:** Accepted
- **Date:** 2026-09-03
- **Phase:** 1 (blocking)
- **Supersedes:** —

## Context

Seven modules need to read IFC, and three of them need to write it back or
derive documents from it:

| Module | Needs |
|---|---|
| `/viewer` | parse, spatial tree, properties, geometry, federation |
| `/georef` | `IfcMapConversion`, `IfcProjectedCRS`, `IfcSite` lat/long, **STEP write-back** |
| `/ids/create` | entity classes, Psets, properties, materials, classifications for autocomplete |
| `/ids/validate` | IDS 1.0 evaluation over the model, at speed |
| `/bcf` | BCF 3.0 read/write (not IFC, but the same dependency family) |
| `/sign/*` | nothing — signing hashes the original bytes and never re-serialises |

The two credible options are **IFC-lite** (`@ifc-lite/*`, MPL-2.0, Rust→WASM)
and **That Open Engine** (`web-ifc` + `@thatopen/*`, MIT, C++→WASM).

The build brief pre-selected IFC-lite and asked for a spike to confirm or
overturn it before anything is built on top.

## The spike

`frontend/scripts/spike-ifc-engine.mts`, run against
`frontend/fixtures/ifc/*.ifc` plus synthetic models from
`frontend/scripts/generate-large-ifc.mts`.

Machine: Apple Silicon, macOS 25.5, Node 26.5, `--max-old-space-size=8192`.
Versions: `@ifc-lite/parser` 4.3.2, `web-ifc` 0.0.77.

The synthetic models are structurally realistic (spatial hierarchy, placements,
extruded-solid geometry, property sets, georeferencing block) but far more
uniform than a vendor export. They are a load test, not a fidelity test.

| engine | file | size MB | parse ms | rss Δ MB | entities | props ms (2000 walls) | psets | georef | CRS |
|---|---|--:|--:|--:|--:|--:|--:|---|---|
| ifc-lite | georeferenced-wall-ifc4.ifc | 0 | 9 | 0.4 | 44 | 1 | 2 | mapConversion | EPSG:3763 |
| web-ifc | georeferenced-wall-ifc4.ifc | 0 | 24 | 1.9 | 44 | 2 | 2 | mapConversion | EPSG:3763 |
| ifc-lite | bridge-ifc4x3.ifc | 0 | 2 | 0.1 | 38 | 0 | 0 | mapConversion | EPSG:3763 |
| web-ifc | bridge-ifc4x3.ifc | 0 | 27 | 2.1 | 38 | 1 | 0 | mapConversion | EPSG:3763 |
| ifc-lite | synth-20mb.ifc | 20 | 428 | 100.5 | 337 832 | 9 | 700 | mapConversion | EPSG:3763 |
| web-ifc | synth-20mb.ifc | 20 | 230 | 40.4 | 337 832 | 86 | 700 | mapConversion | EPSG:3763 |
| ifc-lite | synth-200mb.ifc | 200.1 | 3 752 | 817.0 | 3 256 202 | 11 | 700 | mapConversion | EPSG:3763 |
| web-ifc | synth-200mb.ifc | 200.1 | 1 776 | 391.9 | 3 256 202 | 510 | 700 | mapConversion | EPSG:3763 |

### What the numbers say

1. **Both engines handle a 200 MB IFC4 in a single-threaded Node process.**
   3.8 s and 1.8 s respectively, well under a gigabyte of resident growth each.
   Neither is disqualified on capacity. In the app both run in a Worker, so
   neither number is a frame-rate problem.

2. **web-ifc parses about 2× faster and uses about 2× less memory.** That is a
   real advantage and it is honest to say so.

3. **The parse-time advantage inverts the moment you read properties.** At
   200 MB, reading the property sets of 2 000 walls takes IFC-lite 11 ms and
   web-ifc 510 ms — ~46×. IFC-lite spends its extra 2 s at load building the
   columnar index and the `entityId → propertySet` map; web-ifc defers that
   cost to whoever asks. `/ids/validate` asks for every element in the model,
   so the deferred cost lands squarely on our slowest operation.

   **Caveat, stated plainly:** the web-ifc figure walks
   `IfcRelDefinesByProperties` linearly per query, which is what a naive
   integrator does. `@thatopen/components` builds an index instead — paying
   roughly the same upfront cost IFC-lite already paid. So the honest reading is
   not "web-ifc is 46× slower at properties"; it is **"the work has to happen
   somewhere, IFC-lite has already done it, and with That Open we would be
   writing and maintaining that indexing layer ourselves."**

4. **Both round-trip `IfcMapConversion` and `IfcProjectedCRS` on read**,
   including at IFC4X3_ADD2 with a rotated grid. Georeferencing reading is not
   a differentiator. Georeferencing *writing* is — see below.

## Decision

**IFC-lite (`@ifc-lite/*`) is the primary engine, behind
`frontend/lib/ifc/adapter.ts`.**

The performance data does not decide this on its own; it establishes that both
engines are viable and that IFC-lite's cost model matches our workload. The
decision turns on coverage:

- **`@ifc-lite/export` writes STEP with georeferencing mutations built in**
  (`StepExportOptions.georefMutations`), and reports refusals it could not honour
  in `stats.warnings` — e.g. an `IfcMapConversion` with no representation
  context to reference as `SourceCRS`. Phase 4's entire write-back path is a
  library call. With That Open we would be writing a STEP serialiser.
- **`@ifc-lite/parser` ships `extractGeoreferencingOnDemand`**, which already
  covers the `ePSet_MapConversion` / `ePSet_ProjectedCRS` IFC2x3 fallback and
  IFC4X3's `IfcMapConversionScaled`. That is most of the `/georef` read panel.
- **`@ifc-lite/ids` and `@ifc-lite/bcf`** cover modules 5, 6 and 7 from the same
  dependency family, with no IFC→Fragments conversion pass in between.
- **`@ifc-lite/mutations`** gives an overlay editor, so an attribute edit never
  rewrites the source bytes — which matters more here than in most apps, because
  Phase 3 signs the *original* bytes and a STEP round-trip would invalidate the
  signature.
- IFC4X3 infrastructure classes (`IfcBridge`, `IfcBridgePart`, …) resolve their
  positional attributes correctly through `getAttributeNamesAcrossSchemas`,
  which our conformance suite pins.

Against that: IFC-lite is young, moves fast (14 packages, several released in
the last fortnight), is WebGPU-first, and has a much smaller community than
That Open. MPL-2.0 is file-level copyleft — fine for us, since we link rather
than modify, but it is a constraint That Open's MIT does not have.

## Consequences

1. **`frontend/lib/ifc/ifc-lite-adapter.ts` is the only file permitted to import
   `@ifc-lite/*`.** Enforced by review and by the lint rule in
   `frontend/eslint.config.mjs`. A second importer means the swap point is gone.

2. **`frontend/lib/ifc/conformance.ts` is the contract.** It is written against
   `IfcEngineAdapter` and imports no engine, so a That Open implementation can
   be dropped in and run through the same 23 assertions unchanged. Anything a
   module relies on must be asserted there, or it is not part of the contract.

3. **Swapping is per module, not all-or-nothing.** `getIfcAdapter(engineId)`
   takes an engine id; if `/ids/validate` hits a gap in `@ifc-lite/ids`, only
   that module moves.

4. **Ship the WebGL fallback from day one.** IFC-lite's renderer is WebGPU-first.
   Feature-detect and warn; never require WebGPU.

5. **Re-run the spike on any major version of either engine**, and paste the new
   table into this file. The decision is only as good as its data.

6. **The spike models are synthetic.** Before Phase 2 ships, re-run against a
   real 100 MB+ vendor export (Revit and an infrastructure authoring tool) and
   record whether the ratios hold. Uniform synthetic geometry is exactly the
   case a columnar parser is best at.

## Revisit if

- IFC-lite's release cadence stalls, or a security/maintenance issue appears in
  a package with no alternative.
- `@ifc-lite/ids` fails a meaningful share of the buildingSMART IDS test suite
  where `@thatopen/components` passes.
- A real vendor model shows the parse-time gap widening beyond ~3× without a
  corresponding property-access win.

## 2026-10-12 — IFC4x3 alignment geometry update

The ACCA **Viadotto Acerno** model exposed an engine-version gap: the installed
geometry 4.1.0 / WASM 6.1.1 parsed the file successfully but omitted all 638
`IfcSectionedSolidHorizontal` items and ignored gradient elevation for linear
placements. Only 18 of 590 beams rendered, with misplaced parts below terrain.
This is the exact model covered by upstream
[issue 5327](https://github.com/LTplus-AG/ifc-lite/issues/5327) and
[fix 6066](https://github.com/LTplus-AG/ifc-lite/pull/6066).

All 13 direct IFC-lite dependencies are now updated to the latest published
versions checked on 2026-10-12:

| Package | Version |
|---|---|
| bcf | 5.0.1 |
| data | 6.2.0 |
| encoding | 2.3.0 |
| export | 4.9.0 |
| geometry | 7.7.0 |
| ids | 3.2.0 |
| mutations | 3.2.0 |
| parser | 9.2.0 |
| pointcloud | 0.12.0 |
| query | 2.5.2 |
| renderer | 6.0.1 |
| spatial | 1.15.0 |
| wasm | 10.4.0 |

Parser and geometry now share WASM 10.4.0 instead of loading separate engine
versions. IDS pins its own data 6.1.0 dependency upstream; that pin is preserved.
The adapter now reads classification system names from `{ names, unresolved }`
and selects the validated model from IDS's `modelInfo` array. The app's public
adapter contract, local-only processing and three.js renderer remain unchanged.

Verified on the local 31.5 MiB, 253,318-entity file: all 590 beams, 41 slabs,
38 courses, 2 pavements and 152 bearings produce geometry. Beams and bearings
are at deck elevation (40–60 m), and the browser renders 6,549 unique entities
instead of 5,908. Counts include the three newly supported alignments.

`alignment-bridge-ifc4x3.ifc` is a small, authored regression fixture: a sectioned
girder and a linearly placed bearing on a gradient curve at 50 m. The previous
bridge fixture tested IFC4x3 attributes but had no solid representation, so it
could not catch this defect. `alignment-geometry.test.ts` checks geometry and
elevation; the viewer browser test checks both entities reach the renderer.
The full vendor file remains outside the repository. To exercise it locally:

```sh
ACERNO_IFC='/path/to/Viadotto Acerno.ifc' npm test -- lib/ifc/__tests__/alignment-geometry.test.ts
```

Re-ran the existing engine spike on the two small fixtures, the 20/200 MiB
synthetic models and this vendor model (Apple Silicon, Node 24.19.0;
parser 9.2.0, web-ifc 0.0.77):

| engine | file | size MiB | parse ms | entities | props ms (2,000 walls) | psets | CRS |
|---|---|--:|--:|--:|--:|--:|---|
| ifc-lite | georeferenced-wall-ifc4.ifc | 0 | 20 | 63 | 1 | 2 | EPSG:3763 |
| web-ifc | georeferenced-wall-ifc4.ifc | 0 | 20 | 63 | 3 | 2 | EPSG:3763 |
| ifc-lite | bridge-ifc4x3.ifc | 0 | 4 | 38 | 0 | 0 | EPSG:3763 |
| web-ifc | bridge-ifc4x3.ifc | 0 | 9 | 38 | 0 | 0 | EPSG:3763 |
| ifc-lite | synthetic 20 MiB | 20 | 554 | 337,832 | 9 | 700 | EPSG:3763 |
| web-ifc | synthetic 20 MiB | 20 | 310 | 337,832 | 127 | 700 | EPSG:3763 |
| ifc-lite | synthetic 200 MiB | 200.1 | 7,315 | 3,256,202 | 13 | 700 | EPSG:3763 |
| web-ifc | synthetic 200 MiB | 200.1 | 3,489 | 3,256,202 | 1,194 | 700 | EPSG:3763 |
| ifc-lite | Viadotto Acerno.ifc | 31.5 | 726 | 253,318 | 0 | 0 | EPSG:32633 |
| web-ifc | Viadotto Acerno.ifc | 31.5 | 354 | 253,318 | 15 | 0 | EPSG:32633 |

These are single-run observations collected alongside browser checks, not a
controlled performance comparison with the September baseline. RSS deltas are
omitted here: GC during sequential measurements even produced a negative delta
for one run, so they cannot establish peak memory. Both engines still parse the
200 MiB fixture and preserve georeferencing; the decision remains unchanged.
