# DiCE-IFC

A browser-based BIM toolkit: IFC viewing and federation, georeferencing, IDS
authoring and validation, BCF management, and qualified digital signature with
the Portuguese **Cartão de Cidadão**.

**Every byte of model, issue and specification data is processed in the browser.**
No IFC, BCF or IDS payload is ever uploaded. See [`frontend/AGENTS.md`](frontend/AGENTS.md) §1
for the rules, and `/privacy` in the running app for the user-facing statement.

## Modules

| # | Module | Route | Phase |
|---|--------|-------|-------|
| 1 | IFC viewer + federation | `/viewer` | 2 |
| 2 | Digital signature of IFC | `/sign/ifc` | 3 |
| 3 | Georeferencing validation + map placement | `/georef` | 4 |
| 4 | IDS authoring | `/ids/create` | 5 |
| 5 | IDS → IFC validation + BCF export | `/ids/validate` | 6 |
| 6 | BCF viewer / manager | `/bcf` | 7 |
| 7 | Digital signature of BCF | `/sign/bcf` | 3 |

Supported schemas: IFC 4.0 (`IFC4`), IFC 4.3 (`IFC4X3_ADD2`), BCF 3.0, IDS 1.0.

## Layout

```
frontend/   Next.js 16 + React 19 + Tailwind 4        ← read AGENTS.md first
companion/  Local signing service for the Cartão de Cidadão (Python)
docs/adr/   Architecture decision records             ← read 001 and 004 first
nginx/      Reverse proxy and COOP/COEP headers (production only)

There is no backend: no accounts, no database, no API server. The front end's own
server serves the pages and proxies the bSDD dictionary (`app/api/bsdd`).
```

## Getting started

```bash
# Frontend
cd frontend
npm install
npm run dev          # http://localhost:3000

npm run typecheck
npm run lint         # includes the no-payload-uploads privacy rule
npm test             # Vitest: lib/ engines + the lint rule
npm run test:e2e     # Playwright: privacy headers and module flows
```

Production: `docker compose up` (see `docker-compose.yml`, `stack.env`).

## Phase 5 status — complete

`/ids/create` authors IDS 1.0 specifications, validates them against the real
buildingSMART schema in the browser, and downloads a `.ids` file.

- `lib/ids/types.ts` — the IDS 1.0 model, mirroring the vendored XSD. Two
  schema rules are encoded in the types rather than left to the serialiser,
  because both are easy to get wrong and invisible when you do: `<info>`
  children and facets are `xs:sequence`s so their **order is fixed**, and
  **cardinality differs by facet** (entity and partOf use `simpleCardinality`,
  which has no `optional`).
- `lib/ids/serialize.ts` — the XML writer. This is the half no library
  provides: parsers and validators exist, authors do not.
- `lib/ids/parse.ts` — the reader. **Tolerant in, strict out**: files in the
  wild carry `cardinality="Required"` and unrecognised relations, so import
  normalises what it can and *reports every change*, and export then emits a
  schema-valid file. Round-tripping is byte-exact.
- `lib/ids/validate.ts` — authoring checks that run continuously, plus libxml2
  (WebAssembly) against the vendored XSD on demand. The schemas are inlined and
  their imports repointed at siblings, so validation needs **no network at
  all** — asserted by an e2e test.
- `/ids/create` — master/detail with dnd-kit reorderable specifications
  (keyboard-operable), an editor for all six facets, the `xs:restriction`
  editor, live XML, and OPFS drafts.

**Autocomplete from a loaded model** is the thing the reference web app cannot
do: `getVocabulary` returns the classes, property sets, property names,
classification systems and materials the model actually contains. A
specification written against a mistyped `Pset` name reports every element as
failing, and that mistake is invisible until someone runs the validation.

### A bug only the browser could find

The production **minifier mis-folded a concatenation of template literals** in
the XML writer and silently dropped both `xmlns` declarations, emitting
`...buildingsmart.org/IDSxsi:schemaLocation=` — malformed XML, in the production
bundle only. Vitest never sees it because it does not minify. The root element
is now built by joining an array, and `e2e/ids-create.spec.ts` asserts the
*built* output parses.

That episode also exposed a test-harness fault: Playwright's
`reuseExistingServer` was silently testing whatever sat on port 3000 — a stale
build, or the Docker dev container serving different code under a different CSP.
It is now `false`.

## Phase 4 status — complete

`/georef` grades a model's georeferencing, places it on a map, fits a placement
from surveyed control points, and writes a corrected IFC.

- `lib/georef/logeoref.ts` — LoGeoRef 0–50 grading. Levels are graded
  **independently**, because they are not strictly nested in practice: a file
  can carry a full `IfcMapConversion` and no `IfcSite` latitude, and grading by
  nesting would report 0 for a model that is perfectly placeable. Every failing
  check carries a remedy.
- `config/epsg.ts` — bundled CRS registry with proj4 definitions, Portuguese
  systems first (PT-TM06, Datum 73, both Lisbon grids, Azores and Madeira
  zones). Bundled rather than fetched: a lookup must work offline, and asking a
  remote registry which CRS a model is in would leak roughly where the project
  is — the one inference the privacy line exists to prevent.
- `lib/georef/transform.ts` — model ↔ map ↔ WGS84, unit-aware throughout.
- `lib/georef/fit.ts` — control-point fitting. **The brief asked for
  Levenberg–Marquardt; there are two solvers.** The unconstrained similarity
  transform has an exact closed form (Umeyama), which needs no initial guess and
  cannot fail to converge, so iterating for it would be strictly worse. LM is a
  real implementation with an analytic Jacobian, used when the user *pins* a
  parameter ("scale is exactly 1", "the surveyor gave me this rotation"), seeded
  from the closed form. Both report per-point residuals.
- `lib/georef/footprint.ts` — convex hull in plan, reprojected to WGS84 GeoJSON.
  A hull is generous around a courtyard building, so the UI labels it as one.
- `/georef` — LoGeoRef report, live-updating placement editor with a searchable
  CRS picker, MapLibre footprint, control-point table with residuals and
  parameter locks, before/after diff, and a corrected-IFC export.

New form controls, per §3 of the brief: `FormSelectEPSG` and
`FormCoordinateInput`, both registered in the TanStack Form registry.

**Two deliberate deviations, both stated rather than silent:**

1. **The closed-form solver above.** LM is present and used where it earns its
   place, but is not the default for a problem with an exact solution.
2. **The basemap is optional.** ADR 003 makes self-hosted Protomaps the default,
   which means a per-deployment PMTiles extract that does not exist yet. Rather
   than ship a dead panel, the map works without tiles: footprint, scale bar,
   pan and zoom on a plain background, with a note naming the env var. Set
   `NEXT_PUBLIC_MAP_STYLE_URL` to add the basemap.

**Not done in this module:** the 3D mode (MapLibre terrain, IFC mesh via a
three.js custom layer, optional OGC 3D Tiles). The 2D footprint answers "is this
model in the right place", which is what the write-back needs.

One behavioural change this phase forced: **models now survive navigating
between modules.** `/viewer` used to unload everything on unmount, which would
have made `/georef` — and Phases 6 and 7, which jump from an IDS failure or a
BCF viewpoint back into the viewer — impossible. Closing a model is now an
explicit action.

## Phase 2 status — complete

The federated viewer works end to end: drop IFC files, they parse in a worker
pool, tessellate, render, and align by their `IfcMapConversion`.

- `lib/viewer/federation.ts` — the coordinate arithmetic, pure and tested
  (22 tests). The IFC→render axis mapping was **measured against the engine**,
  not assumed: `render = (x, z, −y)`.
- `lib/viewer/store.ts` — models, selection, visibility, isolation and colouring,
  keyed by `(modelId, expressId)` so a federation is unambiguous. Shared with
  the IDS validator and BCF manager in later phases.
- `lib/viewer/batching.ts` — merges meshes into large buffers with a per-vertex
  express id, so 300 000 elements are a handful of draw calls rather than
  300 000. Tested independently of three.js.
- `lib/viewer/renderer.ts` — three.js/**WebGL**, per ADR 001. WebGPU is detected
  and reported, never required.
- `lib/viewer/workspace.ts` — saves file handles (never file contents) so a
  reload restores the session.
- `lib/viewer/tools.ts` — section-plane and measurement arithmetic, pure and
  tested (23 tests).
- `/viewer` — model list with per-model alignment confidence, federated spatial
  tree (the canvas's keyboard-accessible equivalent), property inspector, IFC
  class filter, hide/isolate, **section planes** (any number, intersecting,
  each flippable and toggleable) and **measurement** (click two points, snapped
  to nearby corners, with distance plus plan and vertical components).

Six bugs worth recording, all found by running the thing rather than reading it:

1. **The CSP had no nonce**, so Next's inline bootstrap scripts were blocked and
   the app never hydrated — while still server-rendering correctly, so it looked
   fine. Now handled by `proxy.ts`.
2. **Transferring engine-owned buffers across the worker boundary** detached the
   WASM heap and killed the worker mid-call. The symptom was a promise that never
   settled, not an error. `ifc.worker.ts` copies first.
3. **An effect that cancelled its own work**: claiming a model changed `models`,
   which re-ran the effect, whose cleanup cancelled the fetch it had just
   started. Geometry arrived and was silently discarded.
4. **`pick()` returned the first model with a hit, not the nearest**, so in a
   federation you selected an occluded element from whichever model loaded
   first. It also ignored the section planes, letting you select and measure
   surfaces that had been sliced away.
5. **An infinite render loop** (React #185): `federationBounds()` builds a fresh
   object per call, so using it directly as a zustand selector compared unequal
   every render.
6. **A hydration mismatch** from branching an icon on `typeof window`. It was
   invisible because the test that would have caught it attached its console
   listener *after* navigating — so it never saw the initial load. Both are
   fixed.

Two accessibility fixes fell out of this: the ported `Slider` put `aria-label`
on its root rather than on the element carrying `role="slider"`, leaving the
actual widget unnamed and its disabled state unannounced; and the spatial tree
now sets `aria-selected` on every `treeitem`.

## Phase 1 status — complete

- `frontend/AGENTS.md` — Next 16 conventions verified against the bundled docs,
  plus the privacy-line rules and PR checklist.
- `components/ui/` and `components/form/` ported; TanStack Form + Zod registry.
- **Engine spike run and recorded** — [ADR 001](docs/adr/001-ifc-engine.md).
  Both IFC-lite and web-ifc parse a 200 MB IFC4; the decision rests on coverage
  and on property-access cost, with the numbers in the ADR.
- `lib/ifc/adapter.ts` + a 23-assertion conformance suite that imports no engine.
- Comlink worker pool, OPFS store.
- **Card companion spike run and recorded** — [ADR 004](docs/adr/004-card-signing-companion.md).
  Q1 resolved: Web eID cannot be configured for `pteidpkcs11` and needs a small
  fork. `lib/signing/provider.ts` with a working `mock` implementation.

Next: **Phase 7 (BCF manager)**. Phase 6 (IDS validation and BCF export) needs
Phases 2, 5 and 7; Phase 3 (signing) needs Phase 6's output.

## Useful commands

```bash
npm run spike:ifc fixtures/ifc/*.ifc /tmp/synth-200mb.ifc   # re-run the engine spike
npm run fixtures:large 200 /tmp/synth-200mb.ifc             # generate a load-test model
```

## Docker

```bash
docker compose -f docker-compose_dev.yml up     # dev server on http://localhost:3000
docker compose up                               # production: front end behind nginx, port 9880
```

`frontend/Dockerfile.prod` builds the production image and `frontend/Dockerfile`
serves `docker-compose_dev.yml`. Two services, no database. To offer the signing
companion for download, run `npm run copy:companion` in `frontend/` on the host
before building the image (the build context is only `frontend/`).

**Node 24 / npm 11 is required, in dev and in Docker.** `@swc/core` (via
`next-intl`) declares `@swc/helpers` as an *optional peer*: npm 11 leaves it out
of the lockfile, npm 10 insists it be there, so `npm ci` under npm 10 rejects a
lock written by npm 11. `engines` in `frontend/package.json` states this, and
both frontend images are on `node:24-bookworm-slim`. If `npm ci` ever fails with
`Missing: @swc/helpers@… from lock file`, that mismatch is why.

The frontend production image uses Next's standalone output, which is opt-in via
`BUILD_STANDALONE=1` — it disables `next start`, so enabling it globally would
break local `npm start` and the Playwright web server.

> Running the dev stack and local `npm run typecheck` at the same time makes tsc
> read half-written files: the container's `next dev` writes into the
> bind-mounted `.next/dev`. Stop the frontend container, or run the local
> tooling on its own.

### Fixed in the inherited compose files

- `nginx` set its own `Content-Security-Policy` on top of the one `proxy.ts`
  mints per request. Two CSP headers are enforced as their **intersection**, so
  the nonce-less copy blocked Next's inline scripts and the app rendered but
  never hydrated *only when accessed through nginx*. nginx no longer sets one.

## History

The project used to have a Django API (accounts, project metadata, an RFC 3161
timestamp proxy). Nothing in the front end called any of it except the sign-in
flow, so it was removed together with postgres, redis, celery and flower. It is in
the git history if it is ever needed. `stack.env` and `docker-compose.yml` once
carried a database password, an SMTP password and a Flower password; they are
gone from the files but **still in history** — rotate them if they were ever
real.
