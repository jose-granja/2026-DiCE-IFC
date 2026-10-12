<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# DiCE-IFC — frontend agent rules

Browser-based BIM toolkit: IFC viewer + federation, IFC/BCF digital signature with
the Cartão de Cidadão, georeferencing, IDS authoring and validation, BCF manager.

Two things override everything else in this file:

1. **The privacy line** (§1). No model, issue or specification data leaves the browser.
2. **Next.js 16 is not Next.js 15** (§2). Verify against the bundled docs, not memory.

---

## 1. The privacy line — non-negotiable

Every byte of IFC, BCF and IDS data is parsed, validated, rendered, signed and
zipped **in the browser**. There is no backend: the app is a Next.js front end, and
its own server only serves pages and proxies bSDD (below).

**The boundary is the machine, not the tab.** Signing needs a smart card, and a
browser cannot reach one, so a local companion runs alongside (`companion/`, ADR
007). User content may cross to a program on the same machine; it may never
cross to the network. In practice the companion is sent a **digest and nothing
else** — permission to send more is not a reason to.

### Hard rules

- **No `fetch`/`axios` call may carry a `File`, `Blob`, `ArrayBuffer`,
  `TypedArray`, `FormData` or `ReadableStream` of user content.** Enforced by the
  `no-restricted-syntax` ESLint rules in `eslint.config.mjs`; do not disable them
  without an ADR.
- **No Server Action ever receives a payload.** The app has no Server Actions
  at all now (accounts, and with them the auth cookie flow, are gone). If one is
  ever added, nothing under `lib/ifc`, `lib/ids`, `lib/bcf`, `lib/georef` or
  `lib/signing` may be imported from its `"use server"` module.
- **Every page that touches a payload is a Client Component** (`"use client"` at
  the top of the route's `page.tsx`): `/viewer`, `/ids/create`, `/sign/ifc`,
  `/sign/bcf`, `/sign/verify`.
- **CSP forbids third-party origins** other than the configured map tile provider.
  Default tile provider is self-hosted Protomaps/PMTiles, i.e. same-origin. The
  policy lives in `proxy.ts`, which mints a per-request nonce — Next injects
  inline bootstrap scripts, and a `script-src` without a nonce blocks them, so
  the page renders but **never hydrates**. That failure is silent: the HTML looks
  right and nothing is interactive. If you change the CSP, run
  `npm run test:e2e` — the viewer suite only passes on a hydrated page.
- **Every module renders `<LocalOnlyBadge />`** ("Processed locally — nothing
  uploaded"). `/privacy` documents exactly what leaves the device.

### The complete list of things allowed to cross the wire

| What | Where | Why |
|---|---|---|
| bSDD search text and class names (opt-in) | `app/api/bsdd/route.ts`, this app's own server | bSDD sends no CORS headers (ADR 009) |
| Map tiles, 3D tiles | the configured provider (opt-in) | basemap and 3D context |
| SHA-256 of a `SignatureValue` + a nonce (opt-in, when a `TSA_URL` is configured) | `app/api/tsa/route.ts`, this app's own server, then the time-stamp authority | RFC 3161 time-stamps send no CORS headers and the paid ones need credentials (ADR 012) |

There is no account, no project database and no Django API any more. Anything
that would need a server — an RFC 3161 timestamp, OCSP/CRL/TSL fetches for full
signature validation, none of which send CORS headers — is a Next.js route
handler like `app/api/bsdd/route.ts`, allow-listed the same way, not a new
service.

Nothing else *over the network*. Separately, and only on the same machine:

| What | Where | Why |
|---|---|---|
| A digest of `SignedInfo` (32–64 bytes) | `http://127.0.0.1` companion | the signing key is on a card the browser cannot reach |

The companion binds to loopback, requires a token regenerated on every start,
allow-lists the calling origin and has no endpoint that accepts a document. If you are about to add a network call, it must fit a row above or
it needs an ADR first.

### Code-review checklist (paste into every PR that touches `lib/` or a module page)

- [ ] No user payload in a request body, query string or header.
- [ ] No payload type crosses a Server Action boundary.
- [ ] New network calls are one of the allowed kinds above.
- [ ] Page touching a payload is `"use client"`.
- [ ] `<LocalOnlyBadge />` present on the module.
- [ ] New third-party origin? CSP updated **and** ADR written.
- [ ] Nothing written outside OPFS / `localStorage` keys we own.
- [ ] Nothing sent to the companion but a digest.

---

## 2. Next.js 16 — what changed

Verified against `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md`.
Re-read it before touching routing, config or caching.

- **Turbopack is the default** for `next dev` and `next build`. Do **not** pass
  `--turbopack`. A custom `webpack` config makes `next build` fail; use the
  top-level `turbopack` config key (no longer `experimental.turbopack`).
- **Async request APIs are async-only.** `cookies()`, `headers()`, `draftMode()`,
  and `params` / `searchParams` in `layout.tsx`, `page.tsx`, `route.ts`,
  `default.tsx` must be awaited. Synchronous access was removed.
  ```tsx
  export default async function Page(props: PageProps<'/bcf/[topic]'>) {
    const { topic } = await props.params
  }
  ```
  `PageProps` / `LayoutProps` / `RouteContext` are generated globals — run
  `npx next typegen` to refresh them.
- **`middleware.ts` is now `proxy.ts`**, exporting `proxy`. Node.js runtime only;
  the `edge` runtime is not supported there. Config flags renamed accordingly
  (`skipMiddlewareUrlNormalize` → `skipProxyUrlNormalize`).
- **`next lint` is gone.** `npm run lint` calls the ESLint CLI directly, and
  `next build` no longer lints. ESLint flat config only.
- **`revalidateTag(tag)` now requires a `cacheLife` profile**:
  `revalidateTag('projects', 'max')`. Use `updateTag` in Server Actions for
  read-your-writes, `refresh()` to refresh the client router.
- **`cacheLife` / `cacheTag` are stable** — drop the `unstable_` prefix.
- **PPR / `experimental.dynamicIO` / `experimental.useCache` are replaced by the
  top-level `cacheComponents` flag.** We do not enable it (this app is
  local-first and almost entirely client-rendered).
- **Parallel route slots require an explicit `default.tsx`** or the build fails.
- **`serverRuntimeConfig` / `publicRuntimeConfig` are removed.** Use
  `NEXT_PUBLIC_*` env vars, read through `config/env.ts`.
- **`next dev` writes to `.next/dev`**, so dev and build can run concurrently.
- **`next dev` no longer sees `dev` in `process.argv`** — branch on
  `process.env.NODE_ENV` in `next.config.ts` instead.
- Minimums: Node 20.9, TypeScript 5.1, Chrome/Edge/Firefox 111+, Safari 16.4+.
- `next/image`: `images.domains` deprecated (use `remotePatterns`), default
  `qualities` is `[75]`, `minimumCacheTTL` is 4 h, local IPs blocked by default.

- **`proxy.ts` sets the CSP with a per-request nonce**, and `app/layout.tsx`
  reads it from the `x-nonce` header to pass to `next-themes` (whose pre-paint
  script is inline). COOP/COEP and the other static headers stay in
  `next.config.ts`, mirrored by `nginx/nginx.conf` in production.
- **`turbopack.resolveAlias` stubs `laz-perf`** — see `lib/empty-module.ts` for
  why the build fails without it.
- **`output: "standalone"` is opt-in** via `BUILD_STANDALONE=1`, set only by
  `Dockerfile.prod`: it makes `next start` a no-op, which breaks local `npm
  start` and the Playwright web server.

### Things that did *not* change and are still true

- App Router, route group `(home)`, colocated `_components/` folders.
- `"use client"` / `"use server"` directives.
- `app/globals.css` + Tailwind 4 via `@tailwindcss/postcss`.

---

## 2a. Look and feel

The palette is **Tokyo Night**, matching ifclite: `#1a1b26` page and `#16161e`
panels in dark, a soft `#e0e6f0` page with translucent white panels in light,
`#7aa2f7` primary, `#3b4261` borders. Everything is a token in
`app/globals.css`; no component hard-codes a colour.

- **`.glass` + `bg-card` is the panel surface.** `--card` is translucent in both
  themes, so a panel over the viewport reads as glass. `backdrop-filter` makes
  the compositor resample what is behind it every frame, and behind these panels
  is a WebGL canvas that is already redrawing — keep it on panel chrome, never
  on a long scrolling list. `prefers-reduced-transparency` turns it opaque.
- **The viewer's side panels are docked, not floating, and resizable.** They
  used to overlay a full-bleed canvas, ifclite-style — a deliberate trade
  that cost a "clear channel" nothing could be placed in, because a click
  under a panel never reached the 3D view at all. Real layout space instead:
  `page.tsx` is a flex row of `[left aside][ResizeHandle][canvas
  flex-1][ResizeHandle][right aside]`, each aside's width held by
  `useResizableWidth` (`PanelResizeHandle.tsx`) and dragged via
  `ResizeHandle`'s own pointer-capture, not a global `pointermove` listener.
  `ViewerRenderer`'s `ResizeObserver` already watches the canvas element
  itself, so a drag resizing it needs no renderer change to follow. Width
  persists per side in `localStorage` (`dice-ifc.viewer.panel-width.*`) across
  sessions.

  The viewport controls still live at bottom-**centre** — no longer chosen to
  dodge a floating panel, just the natural centre of whatever space the
  canvas actually has, which since the panels stopped overlapping it is the
  same thing. `e2e/tools.spec.ts` still asserts `document.elementFromPoint`
  is the canvas before its "empty space" click, which is worth keeping even
  with panels docked: it is what would catch a future overlay positioned
  wrong, or one covering the canvas again by accident.
- **Never seed `useState` from `localStorage` directly — the DOM silently
  keeps the server's value.** `useResizableWidth`'s first version did
  `useState(() => readStoredWidth(...))`, which looks like the obvious way to
  restore a persisted width. The server has no `localStorage`, so SSR always
  renders the `fallback`; when the client's first render legitimately computes
  something else (a real stored width), **the state itself is correct — React
  DevTools shows it, a `console.log` in the render body shows it — but the
  committed DOM keeps the server's value anyway**, with no hydration-mismatch
  warning, because hydration isn't reconciling that first commit against the
  new render so much as trusting the server's markup for it. The bug hides
  well: it only shows up with something already in storage, i.e. never on a
  first visit, and cost real time to pin down specifically because every
  signal pointed at "the state is right" while the only thing actually wrong
  was one DOM attribute. The fix is the standard one — start at `fallback`
  unconditionally and correct it in a `useEffect` that runs once after mount,
  which is a genuine subsequent client render rather than a hydration commit
  and so does patch the DOM. `setClamped` writes storage itself, at the point
  of a real resize, rather than a second effect keyed on `width` — that would
  also fire for this correction's own `setWidth` and write the just-read value
  straight back, which is harmless here but is the same shape of bug waiting
  for a case where it is not.
- **Do not size a flex child of the viewer column with `h-full`.** `height: 100%`
  resolves against the whole column, header included, so the element overflows
  the page. `ModelDropZone` did this and pushed the viewport controls off-screen
  the moment the canvas went full-bleed. Use `flex-1 min-h-0`.
- **The scene is a function of the store.** `ViewerCanvas` reconciles the
  renderer against `models` — adding geometry for new ones and calling
  `removeModel` for ones that have gone. `unloadModel` deliberately knows
  nothing about the renderer; before this the model vanished from the list and
  stayed drawn. `data-rendered-models` exposes what the scene actually holds so
  that is assertable rather than inferred from the store.
- **`--viewport` is the 3D backdrop.** A WebGL canvas clears to its own colour
  and cannot inherit the page's, so `ViewerCanvas` reads this token and calls
  `renderer.setBackgroundColor`. It is set on the scene rather than made
  transparent so BCF snapshots keep the backdrop instead of coming out with a
  transparent hole. `next-themes` toggles a class with no event, hence the
  `MutationObserver`.
- **`.panel-tabs` collapses labels to icons** by container query when a panel is
  narrow. The label is *visually* hidden, never `display: none` — that would
  drop the word from the accessibility tree and leave the tab named only by an
  icon, breaking both screen readers and `getByRole("tab", { name: … })`.

---

## 2b. Language

Portuguese and English, both first-class, from a cookie — no `/pt` or `/en`
prefix and no `app/[locale]/` segment. See `i18n/config.ts` for why.

- **Never hard-code user-visible text.** Every string a user reads comes from
  `messages/pt.json` and `messages/en.json` via `useTranslations()`. This works
  in Server Components too — next-intl resolves messages synchronously from the
  request config, so a translated page stays static-rendered.
- **Do not put user-visible prose in `config/`.** `MODULES` used to carry
  `title` and `description`; that is what left the navigation permanently
  English. It now carries a `key` into `modules.<key>` and nothing readable.
- **A language toggle can be entirely correct and entirely useless.** The
  original one set the cookie, flipped `<html lang>`, and re-rendered — all
  verifiable, all green — while every one of 125 components rendered hard-coded
  English. **Test rendered text, never the cookie or the `lang` attribute**;
  both were right throughout. `e2e/locale.spec.ts` is that guard.
- **Both catalogues, same keys.** A key present in one and missing from the
  other renders as the key path (`nav.signOut`) at the user. The last test in
  `locale.spec.ts` sweeps the shell pages in both languages for that pattern.
- **Portuguese is the default, and is not a translation.** "Cartão de Cidadão",
  "PIN de Assinatura" and "ETRS89 / PT-TM06" are source strings. Write the
  Portuguese first where the module is Portugal-specific.
- **e2e assertions must match both languages or pin one deliberately.** A
  Chromium with `Accept-Language: en-US` gets English, so an English-only
  assertion passes in CI and hides a break for every Portuguese user. Either
  match `/english|português/i` or set the `dice-locale` cookie explicitly.

## 3. Layout

```
frontend/
├── proxy.ts               CSP with a per-request nonce (§2)
├── app/
│   └── (home)/            every page, behind the main nav
│       ├── viewer/        _components/
│       ├── ids/create/   (georef/, ids/validate/, bcf/ → redirect to /viewer)
│       ├── sign/ifc/  sign/bcf/            (+ sign/setup, sign/verify to come)
│       └── privacy/
├── app/provider.tsx       QueryClient + Tooltip + FormSchema contexts
├── components/
│   ├── ui/                shadcn/radix primitives
│   └── form/              TanStack Form registry (see §4)
├── lib/
│   ├── ifc/               adapter + IFC-lite implementation  ← §5
│   │                       (+ ids-document.ts: main-thread IDS parse)
│   ├── viewer/            federation, batching, renderer, store, workspace
│   ├── ids/ bcf/ georef/ signing/       ← §8 bcf/, §9 ids/ validation
│   ├── storage/           opfs.ts
│   ├── workers/           Comlink-wrapped Web Workers
│   ├── validators/        Zod schemas
│   └── actions/           Server Actions — auth and locale only
├── e2e/                   Playwright
└── config/                enums, constants, EPSG list
```

Module pages live under `(home)` so they inherit the nav; the viewer sizes itself
against that (`h-[calc(100vh-3.25rem)]`).

Path alias is `@/*` → repo root (no `src/`).

---

## 4. Form system

TanStack Form `createFormHook` registry driven by Zod, ported from the
bimaplus reference project. The contract:

- `components/form/hooks.tsx` — `createFormHook({ fieldComponents })` exporting
  `useAppForm`, `useFieldContext`, `useFormContext`. **Register new controls here.**
- `components/form/FormBase.tsx` — wraps every control with label, description
  and error, and derives `required` from the Zod schema
  (`fieldSchema.isOptional() === false`).
- Each control calls `useFieldContext()` + `useFormSchema(field.name)` and derives
  `minLength` / `maxLength` / `min` / `max` / enum options from Zod via the
  helpers in `lib/utils.ts`.
- Wrap forms in `<FormSchemaProvider schema={...}>` so `useFormSchema` resolves.
- Validators live in `lib/validators/*-validators.ts`; enums in `config/`.

**Zod stays on v3** (`^3.25.76`) — the introspection helpers read `_def.checks`
and `_def.typeName`, which v4 restructures. Do not bump it without porting
`lib/utils.ts`.

App-specific controls to add as the phases land: `FormSelectEPSG`,
`FormSelectIfcEntity`, `FormSelectPropertySet`, `FormRestriction`,
`FormCardinality`, `FormCoordinateInput`.

---

## 5. IFC engine access

**No page, component or module imports `@ifc-lite/*` directly.** Everything goes
through `lib/ifc/adapter.ts`:

```ts
loadModel · getEntities · getProperties · getSpatialTree ·
setEntityAttribute · exportStep
```

IFC-lite is young and WebGPU-first, so the adapter is the swap point: if a module
needs That Open instead, it implements the same interface for that module only.
`lib/ifc/__tests__/conformance.ts` is the shared suite every implementation must
pass. See `docs/adr/001-ifc-engine.md`.

Always ship the WebGL fallback path; feature-detect WebGPU and warn, never
require it. `lib/viewer/renderer.ts` is three.js/WebGL.

Two engine facts worth knowing before touching geometry, both established by
measurement rather than documentation (see `lib/viewer/federation.ts` and the
conformance suite):

- **Meshes are Y-up**, while IFC is Z-up: `render = (x, z, −y)`.
- **`MeshView.positions` are element-local.** World position is
  `origin + positions`. Ignoring `origin` stacks every element at 0,0,0 — and
  each mesh still looks individually correct, so it is easy to miss.

Never transfer engine-owned buffers across the worker boundary: they are views
into the WASM heap, and detaching them kills the worker mid-call, which presents
as a promise that never settles. `lib/workers/ifc.worker.ts` copies first.

**An element can be classified in several systems at once**, so a filter naming
a system *and* a code must satisfy both on the **same**
`IfcClassificationReference` — `lib/ifc/classification-filter.ts`. Checking them
independently selects an element that is `Ss_25_10_30` in one system and merely
present in the other, which quietly inflates a quantity. Codes nest by prefix, so
a branch is asked for with the ordinary `Ss_25*` glob rather than special
handling. One matcher serves both callers — the quantity query's filters and a
clash group's `ElementFilter` — so the two can never disagree about what a code
means. `fixtures/ifc/classified-wall-ifc4.ifc` and `classified-clash-ifc4.ifc`
each carry two systems on one element for exactly this test.

**`lib/ifc/ids-document.ts` is the second — and only other — file allowed to
import the engine.** The engine's IDS parser needs `DOMParser`, which a Web
Worker does not have, so `parseIDS` must run on the main thread and the parsed
document is cloned into the worker for `validateIds`. Passing the XML in and
parsing it there fails at runtime with "No DOMParser implementation available".
The module imports `@ifc-lite/ids` alone, so the main bundle does not gain the
geometry processor and its WebAssembly.

---

## 6. Signing

Read `docs/adr/007-local-signing-companion.md` and
`docs/adr/008-real-canonicalization.md` before touching `lib/signing/`.
(ADR 004 and ADR 006 are superseded but kept — 006 in particular records a
mistake worth not repeating.)

- **Physical Cartão de Cidadão only.** Chave Móvel Digital is out of scope — no
  SCMD relay, no AMA ApplicationId, no phone/PIN/OTP form. Point users at the
  official Autenticação.gov desktop app instead.
- **Never build a PIN field.** The pteid PKCS#11 module raises its own PIN dialog.
  We never see, transport, cache or store the PIN.
- **Never hard-code RSA.** CC v1 is RSA, CC v2 (June 2024+) is ECDSA — negotiate
  the algorithm from the signing certificate's public key.
- **Never re-serialise a model before signing.** Hash the bytes exactly as read; a
  STEP round-trip reorders instances and rewrites the header, silently
  invalidating the signature.
- Device access is behind `lib/signing/provider.ts`. Implementations:
  `companion` (**the default** — the real card via `companion/`, ADR 007),
  `webeid` (the same card via the Web eID extension; kept because upstreaming
  Portuguese support would beat shipping our own installer, but no such build
  exists so it cannot sign), `software` (real WebCrypto keys and a real
  self-signed certificate — genuine signatures, no hardware, and what covers the
  RSA/ECDSA split in tests), `mock` (fixtures, for UI work). `softhsm` is not
  registered: a stub that cannot sign would only fail confusingly at the PIN step.
- **The companion is a device, not a signing service.** It returns a certificate
  and signs `SignedInfo`; `xades.ts` and `asice.ts` still build everything in
  the browser. Do not move container assembly into it — that would retire tested
  code in favour of untested code and widen what crosses the boundary.
- **Ask the card, do not assume.** Three things about the Cartão de Cidadão were
  written down as fact and were wrong: that it declares a protected
  authentication path (it reports `CKF_LOGIN_REQUIRED = false` and no protected
  path, so `C_Login(NULL)` fails outright), that `CKM_RSA_PKCS` can be used to
  sign (advertised with `CKF_SIGN`, refused at `C_Sign` for the signature key),
  and that its mechanism list is readable (`C_GetMechanismList` over-reports and
  spills garbage). Each cost a debugging round. Query the token, and treat
  trying-and-handling-the-error as more reliable than what it advertises.
- **One PIN dialog per signature, and treat a second as a bug.** The middleware
  prompts from inside `C_Sign` **before** the card validates the mechanism, so
  an attempt that ends in `CKR_MECHANISM_INVALID` has already cost the citizen a
  PIN entry. Trying the "nicer" mechanism first and falling back therefore
  charged two dialogs for every signature — which is exactly what shipped, and
  what the point above should have predicted. `sign_data` now orders the
  attempts so the working one is first and remembers the winner per card. Any
  change to that ordering needs `MechanismFallbackTests` to still assert a
  single `C_Sign`.
- **Never pair with a fixed token.** The companion mints a random one per start
  and hands it to an allow-listed `Origin` at `GET /pair`; the browser fetches
  it without the citizen typing anything. A constant compiled into both sides
  would be public in this repository — authenticating nobody while looking like
  a control, which is the kind of wrong that survives review. The origin
  allow-list is the real protection, and it does not defend against a program
  already on the machine; the PIN dialog is the control there.
- **The companion runs as the logged-in user, never as a service.** The PIN
  window has to appear on that user's desktop; a Windows service in session 0
  could never show it. `companion/packaging/` installs a LaunchAgent and a
  Startup shortcut for exactly this reason.
- **Everything hashed goes through `lib/signing/c14n.ts` first**, and the
  canonical string is both what is hashed and what is embedded. Do not hash a
  fragment you serialised yourself: exclusive c14n renders a namespace
  declaration on the element that *uses* it, not at the root of the fragment,
  and getting that wrong produced signatures no conforming verifier accepted
  while every one of our own tests passed. See ADR 008.
- **A round trip through our own code proves nothing about interoperability.**
  `real-container.test.ts` verifies a container signed by a different tool with
  a real card; it is the only test that could have caught the above. Keep it,
  and keep it skipping cleanly when no such file is on the machine — the file
  carries a citizen's certificate and is never committed.
- **Never claim a valid signature is a trusted one.** `verify.ts` proves the
  bytes are what was signed and that the signer held the key for the enclosed
  certificate. Chain, revocation and timestamp all need a server-side fetch
  (none of those services send CORS headers); until one exists `trust` is `"not-checked"` and the UI says so.
- **`webeid` must fail fast before a PIN dialog can exist.** Card operations get
  no timeout — the user may be reading a PIN prompt — but the extension
  handshake does, or a machine with no extension hangs on "Reading the signing
  certificate…" forever.
- **Time-stamps are built; revocation checks are not.** `app/api/tsa/route.ts`
  stamps a signature (XAdES-B-T) through the one authority a deployment names in
  `TSA_URL` (ADR 012, which also lists provider options). The browser sends a
  SHA-256 hex string and nothing else; the route builds the RFC 3161 request,
  checks the answer stamps *that* hash and nonce, rate-limits per client (every
  stamp may cost money), and never logs a digest. OCSP/CRL/TSL fetches would need
  the same kind of proxy and are not built; an OCSP/CRL proxy must be
  host-allow-listed — without that it is an open relay.
- **A failed time-stamp must not lose a signature.** The citizen has typed the PIN
  by then. `signFiles` returns the B-B container with `timestamp.status: "failed"`
  and the page says so; do not throw, and do not downgrade silently.
- **Do not call a signature qualified.** A time-stamp from a *qualified* service
  plus the card's qualified certificate is what makes a QES, and the verifier does
  not check either against the trusted list. `verify.ts` reports what a token
  covers and says what it did not check.

---

## 7. Cross-cutting

- **Workers for everything heavy.** Parsing, IDS validation and geometry run in
  `lib/workers/`; the UI thread must survive a 200 MB IFC. Virtualise long tables.
- **i18n:** `next-intl`, Portuguese *and* English from the start. Signing and
  georeferencing strings are Portugal-specific — PT is first-class, not a translation.
- **Accessibility:** radix gives keyboard/ARIA for free — keep it. The 3D canvas
  needs a keyboard-navigable tree alternative.
- **Anything imported by `app/`, `components/`, `lib/` or `config/` belongs in
  `dependencies`, never `devDependencies`.** It ships. A dev install has every
  package on disk so the mistake is invisible locally, and any install that
  omits dev dependencies — `npm ci --omit=dev`, a production Docker image —
  fails with "Module not found" for a package that is plainly in package.json.
  `npm run check:deps` enforces this; run it with `typecheck` and `lint`.
- **Testing:** Vitest for `lib/*` engines, Playwright for module flows. Fixtures in
  `fixtures/` (small IFC4 / IFC4X3 / BCF 3.0 / IDS 1.0 + the buildingSMART IDS
  test suite). Signing tests run against SoftHSM2; only the real-card round-trip
  is manual.
- **Headers:** nginx sends COOP/COEP when the WASM workers need SharedArrayBuffer,
  plus the CSP. Keep `nginx/nginx.conf` and any `proxy.ts` header logic in sync.

---

## 8. BCF

Read `docs/adr/005-bcf-implementation.md` before touching `lib/bcf/`. We do not
use `@ifc-lite/bcf` — its reader is regex-based and silently drops every label
from a BCF 3.0 file.

- **Everything is normalised to BCF 3.0 on import.** 2.1 is upgraded in
  `parse.ts`; nothing downstream branches on version. `BcfFile.sourceVersion`
  is for the UI to report, not for logic to switch on.
- **Detect the shape, do not trust `bcf.version`.** Files in the wild are
  mislabelled, and a 3.0 file read as 2.1 loses data silently.
- **The writer is validated against the vendored XSDs** in
  `lib/bcf/schema/` (regenerate with `npm run schema:bcf`). Things the schema
  requires that the domain model treats as optional: `TopicType`,
  `TopicStatus`, `Title`, `CreationDate`, `CreationAuthor`, a camera on every
  viewpoint, and a positive `AspectRatio` on every camera. Empty elements are
  invalid — omit them.
- **BCF GUIDs are lowercase hex UUIDs.** `serialize.ts` routes every GUID
  through one `GuidMap` so a substitution cannot break a `RelatedTopic` link, a
  comment's viewpoint link or a document reference.
- **`DefaultVisibility` inverts the exceptions list.** `false` means *isolate
  these*; `true` means *hide these*. Every "show me just this wall" viewpoint
  in the official test suite uses the first form.
- **Viewpoint coordinates are IFC world metres, Z-up.** The conversion is
  `render = ifcToRender(bcf) − originShift + placement.offset`, and it lives in
  `lib/bcf/viewpoint.ts` — pure, with no store or renderer, so it stays
  testable. `lib/bcf/actions.ts` is the only file that touches the renderer.
- **`?panel=` is controlled, not a default.** The tab follows the query string
  on every change, so `router.push("/viewer?panel=bcf")` from within the viewer
  actually switches panels. With `defaultValue` it only worked as an entry
  point, and "New topic" changed the URL while leaving the tab where it was.
- **`.ifczip` opens like any model.** `lib/viewer/container.ts` unwraps it: an
  ifcZIP is a ZIP around the model, and a *signed* one is the same archive with
  `META-INF/` added, which is why both open the same way (ADR 002). The entry's
  bytes are passed on **exactly as stored** — the signature covers those bytes,
  so rewriting them would make a valid container report as tampered.
- **A container with a signature is verified on open** and the result shown on
  the model row. `signature` is `undefined` for a plain `.ifc`, `null` while the
  check runs, and set afterwards; the three states are distinct so the UI never
  labels an ordinary model "unsigned" or a pending check "failed". Valid is not
  trusted, and the badge says so.
- **Fixtures are buildingSMART's own test cases** (`fixtures/bcf/`, 20 archives
  across 2.1 and 3.0). Every one is parsed, rewritten and schema-validated on
  `npm test`. Add to them rather than hand-writing an archive.

---

## 8. BCF

The BCF manager is a **panel in the viewer**. Issues are about elements, and the
two useful actions on a topic — open its viewpoint, raise a new one from the
current view — both need the viewport. `/bcf` redirects to `/viewer?panel=bcf`.

- **The panel is a list *or* a detail**, not both; the header (import, export,
  validate, author) sits above whichever is showing, because actions that
  vanish when you open a topic make it feel like two screens.
- **Importing selects nothing.** It used to select the first topic, which in a
  single-pane panel dropped the user into one issue with no sense of how many
  arrived. `setFile` still selects, because the IDS export hands over a set it
  just generated.
- **A signed issue set is the same zip with `META-INF/` added** (ADR 002), so it
  parses unchanged and the signature is checked on import via
  `lib/signing/summary.ts` — the same summary the model list uses, rendered by
  the same `components/SignatureBadge.tsx`.
- **Anything laid out for a wide page needs a height cap here.** `BulkEditBar`
  stacks its five fields at 19rem and squeezed the topic list to zero height —
  checking a topic made the list vanish.

## 8a. Georeferencing

A **panel in the viewer**, not a page. The question it answers — is this model
in the right place, facing the right way — is a 3D one, so the basemap goes
*under the model* in the viewport instead of beside it as a footprint polygon on
a separate 2D map. `/georef` redirects to `/viewer?panel=georef`.

- **The basemap is off by default.** It is the only part of this application
  that talks to a third party, and a tile request says roughly where the
  building is (ADR 003). The panel says so on screen.
- **`lib/viewer/basemap.ts` drives MapLibre offscreen and uses its canvas as a
  texture**, because the configured provider serves *vector* tiles — geometry,
  not pixels — and texturing a plane needs pixels. This reuses the configured
  style and adds no second origin.
- **The offscreen container must stay inside the viewport.** Parked at
  `left:-9999px` the browser never composites it, so MapLibre never reaches
  "first visually complete render", `load` and `idle` never fire, and the
  capture hangs forever. It sits at the origin, `z-index:-1`, nearly
  transparent — and there is a hard deadline regardless, because a basemap is
  decoration on a check that works without it.
- **Known gap:** in headless Chromium the texture comes out as the style's
  background colour with no features. Not a timing problem — 20 s changed
  nothing. The plane's size and position are verified correct. If it is a
  headless artefact it will look right in a real browser; otherwise the fix is
  to stitch raster tiles directly, which needs a raster source and an ADR 003
  amendment.
- **Two things called "Fit".** The viewport's camera control is "Fit view"; the
  control-point solver is "Fit placement". They share a screen now.
- **`IfcSite.RefElevation` / `IfcMapConversion.OrthogonalHeight` are
  orthometric, not ellipsoidal — Cesium wants the opposite.** IFC's own text
  calls it "orthogonal height relative to the vertical datum specified": height
  above local mean sea level (Cascais, NAP, DHHN92, …), never the WGS84
  ellipsoid. `Cartesian3.fromDegrees` and Cesium World Terrain both measure
  height above the ellipsoid, and the two surfaces are tens of metres apart on
  land — +53 m for mainland Portugal. Feed one straight into the other and
  horizontal placement is exactly right while the model floats or sinks
  relative to real terrain, which reads as "georeferencing is broken" when
  only the vertical axis is. `lib/georef/geoid.ts` converts with a bundled 1°
  EGM96 grid (resampled from NGA's public-domain 15' `WW15MGH.GRD`, so every
  point is a real computed sample) before `lib/viewer/globe.ts` hands a height
  to Cesium; nothing else in the georef pipeline needs the correction; because
  writing it back to the file, or to CityGML/GeoPackage, should keep the
  file's own declared datum, not silently reinterpret it.
- **Grid north and true north are not the same axis, and the globe assumes
  true north.** `lib/viewer/federation.ts` rotates a georeferenced model's
  render geometry by `-gridRotationAngle` so its local X aligns with the
  projected CRS's **grid** north — needed so several federated models, each
  declaring a different grid rotation, land in one shared frame. But
  `lib/viewer/globe.ts`'s `RENDER_TO_ENU` assumes the render frame's −Z is
  **true** north when it anchors Cesium's camera. The two only coincide on a
  CRS's central meridian; everywhere else they differ by the grid convergence
  γ, which reads as "the horizontal position is slightly off" rather than an
  obviously broken rotation — unlike the height bug above, this one is subtle
  by nature (fractions of a degree for most sites, more off a central
  meridian or for an oblique projection like Krovák). `gridConvergence` in
  `lib/georef/transform.ts` measures γ the same way a compass bearing is
  measured — step along `+northing` in the projected CRS, unproject both
  ends, read the true bearing of that step — rather than a closed-form
  formula that would need reproducing per projection. `GeorefPanel` computes
  it once per anchor and threads it through `GlobeControls` →
  `Renderer#setGlobe` → `Globe#sync`/`Globe#sampleDepthProxy` as
  `northCorrection`, an extra yaw applied before the fixed ENU rotation.

## 8b. The basemap and context models

- **MapLibre's worker URL is wrong under every bundler.** It derives it from
  `import.meta.url`; Turbopack inlines the library into a chunk, so the
  `https:` guard fails, `defaultWorkerUrl()` returns `""`, and `new Worker("")`
  loads **the page's own HTML** as the worker. Nothing reports it — no error
  event, no console message, no failed request. The style, sprite and source
  TileJSON all download, then the map sits for ever with `isStyleLoaded()`
  false, **not one tile requested**, and a texture that is a single flat colour.
  `scripts/copy-maplibre-worker.mts` + `lib/viewer/maplibre-worker.ts` fix it;
  call `ensureMaplibreWorker()` before constructing any `Map`.
- **`NEXT_PUBLIC_*` is inlined at build time.** The map vars lived only in the
  repo-root `.env.dev`, which docker compose reads at *runtime* and Next never
  sees, and `Dockerfile.prod` had no `ARG` for the style URL at all — so the
  basemap was absent from every built image while working in the dev container.
  Anything `NEXT_PUBLIC_` needs an `ARG`/`ENV` pair in `Dockerfile.prod` **and**
  an entry under `build.args` in `docker-compose.yml`.
- **Counting requests is not evidence the map drew.** The old test classified
  the source TileJSON (`/planet`) as a tile, so it reported "tiles: 1" and
  passed while nothing was ever fetched. Assert on **pixels** — see
  `data-ground-colours` — and on glyph requests, which only happen once the
  worker is alive.
- **The basemap follows the camera; it is not sized from the model.**
  `renderer.getGroundView()` gives the ground the camera can see and the texture
  covers that, so there is no visible edge at any zoom. A model-sized square was
  a rug: zoom out and its border is on screen with nothing beyond it. Debounce
  on OrbitControls' `change` **and** `end` — `end` never fires for wheel zoom —
  and quantise the extent for the query key, or every camera nudge renders a new
  MapLibre instance.
- **Size the basemap from the camera's pitch, not just its distance.** Looking
  down, the visible ground is the frustum cross-section at the target; looking
  along the horizon it is a trapezoid running to the horizon, and a square sized
  for the overhead case leaves the map covering a patch in the middle of the
  screen. `groundExtent()` in `lib/viewer/basemap.ts` is pure and unit-tested
  precisely because this failure is invisible in a screenshot of anything else.
  It is still a mitigation: **one texture stretched over the whole view will
  always change resolution as the view changes.** The real fix is a grid of
  fixed web-mercator tiles, which is not built.
- **A blob URL is a resource, so create and revoke it in one effect.** Creating
  it in a `useMemo` and revoking it in an effect's cleanup looks equivalent and
  is not: React runs effects twice in development — setup, cleanup, setup — so
  the cleanup released the URL while the memo, dependencies unchanged, kept
  handing back the dead one. Every BCF snapshot failed with
  `net::ERR_FILE_NOT_FOUND`, in development only. A memo is a cache React may
  discard and recompute; a lifetime belongs to an effect.
  `lib/bcf/__tests__/use-snapshot-url.test.tsx` mounts under `StrictMode` and
  fails against the old shape.
- **The globe cannot occlude the model by itself.** Two WebGL canvases are
  composited by the browser, which blends by alpha and knows nothing about
  depth, so the model wins every pixel it draws — including where a hillside is
  in front of it. Contexts cannot share a depth buffer and reading one back per
  frame would stall the pipeline, so `sampleDepthProxy` builds a coarse mesh in
  the *three.js* scene that writes depth and no colour (`colorWrite: false`).
  It must never paint: it stands in for whatever is drawn on the other canvas,
  and painting would cover it.
- **Occlusion covers 3D Tiles too, not just terrain.** The first version used
  `Cesium.sampleTerrainMostDetailed`, which only ever asks the terrain
  provider — so an OSM-buildings or ion-asset layer, which leaves
  `scene.globe.terrainProvider` as the bare ellipsoid (`setLayer` only assigns
  a real one for `layer.kind === "terrain"`), got no occluder and the model
  always drew in front of a building that should have hidden it.
  `Scene#clampToHeightMostDetailed` reads whatever the scene actually rendered
  at a point — terrain, 3D Tiles, or both — so one code path occludes against
  any layer kind. A sample point over a gap in the layer (a street between two
  OSM buildings) comes back `undefined`; held flat at the anchor's own height
  rather than left as a hole or a spike down to the cast's start point.
- **Assert relief, not existence, on the occluder.** A proxy that is
  accidentally flat occludes nothing and looks perfectly healthy.
- **The model canvas is transparent, so a BCF snapshot must be composited.**
  `alpha: true` is what lets the globe show through on screen, and it makes
  `toDataURL` on the model canvas alone a mostly-transparent PNG whenever the
  world context is on — measured at 2083 of 2304 sampled pixels, which renders
  as blank wherever a snapshot is shown. The two canvases are separate WebGL
  contexts and cannot share a buffer, so `renderer.snapshot()` draws the globe
  under the model. Assert on the **pixels of the stored image**: a fully
  transparent PNG is a perfectly valid `<img>`, so a test that only checks one
  is present passes on a blank snapshot.
- **Anything read back from a canvas needs `preserveDrawingBuffer`.** Both the
  model's renderer and Cesium's widget set it, and for the same reason.
- **A basemap texture carries its own position.** `BasemapTexture.ground` is
  the render-space point it was rendered for, and `setGroundPlane` uses that —
  never the live camera target. While a new texture renders the previous one
  stays on screen, so placing "the current image" at "the current camera" slides
  an old picture to a new position and the map drifts against the model. Extent
  and centre must only ever change together.
- **3D tiles are anchored to the model, not the camera.** The set streams what
  the camera needs by itself; keying it on the camera rebuilds it on every zoom
  and discards everything streamed, which is the stutter it exists to avoid.
  `e2e/tiles3d.spec.ts` counts `root.json` fetches across a camera move.
- **A 3D tile set needs a planet-scale far plane.** A tileset's *root* bounding
  volume covers the earth — in our local frame it is centred ~6 371 km below the
  origin — so a building-scale far plane frustum-culls it before one tile is
  requested. The set authenticates, fetches its root document, and renders
  nothing. `setTiles3D` raises `camera.far` to `EARTH_SCALE_FAR` and restores
  `modelFar` on the way out; `logarithmicDepthBuffer` is on so the model does
  not z-fight itself across that range.
- **`data-tiles-visible` distinguishes "not loaded" from "loaded elsewhere".**
  Both look like an empty viewport, and both look like the feature is broken.
  Zero visible tiles after the set has loaded means traversal is rejecting
  everything.
- **Transform the tile group, never the camera.** ion's tiles are ECEF; moving
  the camera out there puts every model vertex six million metres from the
  origin and float32 makes it shake. `ECEF → invert(ENU at the model) → −90°
  about X`.
- **A rejected ion token is silent.** `TilesRenderer`'s `load-error` does not
  fire for it, so the panel fetches the asset endpoint itself to turn it into a
  message. Treat "nothing appeared and nothing was logged" as the bug.
- **Cesium ion needs two origins in the CSP.** `api.cesium.com` returns the
  asset endpoint; `assets.ion.cesium.com` serves the tiles. Allowing only the
  first authenticates and then loads nothing.
- **"Module not found" for a package that is in package.json means the install
  is stale, not the import.** The dev container keeps `/app/node_modules` as an
  anonymous volume, so it outlives `up --build` and holds whatever was installed
  when the container was first created; adding a dependency on the host leaves
  it with new source and old modules. `docker-compose_dev.yml` now runs
  `npm install` before `next dev`, and `predev`/`prebuild` run
  `scripts/check-installed.mts`, which names the missing package and the command
  to run instead of letting Turbopack point at the import line.
- **Import `3d-tiles-renderer` dynamically**, inside `createIonTiles`. It is a
  large dependency for a feature that is off unless a token is set, and a
  static import puts it in the viewer bundle for everyone.
- **A basemap style in the menu must be an origin in the CSP.** Both come from
  `NEXT_PUBLIC_MAPTILER_KEY` via `lib/viewer/basemap-styles.ts` and `proxy.ts`
  so they cannot drift; a style whose origin is missing fails as `AJAXError:
  Failed to fetch (0)`, which names nothing. Satellite is raster, so it is the
  one style that genuinely needs `img-src` and not only `connect-src`.
- **A context model is not a model.** CityJSON loaded through
  `ContextModel.tsx` goes to `renderer.setContextGeometry`, never
  `setModelGeometry`: it must stay out of the model list, the spatial tree, the
  federation bounds and IDS validation. Someone else's city reported as the
  user's IDS failures is worse than no context at all.
- **Except for measurement, which is the one thing the context mesh is
  allowed to be picked for.** `ViewerRenderer.raycast()` takes an
  `includeContext` flag rather than always including `contextMesh` in its
  target list, so `pick()` (element selection) stays exactly as exclusionary
  as the rule above requires — the context mesh has no expressId, is not an
  element, and must never resolve to one — while `pickPoint()` (the
  measurement tool) opts in. Safe specifically because a `Measurement` is two
  raw points and nothing else (`lib/viewer/store.ts`): it was never going to
  gain a model/expressId reference, so there is no selection-shaped hole to
  put the context model through. "How far is my building from its neighbour"
  needs an answer; "which element did I select" must never be the context.
- **Every context format resolves to `ContextGeometry`.** CityJSON, GeoJSON and
  anything added later produce the same triangle soup in metres about a
  projected origin, built through `GeometryBuilder` — which owns the one
  conversion nobody should re-derive: projected/Z-up to render/Y-up with −Z
  north. Getting that wrong is silent; the geometry renders, on its side.
- **Dispatch on the file's `type` member, not its extension.** CityJSON's
  convention is `.city.json` and half the GeoJSON municipalities publish is
  plain `.json`, so the extension decides nothing.
- **GeoJSON is longitude-then-latitude, and always WGS84.** RFC 7946 §3.1.1 and
  §4. Reversing the axes is silent — the geometry renders, in the Indian Ocean —
  so `geojson.test.ts` pins the projected result to a Porto-shaped extent. A
  file carrying a `crs` member naming anything else is **refused** rather than
  reprojected on a guess.
- **Extrude footprints that carry a height**, preferring an explicit `height`
  over `building:levels`; a storey count is an approximation (3 m each) and is
  treated as one. Turning a flat cadastral layer into massing is the whole
  reason to read it into a 3D scene.
- **CityJSON vertices are quantised integers.** They are meaningless without
  `transform.scale` and `transform.translate`; read raw they look like
  plausible coordinates and are wrong by kilometres. Boundary nesting also
  varies by geometry type (`Solid` has an extra shell level), so `rings()`
  descends to the first numeric array rather than trusting the declared type.
- **A national cadastre is one CityJSON, not one per municipality.** The file
  this reader was built against is 307 MB and ~275 000 buildings — the size a
  province publishes, not a neighbourhood. `JSON.parse` on the whole thing
  builds a JS object for every one of those buildings before a single triangle
  draws, which is what actually hangs the tab; the file just sitting in memory
  as one string is comparatively cheap. `parseCityJsonClipped`
  (`lib/georef/cityjson.ts`) avoids the parse instead of trying to make it
  faster: `topLevelEntries` walks the top-level object as text, `vertices`
  becomes flat typed arrays instead of an array of arrays, and each
  `CityObjects` entry is `JSON.parse`d **one at a time** and discarded
  immediately if it is outside the radius. Both this and the ordinary
  whole-file `parseCityJson` end in the same `buildGeometry` — clipping
  changes what gets read, never how it becomes triangles.
- **Sniff the type without paying for a full parse either.** The original
  reader's format sniff was `JSON.parse(text).type` — fine for a municipal
  file, but on the 307 MB one it silently repeated the exact cost clipping
  exists to avoid, before the reader even got to CityObjects. `sniffJsonType`
  finds `"type"` the same top-level-scan way; correct regardless of key order,
  which matters here specifically because this file's own `"type"` comes
  *after* its 166 MB `CityObjects` value; a scan that only checked the first
  few hundred bytes would never find it.
- **The clip runs in a worker** (`lib/workers/cityjson.worker.ts`), because a
  full scan of a 307 MB file — even the cheap, non-parsing kind — is still
  tens of seconds of CPU-over-the-whole-document, AGENTS.md §7's definition of
  "off the UI thread." `ContextModel` already has the file as a decoded string
  (reading it is how the format sniff works), so that string crosses to the
  worker once rather than being decoded on both sides.
- **The radius filter runs in the file's own CRS, not WGS84.** Reprojecting
  every vertex just to measure a distance would repeat the same "parse
  everything to look at a fraction of it" mistake this feature exists to fix.
  Geographic files (`referenceSystem` EPSG:4326) compare raw degrees against
  the reference point with a local equirectangular approximation; projected
  files convert the reference point into their CRS **once** and compare
  metres directly. Reprojection into the model's own CRS happens only for the
  kept subset, and is skipped entirely when the file is already in that CRS —
  the common case, and why the georef panel's own EPSG shows up with no "not
  reprojected" warning after a clip.

## 8c. Point clouds

`.las .laz .ply .pcd .e57 .pts .xyz` open like a model — "Add models" or a drop —
and are drawn as points. They are listed under the model list, in the Models tab.

- **A point cloud is not a model.** Like the context model it has no expressId, is
  not in the spatial tree, IDS validation, clash detection or the federation
  bounds, and is not pickable. It lives in `lib/viewer/pointcloud-store.ts`, not
  `useViewerStore`, so none of those has to remember to skip it.
  `usePointClouds.ts` is the only place that touches the renderer for them.
- **Decode in a worker, subtract the origin in float64.** Survey coordinates are
  ~10⁵–10⁶ m and float32 keeps seven digits, so a cloud stored raw shimmers by
  centimetres to metres. `lib/pointcloud/decode.ts` takes the origin from the
  file's own extent, subtracts it before narrowing, and returns it so
  `place.ts` can put it back. Never feed raw map coordinates to a `Float32Array`.
- **Thinned, never refused, and it says so.** Past `DEFAULT_MAX_POINTS` (8 M) the
  cloud is thinned evenly and the list shows "N of M points".
- **Two readings of the coordinates, and the file does not say which.** *Map*
  (a LAS from a survey) is placed against the federation's world origin; *model*
  (a scan registered to the building's own grid) is placed with the model, so it
  follows the model's placement, rotation and scale. `suggestFrame` only picks the
  default by magnitude — a local grid can sit 50 km out — so the list lets the
  user choose. A cloud that cannot be placed is drawn at the origin with a
  message, not hidden: a vanished cloud reads as a failed load.
- **Z-up to Y-up happens once, in the decoder** (`render = (x, z, −y)`).
- **Only `lib/pointcloud/` may import `@ifc-lite/pointcloud`** (`eslint.config.mjs`).
  It is a scan decoder, not the IFC engine the adapter in §5 exists to swap.
- **LAZ is read by our own source, not the package's.** The package finds its
  WebAssembly through a Vite-only `?url` import Turbopack cannot build, so
  `laz-perf` is stubbed for it (`next.config.ts`) and `lib/pointcloud/laz.ts`
  loads a build served from `public/laz-perf/` instead — bundled by
  `scripts/copy-cesium-assets.mts`, which `prebuild`/`predev` run. A LAZ that
  will not open on a fresh checkout usually means that script has not run.
- **There is no LAZ fixture** — nothing here can compress one. `POINT_CLOUD_TEST_LAZ`
  points the Vitest and Playwright checks at a real file, and they skip without it.
- **Not built:** picking or measuring on a cloud, streaming/LOD for clouds past the
  point budget, classification colouring, and units other than metres.

## 8d. Notices, attribution and disclaimers

`/about` is where credits, licences and disclaimers live; `/privacy` is where data
flows live. Both are written in `messages/*.json` (no hard-coded prose).

- **Adding a data source or provider means adding its credit in the same change.**
  Row in `app/(home)/about/page.tsx` `DATA` plus `about.data.rows.<key>`, the line in
  `Globe#getAttribution` and, if it needs a link, `lib/viewer/attribution.ts`. ODbL,
  Cesium ion, MapTiler and Google all make visible attribution a condition of use.
- **Adding a dependency that ships to users needs nothing by hand:** the notices file
  (`public/third-party-licenses.txt`) is generated from the installed production
  dependency closure by `scripts/generate-licenses.mts`, run by `prebuild`/`predev`.
  A package it reports as "no licence declared" needs an entry in its `KNOWN` table,
  checked against the package's own repository.
- **MPL-2.0 (`@ifc-lite/*`) is file-level copyleft.** Using the packages unmodified only
  needs the notice and a source link. Patching one of their files means publishing that file.
- **The operator is configuration, not code:** `NEXT_PUBLIC_OPERATOR_NAME`,
  `_OPERATOR_CONTACT` and `_SOURCE_URL` (`config/legal.ts`, `Dockerfile.prod`, compose
  build args). Set them before the app is offered publicly — the About and Privacy
  sections that name the operator only appear when they are set.
- **A valid signature is not a trusted one, and the page must say so.** The notice in
  `sign/verify/page.tsx` shipped hidden once; `config/__tests__/legal.test.ts` guards it.
- **Do not claim legal effect, qualification or endorsement** anywhere in the UI.
  Signing is described as what it proves, not as what it is worth in law.

## 9. IDS validation

Validation is a **panel in the viewer** (`viewer/_components/IdsPanel.tsx`), not
a page. The useful action on a failure is "show me that element", which needs
the viewport beside it. `/ids/validate` redirects to `/viewer?panel=ids` so old
links land on what replaced them. The charts stayed behind in the exported HTML
report, where there is room for them.

A run describes the models that were loaded when it happened, so the panel
clears it when the federation changes — stale results next to a changed model
set are worse than none.


- **Never take a specification's pass/fail straight from the engine.** It
  reports `status: "pass"` for a specification that matched **no entities at
  all** — vacuously true, and read by a coordinator as "the model satisfies
  this". `lib/ids/report.ts` recomputes status from `applicableCount`, and
  `validate-engine.test.ts` pins the discrepancy down.
- **A federation is not a model.** A specification is `not_applicable` only
  when *no* model had an applicable entity; if any model did, the specification
  applies to the project and fails if any of them failed. Otherwise an unloaded
  discipline turns a real failure green.
- **Passing entities are dropped by default** (`includePassingEntities`). A
  large model against a large IDS produces millions of rows nothing renders,
  and holding them is what makes a run run out of memory.
- **Validation runs one model at a time.** Four parallel runs on four cores
  finish together at the end with a frozen progress bar and no cores left for
  the renderer.
- **`isolated` in the viewer store is a single shared slot.** The validator sets
  it on "Show", and BCF sets it on "Open viewpoint". Any component that clears
  it must only clear an isolation *it* set — see the `ownsIsolation` ref in
  `viewer/_components/ClassFilter.tsx`.
- The BCF export builds a `BcfFile` and hands it to `lib/bcf/serialize.ts`; it
  never writes XML itself, so it inherits §8's schema guarantees.

### 9a. bSDD suggestions

The IDS editor offers vocabulary from two sources: the **loaded model** and the
**buildingSMART Data Dictionary** (ADR 009). Rules that are easy to get wrong:

- **bSDD sends no CORS headers.** Measured, both on a `GET` with an `Origin`
  header and on the preflight. It cannot be called from the tab — every request
  goes through `app/api/bsdd/route.ts`, which allow-lists three endpoints and
  400s anything else. Because that proxy is same-origin, `connect-src 'self'`
  covers it and **the CSP does not change**.
- **The model's vocabulary is listed first.** `merge()` in
  `lib/bsdd/suggestions.ts` puts it ahead of bSDD's: a property this model
  demonstrably has beats one a dictionary says it ought to have.
- **Nothing is selected by default, and nothing is fetched until it is.**
  Suggesting IFC property sets to someone working to a national classification
  is worse than suggesting nothing. `e2e/bsdd.spec.ts` asserts that a fresh
  `/ids/create` makes no bSDD request at all.
- **Lookups key on a class the specification already names**, never on
  keystrokes. No stream of partial input leaves the deployment.
- **Every failure is an empty suggestion list.** The editor and the validator
  must keep working with bSDD unreachable; never let a lookup block a save, a
  validation or a render.
- **Never map bSDD's `Real` to `IFCREAL`.** IDS matches a property by its
  measure type, so a wrong `dataType` matches *no* elements — and a
  specification that applies to nothing is reported as a **pass**. bSDD's
  vocabulary is coarse: 110 of `IfcWall`'s 233 properties are `Real`, spanning
  `IfcThermalTransmittanceMeasure`, `IfcPositiveLengthMeasure` and others, and
  which applies is per-property knowledge bSDD does not carry. `idsDataType()`
  maps only `String`/`Boolean`/`Integer`/`Time`; `Real` is deliberately absent
  and the editor explains the gap. A suggestion that is wrong is worse than
  none, because the author stops looking.
- **Fill from bSDD in the edit handler, never in an effect.** An effect that
  refills `dataType` or `uri` whenever the dictionary data is present undoes the
  author every time they clear the field. `onPropertyName` writes only fields
  that are still empty, once, on the edit that names the property; when the
  lookup resolves later the editor offers a button instead of writing.
- **Use the class-scoped property `uri`** (`.../class/IfcWall/prop/Pset_WallCommon/Status`),
  not `propertyUri` (`.../prop/Status`). The facet constrains a property in a
  set on a class, and the dictionary-level URI is true of every class that uses
  it.
