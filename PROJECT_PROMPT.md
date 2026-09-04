# DiCE-IFC — Build Prompt & Implementation Plan

> Hand this file to Claude Code as the master brief. Each phase is independently
> executable; `## Phase N` headings are the unit of work.

---

## 0. What we are building

A browser-based BIM toolkit with seven modules:

| # | Module | Route |
|---|--------|-------|
| 1 | IFC viewer + federation of multiple models | `/viewer` |
| 2 | Digital signature of IFC (single + bulk) → signed `.ifczip` | `/sign/ifc` |
| 3 | Georeferencing validation + world-map placement | `/georef` |
| 4 | IDS authoring | `/ids/create` |
| 5 | IDS → IFC validation, graphical report + BCF export | `/ids/validate` |
| 6 | BCF viewer / manager | `/bcf` |
| 7 | Digital signature of BCF (single + bulk) → signed `.bcfzip` | `/sign/bcf` |

**Supported schemas:** IFC 4.0 (`IFC4`), IFC 4.3 (`IFC4X3_ADD2`), BCF 3.0, IDS 1.0.

**Hard constraint:** every byte of model/issue/specification data is processed
**in the browser**. No IFC, BCF, or IDS payload is ever uploaded. See §2.

**Signing device:** the physical **Cartão de Cidadão** only — card reader,
Autenticação.gov middleware, signature PIN, and a local browser companion.
Chave Móvel Digital is explicitly out of scope. See Phase 3.

---

## 1. Existing repo — what is already here

```
/Users/josegranja/dev-code/2026-DiCE-IFC
├── api/                 Django + DRF + Celery ("dicecde" project)
│   ├── core/            custom email-based User, auth.py, emails.py  ← keep
│   ├── cde/             placeholder app (MyModel) — replace with real models
│   └── dicecde/         settings, celery, urls
├── frontend/            bare Next.js 16.2 + React 19.2 + Tailwind 4 scaffold
│   ├── AGENTS.md        ⚠️ read this first
│   └── app/             layout.tsx, page.tsx only
├── nginx/  docker-compose.yml  docker-compose_dev.yml  stack.env
```

⚠️ **`frontend/AGENTS.md` says Next.js 16 has breaking changes vs. training data.
Before writing any Next.js code, read the relevant guide in
`frontend/node_modules/next/dist/docs/`.** Do not assume Next 15 conventions.

The reference project is
`/Users/josegranja/dev-code/2025-applications/Untitled/bimaplus-applications-backend`.
Mirror its structure and form system (§3), not its data flow.

---

## 2. Architecture — the privacy line

```
┌─────────────────────────── BROWSER (all model data lives here) ───────────────────────────┐
│                                                                                            │
│  File System Access API / drag-drop                                                        │
│        ↓                                                                                   │
│  Web Worker pool ── @ifc-lite/parser (Rust→WASM) ── columnar store                         │
│        ↓                                                                                   │
│  OPFS (Origin Private File System) ─ session cache of parsed models, IDS drafts, BCF        │
│        ↓                                                                                   │
│  WebGPU renderer / MapLibre / IDS engine / BCF writer / SHA-256 (WebCrypto)                 │
│  XAdES builder + fflate zipper (signature containers assembled here)                        │
│        ↕  native messaging (never the network)                                              │
│  browser extension → native host → PKCS#11 (pteid) → Cartão de Cidadão                     │
│                                                                                            │
└──────────────────────────────────────┬─────────────────────────────────────────────────────┘
                                       │  ONLY these cross the wire:
                                       │  • auth JWT (existing core app)
                                       │  • project/user metadata (cde app)
                                       │  • RFC 3161 timestamp requests (a hash) + OCSP/CRL/TSL
                                       ▼
┌────────────────────────────── DJANGO API (never sees a model) ─────────────────────────────┐
│  core/   auth, users            cde/   projects, membership, audit log of signatures        │
│  trust/  ← NEW: CORS proxy for the TSA, OCSP/CRL and the EU/PT trusted lists. Caches only.  │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

The signing key never leaves the citizen's card, the document never leaves the
browser, and the digest never leaves the machine. The only signing-related
traffic is an RFC 3161 timestamp request and public revocation data — see
Phase 3.

**Enforcement rules — encode these in `frontend/AGENTS.md`:**
- No `fetch`/`axios` call may carry a `File`, `ArrayBuffer`, or `Blob` of user
  content. Add an ESLint rule + a code-review checklist item.
- Every IFC/BCF/IDS page is a Client Component. No Server Actions touch payloads.
- CSP must forbid third-party origins other than the map tile provider.
- Add a visible "Processed locally — nothing uploaded" badge on each module,
  and a `/privacy` page explaining exactly what leaves the device.

---

## 3. Frontend stack — copy from the reference project

Match the reference `web/package.json` and `src/` layout:

```
frontend/
├── app/                        route groups mirroring the reference
│   ├── (auth)/                 sign-in, sign-up, forgot/reset password
│   ├── (home)/
│   ├── viewer/       _components/
│   ├── georef/       _components/
│   ├── ids/create/   ids/validate/
│   ├── bcf/
│   ├── sign/ifc/     sign/bcf/
│   └── provider.tsx            AuthProvider + QueryClientProvider + FormSchema ctx
├── components/
│   ├── ui/                     shadcn/radix primitives — copy the reference set
│   ├── form/                   ← copy wholesale, then extend (below)
│   ├── viewer/  map/  ids/  bcf/  signing/
├── lib/
│   ├── ifc/  ids/  bcf/  georef/  signing/    ← all client-side engines
│   ├── validators/             Zod schemas
│   └── workers/                Comlink-wrapped Web Workers
└── config/                     enums, constants, EPSG list
```

**Dependencies to add:**
`@tanstack/react-form`, `@tanstack/react-query`, `zod`, `zustand`, `radix-ui`,
`lucide-react`, `sonner`, `next-themes`, `class-variance-authority`, `clsx`,
`tailwind-merge`, `cmdk`, `vaul`, `@dnd-kit/*` (IDS facet reordering),
`recharts` (validation dashboards), `comlink`, `fflate` (zip), `proj4`,
`maplibre-gl`, `three`, `@ifc-lite/*`.

### Form system — reuse verbatim

The reference uses a **TanStack Form `createFormHook` registry** driven by Zod.
Copy `components/form/` and `components/ui/field.tsx` as-is. The contract:

- `hooks.ts` — `createFormHook({ fieldComponents: { Input, Select, ... } })`
  exporting `useAppForm`, `useFieldContext`, `useFormContext`.
- `FormBase.tsx` — wraps every control: label, description, error, and derives
  `required` from the Zod schema via `fieldSchema.isOptional() === false`.
- Each control (`FormInput`, `FormSelect`, …) pulls `useFieldContext()` and
  `useFormSchema(field.name)`, deriving `minLength`/`maxLength` from Zod.
- Validators live in `lib/validators/*-validators.ts`; enums in `config/`.

**New field components to add for this app:**
`FormSelectEPSG` (searchable CRS picker, cmdk), `FormSelectIfcEntity`
(IFC4/IFC4X3 entity list), `FormSelectPropertySet`, `FormRestriction`
(XSD restriction editor: enumeration / pattern / bounds / length),
`FormCardinality` (required / optional / prohibited),
`FormCoordinateInput` (E/N/H with unit awareness).

---

## 4. Library decision: IFC-lite vs. That Open

**Chosen: IFC-lite (`@ifc-lite/*`) as the primary engine, behind an adapter.**

| | IFC-lite | That Open Engine |
|---|---|---|
| License | MPL-2.0 | MIT |
| Parser | Rust→WASM, IFC2x3/4/4X3/IFC5, ~260 KB gz | web-ifc (C++→WASM), IFC2x3→IFC4x3 Add2 |
| Render | WebGPU native + three.js/Babylon WebGL fallback | three.js, Fragments binary format |
| Federation | yes (multi-model coordinated selection) | yes |
| IDS | `@ifc-lite/ids` (validation) | `@thatopen/components` IDS |
| BCF | `@ifc-lite/bcf` | `BCFTopics` component |
| Maturity | young, fast-moving | mature, large community |
| Georef | ✗ neither ships it — we build it |

**Rationale:** IFC-lite covers modules 1, 5, and 6 out of a single dependency
with no intermediate conversion step (That Open requires an IFC→Fragments
pass, which is fine but adds a pipeline). Its columnar store also makes the
IDS validator and the georeferencing entity edits much cheaper.

**Risk & mitigation:** IFC-lite is new and WebGPU-first. Therefore:
1. Put every engine call behind `lib/ifc/adapter.ts` — a narrow interface
   (`loadModel`, `getEntities`, `getProperties`, `getSpatialTree`,
   `setEntityAttribute`, `exportStep`). **No page imports `@ifc-lite/*`
   directly.**
2. Write an adapter conformance test suite. If a gap appears in a module,
   a That Open implementation of the same interface can be dropped in for
   that module only.
3. Ship the three.js/WebGL fallback path from day one — do not require WebGPU.
   Feature-detect and warn.

**Do a Phase 1 spike before committing:** load a 200 MB IFC4 and an IFC4X3
infrastructure model in both libraries; measure parse time, memory, and
whether `IfcMapConversion` / `IfcProjectedCRS` round-trip intact. Record the
result in `docs/adr/001-ifc-engine.md`. If IFC-lite fails the spike, switch —
the adapter makes that a contained change.

---

## 5. Module specifications

### Phase 1 — Foundation
- Read `frontend/node_modules/next/dist/docs/`. Write `frontend/AGENTS.md`
  rules for Next 16 + the privacy constraints from §2.
- Port `components/ui/` and `components/form/` from the reference.
- Auth against the existing Django `core` app (JWT, `provider.tsx` pattern).
- Replace `cde/models.py` `MyModel` with real models: `Project`,
  `ProjectMembership`, `SignatureAudit` (see Phase 3).
- `lib/ifc/adapter.ts` + the engine spike + ADR.
- Worker pool with Comlink; OPFS store (`lib/storage/opfs.ts`).

### Phase 2 — Viewer & federation (`/viewer`)
- Drag-drop or File System Access API multi-file load; parse in workers with
  per-file progress.
- **Federation:** each model gets an id, colour, visibility toggle, and an
  optional placement transform. Merge spatial trees into one federated tree
  grouped by model. Coordinate on a shared world origin — derive it from
  `IfcMapConversion` when present (see Phase 4), otherwise from the first
  model's `IfcSite` placement, and expose a manual offset override.
- Panels: spatial tree, property/Pset inspector, entity/class filter,
  section planes, measurement, isolate/hide, model list.
- Selection is synchronised across federated models.
- Persist a "workspace" (file handles + transforms + camera) to OPFS so a
  reload restores the session without re-picking files.

### Phase 3 — Digital signature (`/sign/ifc`, `/sign/bcf`)

**Read this section carefully — the naive design is not achievable.**

**Scope decision: the physical Cartão de Cidadão is the only accepted signing
device. Chave Móvel Digital is out of scope.** Do not build an SCMD relay, do
not request an AMA ApplicationId, do not add a phone/PIN/OTP form. If a user
asks for CMD, point them at the official Autenticação.gov desktop application
and say so plainly in the UI.

This removes the AMA contract and the certification process from the critical
path, and it makes the §2 privacy line absolute: with card signing, not even a
digest crosses the wire.

**Facts about the Cartão de Cidadão:**
- The card carries two key pairs. Only `CITIZEN SIGNATURE` (nonRepudiation,
  protected by the **PIN de Assinatura**) may be used for document signing.
  The authentication key is off-limits.
- **CC v1 uses RSA; CC v2 (issued from June 2024) uses ECDSA**, and also
  supports contactless reading with a CAN code. **Negotiate the signature
  algorithm from the certificate's public key — never hard-code RSA.** ECDSA
  signature values come back from PKCS#11 as raw P1363 `r‖s`, which is what
  XMLDSig/XAdES wants directly, but CMS/CAdES would need DER re-encoding.
- Access is through **PKCS#11**, from the Autenticação.gov middleware
  (open source: `github.com/amagovpt/autenticacao.gov`):
  - Windows `C:\Windows\System32\pteidpkcs11.dll`
  - macOS `/usr/local/lib/libpteidpkcs11.dylib`
  - Linux `/usr/local/lib/libpteidpkcs11.so`
- **The pteid PKCS#11 module raises its own PIN dialogs.** Our code never
  sees, transports, caches or stores the PIN. Do not build a PIN field.
- **A browser cannot reach PKCS#11.** WebCrypto has no token access and
  WebAuthn cannot drive an arbitrary qualified signing key. A locally
  installed companion is mandatory — this is not avoidable, only chosen well.

**Therefore the architecture is:**

```
BROWSER (holds the payload)                    LOCAL MACHINE (holds the key)
  read file → SHA-256 (WebCrypto)
        ↓
  request signing certificate ─────────────▶  extension → native host
                                              → PKCS#11 → card
        ◀───────────────── X.509 signing certificate + CA chain
  build XAdES SignedInfo / signed attributes
  (cert digest, signing time, reference to the file digest)
        ↓
  digest of SignedInfo (DTBS) ─────────────▶  native host → C_Sign
                                              (pteid shows the PIN dialog)
        ◀───────────────── signature value + algorithm identifier
  assemble META-INF/signatures001.xml
  zip original + META-INF/ (fflate) → save
```

Two-step remote-signing shape (get-data-to-sign, then sign-with-value), the
same pattern EU DSS uses. The document bytes stay in the tab; the private key
stays on the card; nothing touches the network.

**The local companion — spike this before anything else in Phase 3, in order:**

1. **Web eID** (`web-eid/web-eid-app` + browser extension +
   `@web-eid/web-eid-library`). Exactly the right shape: origin-bound
   `getSigningCertificate` and `sign(digest)`, returns the signature and its
   algorithm (`RS256`, `ES384`, …), refuses raw-hash signing with the
   authentication key, and explicitly leaves container assembly to the
   integrator. Built for Estonian cards — **the spike must establish whether
   its native app can be pointed at `pteidpkcs11` by configuration, or whether
   we need a fork.**
2. **Our own native messaging host.** Rust + the `cryptoki` crate, on the order
   of 500 lines: `VERSION` / `CERT` / `SIGN` as JSON over stdio, plus a
   WebExtension for Chrome MV3 and Firefox. Copy the message protocol from
   `open-eid/chrome-token-signing` (deprecated, but well specified).
3. **A localhost HTTP service. Do not.** Chrome's Private Network Access rules
   make HTTPS → `http://127.0.0.1` fragile and increasingly permission-gated.

Registering `pteidpkcs11` directly in Firefox is a red herring — it enables TLS
client authentication, not document signing.

Ship a **`/sign/setup`** page that detects reader, middleware, extension and
native host and shows a per-OS green/red checklist with install links to
autenticacao.gov. Most of the support burden for this module will land here.

**Container format.** A `.ifczip` is just a ZIP holding the `.ifc`; a `.bcfzip`
is already a ZIP. Neither has a signature slot. The correct standard is
**ASiC-E (ETSI EN 319 162)**, a ZIP with `META-INF/signatures001.xml` (XAdES) —
structurally compatible with both. So produce:

```
model.ifczip                    issue-set.bcfzip
├── model.ifc                   ├── bcf.version, project.bcfp, …
├── META-INF/                   ├── {topic-guid}/…
│   ├── manifest.xml            └── META-INF/signatures001.xml
│   └── signatures001.xml
```

The archive stays a valid ifcZIP/bcfzip for any other tool; signature-aware
tools read `META-INF/`. Zip with `fflate`, build the XAdES XML client-side.
Hash the uploaded bytes exactly as received — never re-serialise a model
before signing, because a STEP round-trip reorders instances and rewrites the
header, which silently invalidates the signature.

ASiC-E supports parallel signatures (`signatures002.xml`, …), so a model signed
by author, then reviewer, then coordinator is a natively supported case. Build
co-signing in from the start; it is the feature no BIM tool currently offers.

**Bulk mode — this changes with the card.** The signature key is a
nonRepudiation key behind the signature PIN, and there is no card equivalent of
`CCMovelMultipleSign`. Assume **one PIN entry per signature** until measured
otherwise. Two designs; pick one in the spike after observing what
pteid-pkcs11 actually prompts:

- **Per-file signatures** — N PIN prompts, N independently verifiable
  containers. Honest, standard, tedious for a 40-model federation.
- **One signature over a manifest** — hash all N files, build a single XAdES
  signature over an `ASiCManifest`-style list of digests, one PIN prompt. Ship
  the set as one multi-payload ASiC-E, or distribute the files with a shared
  signature file. Better UX and fully standards-legal, but individual files are
  no longer independently verifiable.

Default to the manifest form for a coherent model set, offer per-file signing
as an explicit alternative, and be clear in the UI about which guarantee the
user is getting. Per-file table with status, retry and "download all" either way.

**Timestamping and long-term validation.** This is now the only reason the
Django backend is involved in signing at all. TSA, OCSP, CRL and trusted-list
endpoints do not send CORS headers, so the browser cannot fetch them. Add a
`trust/` app — a thin, caching, unauthenticated-payload proxy:

- `POST /api/trust/timestamp` → RFC 3161 request (carries a hash only) to a
  qualified TSA, returns the token.
- `GET /api/trust/ocsp`, `/api/trust/crl` → revocation data for the CC chain.
- `GET /api/trust/tsl` → cached EU LOTL / Portuguese trusted list, for the
  verification tab.

It **must not** log or persist digests. It may write a `SignatureAudit` row on
an explicit, opt-in call from the browser containing only
`{user, timestamp, file_name, digest_hex, cert_subject, cert_serial}` — never
file content, never the signature. Default off outside a project context.

Profile: **XAdES-B** as the floor, **XAdES-T** once a qualified TSA is chosen,
XAdES-LTA for archival. CC signing certificates are short-lived relative to the
life of a building model, so LTA is not optional in the long run — design the
signature builder so extending B → T → LTA is a later pass over an existing
container, not a rewrite.

**Offline verification tab:** drop a signed container, re-hash the payload,
verify the XAdES against the embedded certificate, check the chain against the
Portuguese trust list, and report timestamp and revocation status. Client-side
except for the TSL/OCSP fetch through `trust/`; bundle a TSL snapshot as a
fallback and warn when it is stale.

**Testing without a card.** CI has no smart card and no PIN-entering human. Put
the device behind `lib/signing/provider.ts` with three implementations:
`webeid` (real card), `softhsm` (SoftHSM2 with a test RSA key and a test ECDSA
key, driving the same native host — full end-to-end in CI, and the only way to
cover the CC v1/v2 algorithm split), and `mock`. The XAdES builder, the
manifest logic and the container assembly then need no hardware; only the final
card round-trip needs a person and a reader.

### Phase 4 — Georeferencing (`/georef`)

Port `tudelft3d/ifcgref` (Flask + pyproj + scipy) to the browser.

**Read & report** — a validation panel graded against the IFC georeferencing
levels (LoGeoRef 20–50):
- `IfcSite.RefLatitude` / `RefLongitude` / `RefElevation` (compound degrees)
- `IfcGeometricRepresentationContext.TrueNorth`, `WorldCoordinateSystem`
- `IfcMapConversion` — `Eastings`, `Northings`, `OrthogonalHeight`,
  `XAxisAbscissa`, `XAxisOrdinate`, `Scale`
- `IfcProjectedCRS` — `Name` (EPSG code), `GeodeticDatum`, `VerticalDatum`,
  `MapUnit`
- IFC4.3 additions: `IfcMapConversionScaled`, `IfcRigidOperation`,
  `IfcCoordinateOperation` on alignment contexts
- IFC2x3 fallback: the `ePSet_MapConversion` / `ePSet_ProjectedCRS` property sets

**Transform:** `proj4js` for local ↔ projected ↔ WGS84. Bundle a searchable
EPSG registry; default to Portuguese CRSs (ETRS89/PT-TM06 **EPSG:3763**,
Datum 73, Lisboa Hayford-Gauss, plus Azores/Madeira zones).

**Fit:** ifcgref uses `scipy.optimize.least_squares` to refine parameters from
control-point pairs. Implement Levenberg–Marquardt in TS (or a small Rust/WASM
crate) solving for `{eastings, northings, height, rotation, scale}` from ≥2
point pairs, with residuals reported per point.

**Map:** MapLibre GL JS. Compute the model footprint in-browser (convex hull /
roof-print of the envelope, à la IfcEnvelopeExtractor), reproject to WGS84,
render as a GeoJSON overlay. Add a 3D mode: MapLibre terrain + the IFC mesh
placed via a three.js custom layer, plus optional OGC 3D Tiles overlay
(`deck.gl` `Tile3DLayer`) for context.

⚠️ **Tiles:** the OSM public tile server forbids production app use. Use
Protomaps (self-hosted PMTiles, fully offline — best fit for the privacy
story) or MapTiler with a key. Make it configurable; default to Protomaps.

**Write back:** patch/insert `IfcMapConversion` + `IfcProjectedCRS` and update
`IfcSite` lat/long/elevation, export a corrected IFC via the adapter's STEP
writer. Show a before/after diff of the changed entities.

### Phase 5 — IDS authoring (`/ids/create`)

No JS library does IDS authoring — build it. Model it on
`ids.bimvision.eu/IDS/Create`.

Schema: **IDS 1.0**, `http://standards.buildingsmart.org/IDS/1.0/ids.xsd`.

- `<ids>` → `<info>` (title, copyright, version, author, date, purpose,
  milestone) + `<specifications>`.
- Each `<specification>` has `name`, `ifcVersion` (`IFC4` | `IFC4X3_ADD2`),
  `identifier`, `description`, `instructions`, plus `<applicability>` and
  `<requirements>`, with `minOccurs`/`maxOccurs` cardinality.
- Six facets in both blocks: **Entity, Attribute, Classification, Property,
  Material, PartOf**. Requirement facets carry
  `cardinality = required | optional | prohibited`.
- Facet values are `xs:restriction` — `enumeration`, `pattern` (XSD regex),
  `minInclusive`/`maxInclusive`/`minExclusive`/`maxExclusive`, `length`
  variants — or a simple value. Build `FormRestriction` for this.

Implementation:
- Zod schemas in `lib/validators/ids-validators.ts` mirroring the XSD, driving
  the TanStack Form registry from §3.
- Master/detail UI: specification list (dnd-kit reorderable) + facet editor
  with live XML preview.
- Autocomplete facet values from a **currently loaded IFC** — real entity
  classes, Psets, properties, materials, classifications. This is the feature
  that makes the tool better than the reference web app.
- Serialize to IDS 1.0 XML; validate against the bundled XSD in-browser
  (`xmllint-wasm`) before download. Import existing `.ids` files for editing.
- Save drafts to OPFS; export/import a JSON project file.

### Phase 6 — IDS validation & reporting (`/ids/validate`)

- Inputs: one IDS + N loaded IFC models (federation-aware).
- Run `@ifc-lite/ids` through the adapter in a worker, streaming progress.
- **Graphical output:**
  - Summary tiles: pass / fail / not-applicable per specification.
  - Per-specification table, expandable to failing entities with the reason
    ("expected Pset_WallCommon.FireRating, found none").
  - Recharts breakdown by specification, by IFC class, by model.
  - **Click a failure → the viewer isolates and highlights that entity.** The
    validator and viewer share the same selection store (zustand).
- **Export:**
  - HTML/PDF report (client-side).
  - **BCF 3.0 export** — one topic per failure or grouped per specification:
    ```
    report.bcfzip
    ├── bcf.version            (VersionId="3.0")
    ├── project.bcfp
    ├── extensions.xml
    └── {topic-guid}/
        ├── markup.bcf         Topic, Title, Description, Labels, DueDate,
        │                      Comments, ViewPoints
        ├── viewpoint.bcfv     PerspectiveCamera + Components(Selection,
        │                      Visibility, Coloring) with IfcGuids
        └── snapshot.png       captured from the viewer canvas
    ```
    Generate the viewpoint by framing the failing entity in the viewer and
    grabbing the canvas — so every issue opens in the right place in any
    BCF-capable tool. Zip with `fflate`.
- Feeds straight into Phase 7 for signing the report.

### Phase 7 — BCF manager (`/bcf`)

- Import `.bcf` / `.bcfzip` (BCF 3.0 primary; read 2.1 and upgrade on import).
- Topic list with filters (status, priority, type, assignee, label, due date),
  sort, and bulk edit.
- Topic detail: description, comments thread, viewpoints, snapshots,
  document references, related topics.
- **"Open viewpoint" restores the camera and component visibility/colouring in
  the Phase 2 viewer** — this is the payoff for sharing one viewer.
- Create and edit topics from the viewer (frame a view → new topic).
- Merge multiple BCF files; detect GUID collisions.
- Export back to a valid BCF 3.0 zip. Optionally sync with the Django `cde`
  app via the BCF 3.0 REST API — **metadata only, opt-in, off by default**.

---

## 6. Cross-cutting requirements

- **Performance:** all parsing/validation in Web Workers; virtualised lists for
  large tables; stream progress; target a 200 MB IFC without freezing the UI.
- **i18n:** Portuguese + English from the start (`next-intl`). Signature and
  georeferencing UI is Portugal-specific — PT strings must be first-class.
- **Accessibility:** radix primitives give keyboard/ARIA for free; keep it.
  The 3D canvas needs a keyboard-navigable tree alternative.
- **Testing:** Vitest for the engines (`lib/ifc`, `lib/ids`, `lib/bcf`,
  `lib/georef`, `lib/signing`); Playwright for the module flows; a fixture set
  of small IFC4 / IFC4X3 / BCF 3.0 / IDS 1.0 files committed to `fixtures/`.
  Include buildingSMART's official IDS test suite. Signing runs against
  **SoftHSM2** in CI (one RSA and one ECDSA test key, mirroring CC v1 and v2);
  only the real-card round-trip is manual.
- **Docker:** extend the existing `docker-compose.yml` / nginx config. Nginx
  must send COOP/COEP headers if SharedArrayBuffer is needed by the WASM
  workers, and a CSP that blocks unexpected origins.
- **ADRs:** `docs/adr/` — 001 IFC engine, 002 signature container format,
  003 map tile provider, 004 card signing companion (and why CMD was dropped).

---

## 7. Open questions to resolve before Phase 3

1. **Can the Web eID native app drive `pteidpkcs11` unmodified?** If yes, the
   companion problem is solved by configuration. If no, do we fork it or write
   our own Rust native messaging host? **Blocking for Phase 3** — resolve it
   with the spike, not with an argument.
2. **Who packages, code-signs and notarises the native host installer** for
   Windows and macOS? An unsigned helper will not install cleanly, and Apple
   notarisation plus an EV code-signing certificate is a real recurring cost.
   Note the irony and budget for it early.
3. **Bulk: N prompts or one manifest signature?** Decide after measuring what
   pteid-pkcs11 actually prompts for a batch. Affects the whole `/sign` UI.
4. **Is ASiC-E the right container**, or must the output be a bare `.ifczip`
   with the signature as a sidecar `.p7s`/`.xml` file? ASiC-E is recommended;
   confirm it satisfies whoever consumes these files.
5. **Signature profile and TSA:** XAdES-B is the floor. XAdES-T needs a
   qualified timestamp authority — which one, and who pays? Check whether
   UMinho already has an institutional TSA before buying one.
6. **Does the `cde` Django app need to store projects/models**, or is the app
   fully local-first with the backend used only for auth, the audit log and the
   `trust/` proxy?

---

## 8. Build order

```
Phase 1  Foundation + engine spike + ADR          ← blocking
Phase 2  Viewer + federation                      ← everything else depends on it
Phase 4  Georeferencing        ┐
Phase 5  IDS authoring         ├─ parallel after Phase 2
Phase 7  BCF manager           ┘
Phase 6  IDS validation + BCF export              ← needs 2, 5, 7
Phase 3  Signing (IFC + BCF)                      ← needs 6/7 output; Q1 spike first
```

Start with Phase 1. Do not skip the engine spike.

**Run the card companion spike (Q1) during Phase 1**, in parallel with the
engine spike. It touches none of the viewer code, it is the single largest
unknown left in the project, and dropping CMD means the old blocker — an AMA
contract with a months-long certification process — is gone. Record the outcome
in `docs/adr/004-card-signing-companion.md`.