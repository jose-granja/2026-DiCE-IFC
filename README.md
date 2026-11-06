# DiCE-IFC

A browser-based BIM toolkit: a federated IFC viewer with quantity take-off, clash
detection, IDS checking, BCF issue management and georeferencing, an IDS editor,
and qualified digital signatures with the Portuguese **Cartão de Cidadão**.

**Source:** <https://github.com/jose-granja/2026-DiCE-IFC> · **Licence:** [MIT](LICENSE)

> **Every byte of model, issue and specification data is processed in the browser.**
> No IFC, BCF or IDS file is ever uploaded: there are no accounts, no database and
> no API that receives your data. See `/privacy` in the running app, and
> [`frontend/AGENTS.md`](frontend/AGENTS.md) §1 for the rules the code follows.

The interface is in Portuguese (the default) and English.

## What it does

### Viewer — `/viewer`

Open IFC files (drop them, or "Add models") and they are parsed in web workers,
federated by their `IfcMapConversion`, and shown in 3D. The left-hand tool tabs:

| Tab | What it is for |
|---|---|
| **Models** | The open models, their alignment, and the point clouds |
| **Spatial structure** | The project → site → building → storey tree, with hide/isolate/select |
| **Filters** | Select, isolate or colour elements by class, type, material, classification or property |
| **Lens** | Saved ways of looking at the model: colour, ghost or hide by rules, or auto-colour by any property. Lens lists can be downloaded and uploaded |
| **Quantity query (QTO)** | A bill of quantities: hierarchical lines with filters and formulas, run against the models. Imports and exports Excel; a default MQT template is included |
| **Georeferencing** | LoGeoRef grading, placement editing, control-point fitting, corrected-IFC export |
| **GIS context** | 3D globe (Cesium ion): terrain, a Google road map or satellite imagery, OSM or Google 3D buildings, your own 3D tiles; CityJSON / GeoJSON / CityGML / GeoPackage context, WFS and WMS layers |
| **Section planes** | Any number of planes, each flippable and toggleable |
| **Measurements** | Point-to-point distance with plan and vertical components, snapped to corners |
| **IDS verification** | Check the models against an IDS file; jump from a failure to the element; export the failures as BCF |
| **Clash detection** | A Solibri-style matrix: groups by filter, tolerances per cell, models classified by discipline, Excel import/export, results to BCF |
| **BCF topics** | Read, edit, merge and export BCF 2.1/3.0 issue sets; viewpoints with annotated snapshots or pictures from your computer; 3D markers; a PDF report of all or the selected topics |

**Realistic materials** (Display → Realistic materials) puts textures on the
models. For each material, the browser finds the kind (concrete, brick,
timber…) from its name. It then picks the texture of that kind nearest the
material's colour, from Poly Haven or 360into, whichever is closer, and
projects it onto the geometry with relief and roughness: Poly Haven's own
normal and roughness maps, or, for 360into's photographs, both estimated from
the photograph. It is off until switched on, and nothing about the model is
sent (ADR 014).

The **Properties** panel on the right shows the selected element's attributes,
materials, property sets, quantities, its type's attributes and properties, classifications, and
what the loaded IDS requires of it.

**Point clouds** (`.las .laz .ply .pcd .e57 .pts .xyz`) open alongside the models.

**Projects.** "Project" in the viewer header saves the whole session to a folder
on your disk (or a `.zip` in browsers without folder access): the models, point
clouds, context files, IDS and BCF files, the quantity list and clash matrix as
Excel workbooks, the lenses, and a `project.json`. Loading the folder brings the
session back. "Save" keeps the same project in the browser's own storage.

### IDS editor — `/ids/create`

Author IDS 1.0 specifications with all six facets and value restrictions.
Values autocomplete from a loaded model and from the buildingSMART Data
Dictionary (bSDD), and the file is validated against the official XSD in the
browser before download. A PDF report of the specification can be downloaded.

### Digital signatures — `/sign/*`

| Route | |
|---|---|
| `/sign/ifc` | Sign IFC models (ASiC-E container with XAdES) |
| `/sign/ifc-embedded` | Sign an IFC with the signature embedded in the file |
| `/sign/bcf` | Sign BCF issue sets |
| `/sign/verify` | Verify a signed container, offline |
| `/sign/setup` | What must be installed to sign |

Signing uses the physical **Cartão de Cidadão** through the small local
**signing companion** in [`companion/`](companion/README.md), which only ever
sees the signature's own `SignedInfo`, never the files. The card's middleware
asks for the PIN; the app never sees it. Signatures can carry a qualified
time-stamp (XAdES-B-T) when the deployment configures a time-stamping authority.

Old links to `/georef`, `/bcf` and `/ids/validate` redirect to the matching
viewer panel.

## Supported formats

| | |
|---|---|
| Models | IFC 4.0 (`IFC4`) and IFC 4.3 (`IFC4X3_ADD2`) |
| Issues | BCF 2.1 and 3.0 (written as 3.0) |
| Specifications | IDS 1.0 |
| Point clouds | LAS, LAZ, PLY, PCD, E57, PTS, XYZ |
| Context | CityJSON, GeoJSON, CityGML/GML, GeoPackage, WFS, WMS |
| Spreadsheets | Excel `.xlsx` for quantity lists and clash matrices |

## What does reach the network

Only what the user switches on, and never model, issue or specification content:
basemap tiles and 3D tiles from the configured provider, Poly Haven and
360into textures for realistic materials, WFS/WMS services the user adds, bSDD lookups (through the app's own `/api/bsdd` proxy), and signature
time-stamps (through `/api/tsa`). A deployment can also put a **human check**
(Cloudflare Turnstile) in front of the site to keep bots out: visitors pass it
once and get a pass cookie for a day (ADR 013). The full list, with what each request
carries, is in [`frontend/AGENTS.md`](frontend/AGENTS.md) §1 and on `/privacy`.

## Repository layout

```
frontend/   Next.js 16 + React 19 + Tailwind 4 app      ← read AGENTS.md first
companion/  Local signing service for the Cartão de Cidadão (Python)
docs/adr/   Architecture decision records               ← index in docs/adr/README.md
nginx/      Reverse proxy for production
```

There is no backend. The front end's own server serves the pages and three
small same-origin proxies: `app/api/bsdd` (dictionary lookups), `app/api/ogc`
(WFS/WMS) and `app/api/tsa` (time-stamps).

## Getting started

Requires **Node 24 and npm 11** (see the note under Docker).

```bash
cd frontend
npm install
npm run dev          # http://localhost:3000
```

Checks:

```bash
npm run typecheck
npm run lint         # includes the no-payload-uploads privacy rule
npm test             # Vitest: the lib/ engines, readers and writers
npm run test:e2e     # Playwright, against a production build
```

The end-to-end tests build and serve the app on port 3000; set
`PLAYWRIGHT_PORT` to use another one (for example when the Docker dev stack
already holds 3000).

### Configuration

Deployment settings are environment variables — see
[`stack.env.example`](stack.env.example) (production) and
[`.env.dev.example`](.env.dev.example) (development). The main ones:

| Variable | |
|---|---|
| `NEXT_PUBLIC_MAP_STYLE_URL`, `NEXT_PUBLIC_TILE_ORIGIN` | The basemap style and the origin the CSP allows for it |
| `NEXT_PUBLIC_CESIUM_ION_TOKEN`, `NEXT_PUBLIC_CESIUM_ION_ASSET_ID` | Optional Cesium ion: terrain, 3D tiles, and the Google Maps 2D road map or satellite under the model |
| `NEXT_PUBLIC_OPERATOR_NAME`, `NEXT_PUBLIC_OPERATOR_CONTACT` | Who runs the deployment, shown on About and Privacy |
| `NEXT_PUBLIC_SOURCE_URL` | The source link on About; defaults to this repository |
| `TSA_URL`, `TSA_USERNAME`, `TSA_PASSWORD`, `TSA_NAME` | The time-stamping authority (server-side only) |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_PASS_HOURS` | The human check in front of the site (Cloudflare Turnstile); off when the keys are empty. Runtime settings |

`NEXT_PUBLIC_*` values are inlined **at build time**: each needs an `ARG`/`ENV`
pair in `frontend/Dockerfile.prod` and an entry under `build.args` in
`docker-compose.yml`.

## Docker

```bash
docker compose -f docker-compose_dev.yml up     # dev server on http://localhost:3000
docker compose up                               # production: front end behind nginx, port 9881
```

`frontend/Dockerfile.prod` builds the production image and `frontend/Dockerfile`
serves `docker-compose_dev.yml`. To offer the signing companion for download,
run `npm run copy:companion` in `frontend/` before building the image (the
build context is only `frontend/`).

**Why Node 24 / npm 11.** `@swc/core` (via `next-intl`) declares `@swc/helpers`
as an *optional peer*: npm 11 leaves it out of the lockfile, npm 10 insists it be
there, so `npm ci` under npm 10 rejects a lock written by npm 11. Both frontend
images are on `node:24-bookworm-slim`. If `npm ci` fails with
`Missing: @swc/helpers@… from lock file`, that mismatch is why.

The production image uses Next's standalone output, opt-in via
`BUILD_STANDALONE=1` — it disables `next start`, so enabling it globally would
break local `npm start` and the Playwright web server.

> Running the dev stack and a local `npm run typecheck` at the same time makes
> tsc read half-written files: the container's `next dev` writes into the
> bind-mounted `.next/dev`. Stop the frontend container, or run the local
> tooling on its own.

nginx must not set its own `Content-Security-Policy`: `proxy.ts` mints one per
request with a nonce, and two CSP headers are enforced as their intersection —
the app then renders but never hydrates, only behind nginx.

## Documentation

- [`frontend/AGENTS.md`](frontend/AGENTS.md) — conventions, the privacy rules,
  and the design notes and pitfalls of each module. Read before changing code.
- [`docs/adr/`](docs/adr/README.md) — architecture decisions: the IFC engine,
  the signature container, map tiles, the signing companion, BCF, canonical
  XML, bSDD, context formats, embedded signatures and time-stamps.
- [`companion/README.md`](companion/README.md) — the signing companion, its
  endpoints and its installers.

The phase-by-phase build log that used to live here is in the git history.

## History

The project used to have a Django API (accounts, project metadata, an RFC 3161
time-stamp proxy). Nothing in the front end called any of it except the sign-in
flow, so it was removed together with postgres, redis, celery and flower; it is
in the git history if it is ever needed. `stack.env` and `docker-compose.yml`
once carried a database password, an SMTP password and a Flower password; they
are gone from the files but **still in history** — rotate them if they were ever
real.

## Licence

DiCE-IFC is released under the [MIT licence](LICENSE). Third-party components
and data keep their own licences; the credits are on the app's `/about` page and
the full notices in `/third-party-licenses.txt`.
