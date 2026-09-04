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
