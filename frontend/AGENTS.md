<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

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
zipped **in the browser**. The app is a Next.js front end, whose own server serves
pages and the explicitly documented service proxies below, and one small backend,
`backend/` (Django + Django Ninja, ADR 016), which only lists and serves the
texture library and the IFC property names in Portuguese (ADR 017). Neither ever receives a model, an issue or a specification.

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
- **CSP forbids third-party origins** other than the configured map tile provider
  (and, on `/human-check` only and only when it is on, Cloudflare Turnstile — ADR 013).
  The texture library is this origin's own `/texture-library/` (ADR 016).
  Default tile provider is self-hosted Protomaps/PMTiles, i.e. same-origin. The
  policy lives in `proxy.ts`, which mints a per-request nonce — Next injects
  inline bootstrap scripts, and a `script-src` without a nonce blocks them, so
  the page renders but **never hydrates**. That failure is silent: the HTML looks
  right and nothing is interactive. If you change the CSP, run
  `npm run test:e2e` — the viewer suite only passes on a hydrated page.
- **Web Workers have their own CSP, and it is narrower** (ADR 015). A worker
  takes its policy from its own script's response, not the page's, and every
  bundled worker starts from `/_next/static/chunks/turbopack-worker-*.js`,
  which `proxy.ts` skips. So `next.config.ts` sets `workerCsp()` from
  `lib/http/csp.ts` on `/_next/static/*`. Browsers ignore it on ordinary
  scripts. In a worker, `connect-src` is `'self'` only. Workers hold whole models, so they get no tile, ion, Turnstile or
  **companion** origin. A worker that needs an origin gets it added there,
  with an ADR. Never add a nonce or `'strict-dynamic'` there: the bootstrap's
  `importScripts` of its own chunks would be refused. `blob:` workers started
  from a worker inherit its policy. Workers under `public/` (Cesium's) go
  through the proxy and get the page's policy. `e2e/worker-csp.spec.ts`
  proves a worker cannot reach a foreign origin or the companion.
- **Every module renders `<LocalOnlyBadge />`** ("Processed locally — nothing
  uploaded"). `/privacy` documents exactly what leaves the device.

### The complete list of things allowed to cross the wire

| What | Where | Why |
|---|---|---|
| bSDD search text and class names (opt-in) | `app/api/bsdd/route.ts`, this app's own server | bSDD sends no CORS headers (ADR 009) |
| Map tiles, 3D tiles | the configured provider (opt-in) | basemap and 3D context |
| WFS/WMS service URL, layer, style and map bounds | user-selected public provider via `/api/ogc` (opt-in) | context features, map images and legends; ADR 010 |
| SHA-256 of a `SignatureValue` + a nonce (opt-in, when a `TSA_URL` is configured) | `app/api/tsa/route.ts`, this app's own server, then the time-stamp authority | RFC 3161 time-stamps send no CORS headers and the paid ones need credentials (ADR 012) |
| The texture library's manifest, then the chosen textures' files by id (while realistic materials is on) | `/texture-library/` on this origin: `backend/` (Django Ninja) for the manifest, nginx for the files | realistic materials in the viewer (ADR 016); chosen in the browser from the model's material names and colours, none of which is sent |
| The IFC property names in the interface's language: the request names the language (`pt-PT`), nothing else (Portuguese only) | `app/api/bsdd/property-names/route.ts`, this app's own server, then bSDD (the IFC dictionary's URI and the language, at most once a day per server) | labels in the properties panel (ADR 017); bSDD sends no CORS headers |
| The Turnstile widget's own traffic, then its one-time token (opt-in, when `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set) | the browser to `challenges.cloudflare.com` on `/human-check` only; the token via `app/api/human-check/route.ts` to Cloudflare's `siteverify` | the human check in front of the site (ADR 013); before the app loads, so no user content exists yet |

There is no account and no project database. The one backend, `backend/`, is
the texture library (ADR 016): read-only for visitors, holding nothing a user
made. Its property-name table (`backend/dictionary/`) is kept but no longer
read by the viewer (ADR 017). Anything else that needs a server — an RFC 3161 timestamp, OCSP/CRL/TSL
fetches for full signature validation, none of which send CORS headers — is a
Next.js route handler like `app/api/bsdd/route.ts`, allow-listed the same way,
not a new service, and not an endpoint on the backend.

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
- [ ] New third-party origin? CSP updated **and** ADR written — and if a
      worker fetches it, `workerCsp` in `lib/http/csp.ts` too.
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
  `next.config.ts`, mirrored by `nginx/nginx.conf` in production. So does
  the workers' CSP on `/_next/static/*` (§1, ADR 015). nginx passes it
  through and must not add one of its own.
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
- **Every tool tab opens on `PanelHeader`** (`viewer/_components/PanelHeader.tsx`):
  the tab's icon and the panel's title, actions on the right, one height (44 px)
  with or without buttons. The icon comes from `tool-tabs.ts`, which the tab bar
  uses too, and the title from `viewer.panelTitles` — so a header always says
  what its tab says. A new panel uses it, empty state included; it does not
  draw its own title row. An icon-only action still needs an `aria-label`: a
  tooltip does not name a button.
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

**What a filter, a quantity, a lens or a clash group may pick is
`placedProducts`** in the adapter — one function, not a walk copied into each.
It is what the model places in its spatial structure: contained elements and
spaces, **and** what IFC 4.3 places another way — elements *referenced* in a
spatial element, non-spatial products aggregated under the project (an
`IfcAlignment`), and the **parts of anything placed**, at any depth (a pier's
column, footing and piles, aggregated into an `IfcElementAssembly` that is the
only thing contained). Counting containment alone made all of those
unselectable while still offering their class — on Viadotto Acerno every column
and all 714 piles. Type objects and the spatial elements themselves stay out.
The Structure tab's tree is the engine's and still lists contained elements
only.
`placed-products.test.ts` on `fixtures/ifc/alignment-referenced-ifc4x3.ifc`
pins both halves.

**An element's PredefinedType is the type's when the type has one**
(`lib/ifc/predefined-type.ts`, buildingSMART's rule): a type's value other
than NOTDEFINED applies to every occurrence and overrides the occurrence's
own; otherwise the occurrence's. USERDEFINED is named by the occurrence's
`ObjectType`, or the type's `ElementType` (`ProcessType`, `ResourceType`).
`ElementInfo.predefinedType` carries the result; the Attributes tab marks one
from the type "from type". Filters, lenses and quantities still read the
occurrence's own value. **IDS validation reads it as ifctester does**
(`ifctesterPredefinedType`, wired into the engine's accessor by
`idsAccessor` in the adapter), which is more lenient: an ObjectType or a
type's ElementType with no PredefinedType counts as user-defined, and a
USERDEFINED type naming nothing falls back to the occurrence.
`lib/ids/__tests__/predefined-type-ifctester.test.ts` holds it to
ifctester's recorded answers on 182 specifications.

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

## 7a. The human check (ADR 013)

Off unless `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set (runtime
settings, read per request). Then `proxy.ts` sends a page request without a
valid `dice_human_pass` cookie to `/human-check`, and refuses an API call with
403; static files, `/human-check`, `/api/human-check` and `/privacy` stay open.
Everything is in `lib/human-check/pass.ts`.

- **The pass is checked locally.** An HMAC of its expiry under the Turnstile
  secret, verified with Web Crypto in the proxy — Cloudflare is asked once, by
  `/api/human-check`, when the widget is solved.
- **The proxy runs on prefetches.** The matcher used to skip them; with a gate,
  that would let a `Purpose: prefetch` header past it. They are gated, then
  left without a nonce as before.
- **Next will not send a relative `Location` from the proxy** ("Invalid URL",
  a 500); redirect to an absolute URL, which Next itself writes back as relative
  when it is same-origin.
- **Compare a request's `Origin` with its `Host`, not `request.nextUrl.origin`**
  (`lib/http/same-origin.ts`): the latter is Next's own listening address
  (`localhost:3000`), so the old check refused every real browser on another
  address — `/api/tsa` had the same bug.
- **Testing:** `e2e/human-check.spec.ts` starts its own `next start` with
  Cloudflare's test keys; the main test server runs without the check.

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
- **"Update" replaces a viewpoint in place** (`updateViewpoint`): a new camera,
  visibility, planes and snapshot under the same guid and file name, so a
  comment linked to it still is. The toast offers Undo.
- **Snapshot annotations are baked into the PNG and kept inside it**
  (`lib/bcf/annotations.ts`, `AnnotationEditor.tsx`). BCF has no vector markup
  for a snapshot, so the annotated image *is* the snapshot every other tool
  shows; the clean image and the shapes ride along in a private ancillary chunk
  (`dcAn`), which PNG readers skip. The archive keeps exactly its usual files,
  and the drawing survives the draft, project folders and an export read back.
  The chunk is untrusted (schema-checked). Shapes are fractions of the image,
  widths per 1000 px of height, so "Update" redraws them on a new capture of
  any size. Preview and saved image use the same `drawAnnotations`.
- **A picture from the computer is re-drawn as a PNG** (`lib/bcf/snapshot-file.ts`,
  `usePictureFile.tsx`): at most 1500 px on its longest side, white behind any
  transparency, EXIF dropped (a phone photo's location stays on the machine).
  "Add picture" saves the **viewer's current view with it**, exactly as Capture
  does (`captureViewpoint`, the picture in place of the render); only with no
  model loaded — an empty scene's camera means nothing — is it a
  **picture-only viewpoint** (no camera, components or planes). "Replace" on a
  card swaps the snapshot and drops its annotations. A picture-only viewpoint is written **without a `.bcfv`** — the markup's
  `<Viewpoint>` is optional, but a `.bcfv` must have a camera, and the default
  one the writer invents would fly the reader to the origin. The reader takes a
  markup entry with a snapshot and no `<Viewpoint>` as that, with no "missing"
  note. "Open viewpoint" is disabled for it (`hasViewToRestore`).
- **The PDF report** (`lib/bcf/pdf-report.ts`, the panel's file icon) covers the
  **checked topics when any are**, else what the list shows (every topic unless
  a filter is on), in the list's order; the cover says which. pdfmake and its
  fonts load on click, as for the IDS report. `buildBcfReport` is pure — words
  through `t`, snapshots as data URLs — and `report-images.ts` redraws each
  snapshot as a JPEG (≤1400 px) first: a full-viewport PNG per viewpoint made
  PDFs of tens of MB, pdfmake reads only some PNGs, and a snapshot the browser
  cannot decode costs its picture, not the report. A row of two viewpoints is
  wrapped in one unbreakable stack: unbreakable *columns* split across a page.
- **Anything laid out for a wide page needs a height cap here.** `BulkEditBar`
  stacks its five fields at 19rem and squeezed the topic list to zero height —
  checking a topic made the list vanish.

## 8a. Georeferencing

A **panel in the viewer**, not a page. The question it answers — is this model
in the right place, facing the right way — is a 3D one, so the basemap goes
*under the model* in the viewport instead of beside it as a footprint polygon on
a separate 2D map. `/georef` redirects to `/viewer?panel=georef`.

- **Geo and GIS are separate tabs.** Geo (globe icon) holds Report, Place and
  Points; GIS (map-pinned icon) holds world context and context models, including
  WFS/WMS. `GeorefPanels` computes the shared placement once and keeps both tab
  contents mounted. Do not reseed the draft, cancel a download or dispose context
  when switching tabs. Project restores place context through GIS.

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
  formula that would need reproducing per projection. `GeorefPanels` computes
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
- **The map under the terrain is Google Maps 2D, through Cesium ion**
  (`GOOGLE_2D_ASSETS` in `lib/viewer/globe-layers.ts`, `Globe#setImagery`;
  ADR 003, amended 2026-11-04). ion proxies the tiles through
  `assets.ion.cesium.com/proxy/<asset>`, so the ion origins already in the CSP
  cover it and no Google origin is added; MapTiler, its key and its CSP origin
  are gone. The choice (road map, satellite, satellite with labels, none) is
  separate from the 3D layer, saved in projects (`viewer.globe.imagery`, absent
  = road map), and the map is hidden under Google Photorealistic, which covers
  the ground itself. Google's terms want its logo and data credit beside the
  tiles: `GlobeGoogleLogo` puts the logo on the map (ion serves a white one,
  invisible on the panel), and `getAttribution` asks Google's viewport endpoint
  for the credit of the area in view — the provider's own credits are for the
  whole planet and over satellite name every supplier in the world.
- **A context model is not a model.** CityJSON loaded through
  `ContextModel.tsx` goes to `renderer.setContextGeometry`, never
  `setModelGeometry`: it must stay out of the model list, the spatial tree, the
  federation bounds and IDS validation. Someone else's city reported as the
  user's IDS failures is worse than no context at all.
- **Context metadata inspection is separate from IFC selection.**
  `pickInspectable()` includes context and returns a feature index rather than
  an expressId. `context-model-store` owns that selection; `PropertyPanel`
  displays source attributes without querying the IFC adapter. Selecting an
  IFC element clears context selection, and hiding/replacing/removing context
  clears its inspector. `pick()` remains IFC-only for tools that need an entity
  reference; `pickPoint()` includes context for measurements and orbit pivots.
- **Keep feature metadata and triangle ranges through every reader and worker.**
  `ContextGeometry.features` holds source IDs/attributes and `featureRanges`
  maps source triangle indices to features. Several surfaces may share one
  feature; highlight them together. Coplanar map hits prefer later triangles,
  matching layer draw order. Never invent an IFC reference for a context feature.
- **Context appearance belongs to `context-model-store` and the project.**
  `appearance` contains its edge toggle/width, property colour overrides and
  hidden value keys. Hidden values stay in the legend and are saved with the
  project. Filtering updates draw indices, so context inspection resolves the
  original triangle from the hit's first vertex, not its compacted `faceIndex`.
  Missing appearance fields in old projects receive defaults. Switching Geo tabs
  must not remove styling; `ViewerCanvas` synchronizes it independently.
- **Context edges use the IFC surface shader, with masks built in a worker.**
  `context-edges-client` copies positions before transfer; feature IDs partition
  adjacency so neighbouring coplanar parcels retain their border while triangles
  within a feature do not show their diagonals. Keep source colours immutable:
  selection restores the current property colours, not the original palette.
- **Every context format resolves to `ContextGeometry`.** CityJSON, GeoJSON and
  anything added later produce the same triangle soup in metres about a
  projected origin, built through `GeometryBuilder` — which owns the one
  conversion nobody should re-derive: projected/Z-up to render/Y-up with −Z
  north. Getting that wrong is silent; the geometry renders, on its side.
- **Context placement includes the complete IFC group transform.**
  `context-placement.ts` converts the projected origin to IFC metres, subtracts
  the render-frame RTC shift, then applies the group's rotation, scale and
  offset. Map-space vertex deltas need the corresponding net rotation/scale.
  Applying only the offset misplaces rotated models and large WFS polygons;
  WFS BBOX filtering returns complete features, whose origin can be far away.
  Placement changes update the mesh transform without rebuilding its buffers.
- **GML surfaces need planar polygon triangulation, not fans.** Concave roofs
  otherwise overlap neighbouring buildings. `polygonTriangles` projects onto
  the dominant plane so vertical walls survive, and triangulates the exterior
  with all holes. The large GML reader retains polygon identity across chunks
  and clips the exterior and holes together; never fill each `posList` alone.
- **WFS/WMS services are explicit reads, saved as local snapshots.** Capability
  files only populate the layer picker; they never initiate a request. WFS
  features keep metadata/colouring, WMS images use a projected textured grid.
  Reopening projects must not contact their source service. `/api/ogc` permits
  only bounded public GetCapabilities/GetFeature/GetMap/GetLegendGraphic downloads
  and PNG/JPEG legend files: no payloads,
  redirects, credentials or private network destinations. Keep the pinned DNS
  lookup, response limits and visible attribution when changing this path.
- **WMS legends belong to the loaded map snapshot.** Discover them from the
  selected/inherited style or advertised GetLegendGraphic operation; fetch only
  on explicit layer load, using the same style as GetMap. Keep the legend blob
  in `.context-map` for offline restore, and never reuse a previous layer's
  legend. Optional legend failures must not block map loading. Only PNG/JPEG
  is accepted, with byte and decoded-size limits; blob URLs are revoked when
  their image unmounts. Static legend downloads use `legend=1` on `/api/ogc`
  and allow only raster file paths/provider keys, with the same DNS/TLS checks.
- **GIS area checks are horizontal and independent of display filters.**
  `area-check.ts` compares the selected Geo model's projected horizontal bounds
  against source polygon triangles, preserving holes and ignoring elevation.
  `ContextFeatureRange.area: false` marks ribbons/markers made from lines or
  points; every reader must preserve that distinction, including mixed geometry.
  CityJSON triangulates whole surfaces with holes (across Solid/MultiSurface
  nesting); filling each ring separately would turn courtyards into matches.
  The worker receives a copy of positions, never detaching the displayed mesh.
  One explicit WFS action queries all advertised layers around the full model
  footprint, using existing bounded public requests. Errors/truncated results
  are reported per layer, never silently treated as non-matches; cancellation
  leaves pending layers explicit. Local checks cover all loaded layers, including
  hidden colours, and state their loaded-extent scope. Reports are dated snapshots
  in Properties, separate from feature selection, exported as UTF-8 CSV with
  metadata and formula-safe cells. They are not persisted in project files.
  Clicking a match reuses its checked WFS snapshot or loaded geometry/file,
  reveals its layer and colour category, selects its original feature index,
  and frames it from above while keeping the report open. Never refetch on a
  report click or resolve the feature by a potentially duplicate ID. Layer
  isolation lives in context appearance (and projects), alongside colour filters;
  preserve original triangle indices for picking and offer Show all layers.
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

GeoPackage context is read by `geopackage.worker.ts`. Resolve the geometry
column's SRS through `gpkg_spatial_ref_sys`; its ID need not equal the EPSG
authority code. Clip triangles and curve segments before reprojection so a
global sea polygon never feeds its faraway corners to a local engineering CRS.
`vector-context.ts` preserves concave outlines and holes; do not replace it with
a triangle fan. QGIS compound circular curves are geometry, not text labels.

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
- **E57 poses may omit an identity rotation or zero translation.** The 0.12
  reader drops the entire pose unless both exist. `lib/pointcloud/e57.ts`
  supplies the missing identity component in a private Blob view, preserving
  binary offsets and the original file. Never add one translation to the whole
  cloud: each scan has its own pose. `open().bbox` is also a placeholder zero
  box for E57, so probe a decoded packet to choose the float64 subtraction
  origin. Survey clouds retain the map-frame suggestion even before an IFC
  loads, so their alignment does not depend on load order.
- **Only `lib/pointcloud/` may import `@ifc-lite/pointcloud`** (`eslint.config.mjs`).
  It is a scan decoder, not the IFC engine the adapter in §5 exists to swap.
- **LAZ is read by our own source, not the package's.** The package finds its
  WebAssembly through a Vite-only `?url` import Turbopack cannot build, so
  `laz-perf` is stubbed for it (`next.config.ts`) and `lib/pointcloud/laz.ts`
  loads a build served from `public/laz-perf/` instead — bundled by
  `scripts/copy-cesium-assets.mts`, which `prebuild`/`predev` run. A LAZ that
  will not open on a fresh checkout usually means that script has not run.
- **Edge shading (eye-dome lighting) is on by default**, as on ifclite.com, and
  points start at 4 px. A scan has no normals to light, so `point-edl.ts` shades
  by depth instead (Potree's formula): the clouds are drawn alone into an
  offscreen target on `POINT_CLOUD_EDL_LAYER`, then a full-screen quad in the
  main scene draws them back shaded and **writes their depth with
  `gl_FragDepth`** — the depth buffer is logarithmic, and the target holds the
  same encoding, so the model still hides a cloud behind it.
  `e2e/pointcloud.spec.ts` fails if that depth write is lost (the cloud then
  paints over the wall: ~43 000 changed pixels instead of ~2 800 edge pixels).
  Snapshots render through the same `renderFrame`. On a sparse cloud every point
  is an island and gets its own outline; that is EDL, not a bug.
- **There is no LAZ fixture** — nothing here can compress one. `POINT_CLOUD_TEST_LAZ`
  points the Vitest and Playwright checks at a real file, and they skip without it.
- **Measuring picks scan points; selecting never does.** A cloud is still not an
  element, so `pick()` ignores it, but `pickPoint()` (the measuring tools) takes
  the frontmost point within a few pixels of the cursor when it is nearer than
  any surface. Pointer moves pick, and a cloud can hold 8 M points, so each cloud
  gets a uniform grid the first time it is picked (`point-pick.ts`) and a pick
  walks the ray through it; `point-pick.test.ts` holds it to a brute-force
  search. Section planes clip clouds and the context model, and both tools are
  enabled with only a cloud or a context model open; the section range comes
  from `scene-bounds.ts` (models ∪ clouds ∪ context), never from the federation
  bounds, which stay the models alone.
- **Not built:** streaming/LOD for clouds past the point budget, classification
  colouring, and units other than metres.

## 8c-bis. Project folders

"Project" in the viewer header saves the session as a folder — the files the user
opened (`models/`, `pointclouds/`, `context/`, `ids/`, `bcf/`), the quantity list
and clash matrix as Excel workbooks (`quantities/quantities.xlsx`,
`clash/clash-matrix.xlsx`), and a `project.json` that points to each file and holds
the rest — and loads one back (`lib/project/`). It is written to and
read from the user's own disk; nothing crosses the network, so §1 is unchanged.
**Save and Restore (`WorkspaceActions`) are the same project, kept in the
browser** (`lib/viewer/workspace.ts`): the folder goes to OPFS
(`workspaces/project/`) instead of a folder the user picks, and Restore opens it
through the same `useProjectLoader` as "Load project folder" — same dialog, same
consent for the globe, same report — so the two cannot disagree about what a
session is. A file the browser can reopen itself (opened through "Add models"
with the File System Access API) is kept as a handle in IndexedDB, keyed
`project:<path>`, not copied; anything else is copied in, so a big dropped
federation costs browser storage (a quota error says to use a project folder).
Save is disabled with nothing open, or it would replace the kept session with an
empty one. The first workspace format (`workspaces/current` + handles keyed
`index:name`) is still read, as a project of models and a camera.

- **Chromium writes a real folder; Firefox and Safari get a `.zip` of the same
  folder.** Only Chromium has `showDirectoryPicker`. Loading takes a folder
  (`<input webkitdirectory>`, every browser) or the `.zip`.
- **The quantity list and the clash matrix live only in their workbooks**, the
  same files the panels import and export, so a project can be edited in Excel
  and loaded back. That makes those readers part of the save format: they must
  give back exactly what was written. Lists are one value per line (a single
  value holding `,` `;` or ` / ` gets a trailing line break to say so), a
  formula's alias is written whenever it could not be re-derived, and clash
  filters are matched to groups by position. The round-trip tests in
  `quantity-workbook.test.ts` and `clash/__tests__/workbook.test.ts` pin this.
- **Clash detection classifies the open models by discipline**
  (`matrix.modelDisciplines`, by model *name* — ids are per load; the workbook's
  `Models` sheet). A group with a discipline picks only from models of that
  discipline, compared ignoring case (`disciplineAllows`); an unclassified model
  is tested by every group, so classifying nothing changes nothing. Loading the
  template, or importing a workbook without a `Models` sheet, keeps the
  classification: it describes the models, not the matrix. `settings.ignoreSameDiscipline` (Matrix tab; the General sheet's "Ignore in the Same Discipline" row, absent from Solibri's, reads as off) skips a pair whose two models share a discipline — including two elements of one classified model; unclassified models are never skipped. The engine compares `ClashElementGeometry.discipline`, filled by `run.ts` with `disciplineKey`.
- **The quantity list is a hierarchy** (`lib/spreadsheets/quantity-hierarchy.ts`):
  each line has a `level` (1–9, the workbook's **Level** column; absent reads as
  1), and order says what is under what. A line with **no filter and no
  quantity** is a grouping line — a heading, never run, skipped by Run all,
  written as level, code and description only. The reader keeps such rows only
  with a description (notes under a table stay out), still drops rows that
  filter but measure nothing (they would count every match), and refuses a
  sheet of headings alone. "New" places its line after the selected line's
  branch, or as the last child of a selected grouping line. Selecting a grouping
  line lists the elements of every measured line under it (`linesUnder`,
  `elementsUnder`), each once, with the lines that select it — running, on
  selection, only the lines under it that have no result yet.
- **The MQT default template is a real Excel asset**,
  `public/templates/mqt-default.xlsx`. Its `Quantities` sheet owns the starter
  queries, with `Description` and `Description (PT)` for both languages. Keep
  its codes unique and stable: the Use default template action uses them as
  persistent IDs. Like an Excel import, it **replaces** the open list
  (`replaceList`), with the in-list Undo bar bringing the previous list back —
  it never appends to it.
  Load it through the ordinary workbook parser; never duplicate its query
  definitions in application code. Base quantities must exist in the IFC and
  unit labels do not convert values. Tests import the shipped file and run a
  template query against a real IFC fixture.
- **The `.zip` is written and read by `lib/project/zip.ts`, not fflate's streaming
  `Zip`/`Unzip`.** A streaming writer cannot put an entry's size first, and for a
  stored entry a streaming reader then finds its end by looking for the next
  signature — which the `.xlsx` and `.bcf` *inside* the project supply. Ours
  writes sizes and CRCs up front, reads through the central directory, and builds
  the archive from the original Blobs so nothing is copied into memory.
- **`project.json` is untrusted input.** Every field goes through the zod schema
  in `manifest.ts` and a bad one is refused, naming its path, *before* the open
  session is closed. Paths are only looked up among the picked folder's files.
- **Model order is saved and restored exactly.** The world origin comes from the
  first georeferenced model, and section planes and measurements are stored in
  render space measured from it. Models load in parallel and are then put back in
  order with `reorderModels`; if the origin still differs, the restore says so.
- **Elements are `{ model: index, expressId }`, never a model id** — ids are minted
  per load. The folder carries the exact bytes, so express ids come back the same.
- **Restored measurement and plane ids are re-minted** (`restored-…`): the store's
  counters restart at 1, and a saved `section-1` would collide with the next one.
- **The BCF panel and the IDS editor reload their OPFS drafts on mount**, so a
  restore writes the drafts too; otherwise the old topics come back the first time
  the BCF tab opens.
- **The context model and the 3D world context are placed through the Geo
  panel**, which is what works out where the model sits on the earth. The restore
  leaves each `pending` in its store (`context-model-store`, `globe-store`), opens
  the GIS tab until both are placed, then opens the saved tab. Both stay when the
  tab closes.
- **Work that a project saves must not die with its panel.** The filter ticks
  and the globe used to be cleared when their tab closed, so the two could never
  be on together — a filter set before opening Geo was gone by the time the
  project was saved. Now `FacetFilterSync` (always mounted) applies the ticks and
  `globe-store` owns the globe; each tab shows a dot (`data-filter-active`,
  `data-globe-active`, words in `title`) while its work is on, which is the
  visible control the old clear-on-close rule existed to guarantee. Closing every
  model ends both; leaving the viewer ends the globe.
- **The globe is restored only with consent.** It is the one request that leaves
  for a third party (ADR 003), so a project that had it on always gets the load
  dialog — even with nothing open — with a ticked box naming the layer and who
  receives the location. `restoreProject` turns it on only with `allowGlobe`.
- **State a project saves must be in a store**, not a component: display
  settings, the filter ticks, the context model, the globe and the active tab
  were lifted for this (`display-settings.ts`, `facet-selection-store.ts`,
  `context-model-store.ts`, `globe-store.ts`, `panel-store.ts`). The quantity list
  stays in `localStorage` and is replaced through `replaceStoredQueryList`, which
  tells a mounted panel to reload.
- **Not saved:** the georeferencing draft, IDS/clash/quantity *results* (re-run
  them), and colouring from a validation run.
- **The header's hidden folder and `.zip` inputs come after "Add models"**, so the
  model picker stays the page's first `input[type=file]` — which the e2e suite
  relies on in dozens of places.

## 8c-ter. Lenses

The **Lens** tab saves ways of looking at the model, as on ifclite.com
(`lib/lens/`, `LensPanel.tsx`, applied by the always-mounted `LensSync.tsx`). A
lens is either **rules** — ordered, each an `ElementFilter` (the clash group
editor, reused) with an action: colour, see-through or hide; the first rule an
element matches decides it — or **auto-colour** by one source (class, type,
predefined type, material, group, storey, model, a classification system, a
property), every value its own colour. What nothing matched is ghosted, kept or
hidden. Built-ins live in `presets.ts`; they are shown translated and can only
be duplicated.

- **The workers answer, `evaluate.ts` decides.** Per model, `selectElements`
  per rule or `groupElementsByValue` per source; `evaluateLens` (pure, tested)
  turns that into colours, hidden and translucent sets and a legend. Answers are
  cached on what changes them — a rule's filter, the source — so recolouring,
  renaming or switching a legend entry off asks no worker anything.
- **A lens is a view, not a filter.** It reaches the renderer through
  `lensView` in the viewer store, never `hidden` (the user's own) or
  `colouring` (IDS and BCF's). Colours sit beneath highlights and the
  selection; an isolation still wins over lens hiding and ghosting.
- **Ghosts are a second mesh per batch.** A batch is drawn with one material,
  opaque or translucent, so vertex alpha cannot ghost part of an opaque batch.
  `setEntityVisibility`'s `isTranslucent` moves those elements out of the
  batch's index into its `ghost` mesh, which shares the batch's vertex buffers
  (no copy) and draws them with one translucent, depth-less material. Ghosts are
  not pickable. `data-translucent-entities` reports how many there are.
- **While a lens is edited it is what the viewport shows** (`draft`), so every
  change is a preview; Cancel takes it away.
- **Saved lenses persist in `localStorage`, and travel as a lens list**
  (`lib/lens/file.ts`, `{format: "dice-ifc-lenses", version, activeId,
  lenses}`). One format for both doors: the Lens tab's Download/Upload, and
  `lenses/lenses.json` in a project folder, which `project.json` points to
  (`lenses: {path, activeId}`) like the workbooks. So a predefined set made once
  can be handed round on its own or inside a project. Built-ins are never
  written — every copy has them, and the schema has no `builtin` for a file to
  claim. A lens that fails the schema is left out and counted, not the whole
  list. Upload and restore both **merge** by id — a newer copy of a list
  replaces the old one instead of doubling it, and opening someone's project
  never deletes the user's own lenses. A restore turns the saved lens on only if
  it is there. Projects from before the file carried `lenses.saved` inline;
  still read.

## 8c-quater. Textures: the model's own, then realistic materials (ADRs 014, 016)

Per element: the model's own texture, then a texture from the hosted library
(Display → "Realistic materials"), then its colour.

### The model's own textures

- **The engine reads them; `MeshView` carries them** (`uvs`, `texture`, from
  the adapter's `MeshTextureKeys`). An `IfcImageTexture` is keyed `ref:<id>`;
  pixels in the file (`IfcBlobTexture`, `IfcPixelTexture`) by size and hash, so
  meshes sharing an image share one copy, transferred from the worker once.
- **An `IfcImageTexture` is read only from what the user opened.**
  `container.ts` keeps a `.ifczip`'s images by lower-case file name
  (`imageKey`); a reference is matched by the file name it ends in, whatever its
  path (`textures/x.png`, `C:\…\x.png`, `file:`). A network URL (`http:`,
  `data:`…) is **never fetched** — it comes from the model's contents (§1).
  Either way the element keeps its colour and the canvas says why.
- **Batches split by texture** (`planBatches`), one material with a `map` each.
  `aSurfaceLayer` = `OWN_TEXTURE_LAYER` (−1) draws it, so `repaintColours`
  clears it under a lens, highlight or selection like a realistic texture.
- **Its pixels are drawn as the model's colours are: raw, not decoded from
  sRGB** (`NoColorSpace`), so a texture is as light as a colour of the same
  value. The texture replaces the colour; `IfcSurfaceTexture.Mode` is not read.
- **Always shown, never replaced:** realistic materials skips an element with
  an own texture on any of its parts (`ownTextured`).
- `fixtures/ifc/textured-blob-ifc4.ifc` and `textured-image-ifc4.ifczip` (a
  4×4 red/blue checker, and a second panel linking to a URL) are what
  `e2e/own-textures.spec.ts` counts pixels on.

### Realistic materials: the hosted library

The code is in `lib/viewer/realistic/`, synced by `RealisticMaterials.tsx`; the
library is `backend/` (README, "Texture library").

- **The browser reads the manifest and chooses.** `library.ts` fetches
  `/texture-library/api/manifest` once (schema-checked; a file path must be a
  plain relative path, the files base this origin). The model's names and
  colours never leave; only the chosen textures' files are fetched.
- **Colours come from the manifest**, measured when the library was built
  (`backend/textures/colour.py` mirrors `choose.ts`'s Lab exactly). Nothing is
  measured in the browser; there is no colour cache any more.
- **Words decide the kind, colour decides the texture.** `classify.ts` is an
  ordered word list in English and Portuguese (plus a little Spanish and French).
  Order matters: "tijolo cerâmico" must hit brick before tiles. `NEVER` runs
  first. Add words with a test in `__tests__/classify.test.ts`. The sixteen
  family ids are also `backend/textures/families.py`'s; change both together.
- **One texture per material** (by name, within its family, across every
  model shown). The material asks once, with the colour most of its elements
  show and the kind of surface most of them are (ties to the lowest key), so
  a grey wall and a white slab of the same material draw the same texture. Do
  not key the choice by element colour or IFC class again: the same material
  then got two textures, which read as a bug.
- **2K or 1K, for all layers at once.** Walls and floors are built at 2K and 1K,
  roofs at 1K. Every layer of the array is one size, so 2K is used only when
  `MAX_LARGE_LAYERS` (8) or fewer textures are needed (`layerSize`); past that,
  everything is 1K. A 1K-only texture in a 2K array is scaled up.
- **One `DataArrayTexture` for every model material**, indexed by the
  per-vertex `aSurfaceLayer` attribute (0 = none). That is why there is a
  layer budget (`MAX_SURFACE_LAYERS`). `metres` carries a texture's real size.
- **No UVs in most IFC geometry:** the shader projects triplanar in object
  space. It uses `abs()` of the normal, because IFC normals' sign is unreliable.
- **Relief is a second array beside the colour one** (`uSurfaceDetail`,
  `relief.ts`): normal x/y (OpenGL convention), roughness, occlusion, at half
  the colour's size and never decoded as sRGB (`decodeImage(…, "data")`). Every
  library texture has its `normal` and `arm` maps (ambientCG's DirectX normals
  are flipped at build time); a map that will not load costs the relief, which
  is then estimated from the photograph.
  - Per projection, the image's right and top run along X: +Z, +Y; Y: +X, −Z;
    Z: +X, +Y. Change the colour's projection and these must change with it, or
    bumps turn into dents.
- **Anything that repaints a colour clears the texture under it** in
  `repaintColours` (lens, highlight, selection). A new kind of override must
  do the same, or the texture will hide it.
- **Vertex colours are the IFC values unconverted, and drawn as linear.** The
  shader matches a texture to the colour the plain material would draw (the
  vertex colour, after IFC Lite's finish), not to a decoded copy: decoding it
  again (`pow 2.2`) made every texture darker than the element it replaced.
  Brightness is matched in full, so a textured model is as light as the plain
  one, and the hue `SURFACE_COLOUR_PULL` of the way. `choose.ts` still reads
  them as sRGB, to pick the nearest texture as the eye sees the colour.
- **Off on every visit, saved in projects.** The switch is not remembered in
  the browser (the user's call, 2026-11-10: the viewer opens with the model's
  colours); a project saved with it on turns it on
  (`viewer.realisticMaterials`). `dice-realistic-on`, where it was once
  remembered, is removed on mount.
- **No library is a state, not an error:** a 404 or an unreachable backend is
  `unavailable` and the panel says the server has none; the model keeps its
  colours.

## 8c-quinquies. Light conditions and shadows

Display → Lighting. The rigs are in `lib/viewer/lighting.ts`; the renderer's
`setLighting` applies them, and `display-settings.ts` saves them in projects.

- **`studio` is IFC Lite's own rig and the default.** Its second sun, opposite
  the first, is what keeps faces turned away from being black; keep it there.
  The outdoor presets (clear sky, overcast, golden hour) light by one sun and a
  hemisphere sky instead, so faces away from the sun are darker on purpose.
- **Intensities are IFC Lite's, × π** for three's Lambert, which divides by it.
  Light intensity scales the whole rig.
- **The sun comes from a date and time when the models say where they are**
  (`sun.ts`, kept current by `useSunPlaceSync` in `ViewerCanvas`):
  - Place: the federation's anchor model first. From its `IfcMapConversion`
    (non-placeholder, known CRS), with true north = grid north turned by the
    grid convergence; else from `IfcSite` latitude/longitude, with north from
    `TrueNorth` (IFC's default: the model's +y). Then turned with the model's
    `rotationY`. A CRS outside the bundled list waits for the full EPSG index.
  - Time: the site's wall-clock date and time in an IANA zone (`sun-time.ts`),
    so summer time is right. Position: NOAA's equations (`solarPosition`).
  - Below the horizon the sun fades out over its last 3° and casts nothing;
    only the sky lights the model.
  - With no place, the sun is set by hand (direction and height, round the
    viewer's own axes), and a preset brings its own height. With a place, a
    preset changes only the light, not the sun.
  - Both are saved in projects, so a project keeps its hand-set sun and its
    date and time whichever applies when it is opened.
- **Shadows are the sun's alone, and off by default.** The shadow camera fits
  the visible models every frame (`fitShadow`).
  - The map is redrawn only when what casts shadows changes (`updateShadows`
    compares the sun, models, their indices, the context and the section
    planes with the last draw). Anything new that changes the drawn geometry
    must show up in that state, or its shadows go stale.
  - Glass doesn't cast. `clipShadows` is on, so the sun reaches into a section.
  - No normal bias: IFC normals often point the wrong way, and a bias along one
    pushes a surface into its own shadow. The depth bias is a distance in the
    world, set in the camera's depth units: at least the models' old one, and
    more as a low sun grazes the ground (a texel's width over the sun's slope),
    or the ground shades itself in rings.
- **Shadows reach the GIS data, and its 3D data casts them.** The shadow
  camera is centred on the models and reaches along the sun up to
  `SHADOW_REACH` (1.5 km) to the context model and the globe's surface, so a
  shadow cast onto ground below a model lands (it used to stop at the models'
  own size). Sideways it is as wide as the models, or the context model up to
  `CONTEXT_SHADOW_RADIUS` (250 m, 12 cm a texel), so the context's buildings
  shade the ground, each other and the model; beyond that they cast nothing.
  - The context's vector surfaces receive and cast as any mesh. A map image
    (WMS, rasters) is drawn unlit, so a `ShadowMaterial` overlay on the same
    geometry paints the shadow on it (`createShadowCatcherMaterial`).
  - Terrain and 3D Tiles are Cesium's, on another canvas. **The models' shadow
    on them**: a finer copy of their surface round the models
    (`setGlobeShadowCatcher`, sampled by `sampleDepthProxy`, sized from the
    models' height above the occluder's ground, at most 1 km) paints only
    shadow on this canvas over Cesium's. It is drawn in the opaque pass before
    the coarser occluder, with transparent blending, so the occluder cannot
    hide it. 96 × 96 cells on terrain; 48 × 48 on 3D Tiles, where every
    sample is a ray-pick (96² froze a page), and sampled after the globe is
    ready, not waited for.
  - **Their shadows on the model and the context**: a copy of the depth
    occluder (the visible ground, coarse, for hills) and of the catcher (round
    the models, finer, for the 3D Tiles' buildings) casts into the sun's
    shadow map (`refreshGlobeCasters`, `globe-shadow-caster.ts`). Lowered by
    15% of a cell (at least 1.5 m), or the stand-in shades the ground it lies
    under; with each model's footprint (+2 m) cut out, or today's building in
    the photogrammetry shades the one replacing it; and the coarse copy not
    where the fine one casts (its triangles span valleys as chords). Drawn
    only into the sun's map: its draw range is empty except in
    `onBeforeShadow` for the sun's camera. **Not a layer:** three picks shadow
    casters by the *view* camera's layers, so a caster on its own layer never
    casts.
  - **The catcher must not paint the globe's own shadows** (Cesium does, and
    twice is darker and stops at the catcher's edge). So it reads the
    `catcherSun`'s map alone: the sun again, of no strength, from the same
    place through the same box, whose map the globe's copies are not drawn
    into; it casts only while they do. `shadowFromOneLight` patches a
    `ShadowMaterial` to read one directional shadow: the catcher the last
    (the catcher's sun), a map image's overlay the first (the sun, globe
    included). Three orders shadow-casting lights as they are in the scene,
    so the sun is added before the catcher's sun; a new shadow-casting light
    breaks that.
  - **Cesium's own shadows**: its shadow map, aimed along the viewer's sun
    (`Globe#setSun`: a `DirectionalLight` set from the render-space sun on
    every `sync`; Cesium's real-time sun comes back when shadows go off).
    3D Tiles cast on the terrain and each other. The terrain only receives:
    casting, it shades itself in stripes under a low sun (acne), and Cesium
    has no public bias for it.
  - `e2e/gis-shadows.spec.ts`: a shadow lands on context ground 10 m below
    the model, and a context building 60 m away casts its own (each fails at
    the old camera). `globe-occlusion.spec.ts` (needs the Cesium ion token):
    the model's shadow lands on terrain, and bare terrain stays clean. The
    globe's surface shading the model was checked by hand with a synthetic
    ridge (no test hook reaches the renderer); 3D Tiles casting is untested
    end to end: their occluder's ray-picks take minutes headless.

## 8d. Notices, attribution and disclaimers

`/about` is where credits, licences and disclaimers live; `/privacy` is where data
flows live. Both are written in `messages/*.json` (no hard-coded prose).

- **Adding a data source or provider means adding its credit in the same change.**
  Row in `app/(home)/about/page.tsx` `DATA` plus `about.data.rows.<key>`, the line in
  `Globe#getAttribution` and, if it needs a link, `lib/viewer/attribution.ts`. ODbL,
  Cesium ion and Google (with its logo) make visible attribution a condition of use;
  the texture library's CC0 sources need none, but the view credits Poly Haven and ambientCG
  while their textures are shown (ADR 016).
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
- **The properties panel's IDS tab reads the loaded IDS, not a validation run.**
  `getIdsProperties` checks applicability for only the selected element in its
  worker, then lists required property and attribute facets together. Use the
  IDS accessor's effective values (occurrence overrides type, quantities
  included, measures in SI). Match property names without filtering by the
  required value or datatype: a wrong value must remain visible. Missing and
  empty fields are rows too; repeated requirements share one row. The query
  keys include model, element and IDS, so changing any of them drops old rows.
- **Results are cards, collapsed until opened**, as on ifclite.com
  (`IdsSpecificationCard.tsx`): a specification opens onto its requirements, each
  with its own pass/fail count, and a requirement onto the elements that failed
  it; a "by element" list below gives each element every reason it failed. The
  requirement list comes from the IDS document (`IdsSpecificationResultView.
  requirements`), not from entity results — passing entities are dropped, so a
  requirement nobody failed would otherwise vanish — and "passed" is the
  applicable count minus the failures, since every applicable element is checked
  against every requirement. A specification that fails on its count alone has
  no element to list and gets a row of its own.
- **Validation runs one model at a time.** Four parallel runs on four cores
  finish together at the end with a frozen progress bar and no cores left for
  the renderer.
- **`isolated` in the viewer store is a single shared slot.** The validator sets
  it on "Show", and BCF sets it on "Open viewpoint". Any component that clears
  it must only clear an isolation *it* set — see the `ownsIsolation` ref in
  `viewer/_components/ClassFilter.tsx`.
- **An isolation can show some of its own elements see-through**
  (`isolate(refs, mode, ghosts)`): the quantity results' row click isolates
  the whole result, selects and frames that row's element, and ghosts the rest.
  The ghosts are tied to the `isolated` set they were made with and read through
  `isolationGhostKeys`, so whoever replaces the isolation — BCF, IDS, a filter,
  a restore writing `isolated` directly — never has to clear them.
- The BCF export builds a `BcfFile` and hands it to `lib/bcf/serialize.ts`; it
  never writes XML itself, so it inherits §8's schema guarantees.

### 9a. bSDD suggestions

The IDS editor offers vocabulary from two sources: the **loaded model** and the
**buildingSMART Data Dictionary** (ADR 009). Rules that are easy to get wrong:

- **bSDD sends no CORS headers.** Measured, both on a `GET` with an `Origin`
  header and on the preflight. It cannot be called from the tab — every request
  goes through `app/api/bsdd/route.ts`, which allow-lists five endpoints and
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
- **A property's name in Portuguese is a label, never its name** (ADR 017,
  `lib/bsdd/property-names.ts`, `use-property-names.ts`). The properties panel
  shows bSDD's pt-PT name under the IFC one (`PropertyTable`'s `translation`,
  `data-property-translation`), and its filter finds it; the IFC name is still
  what everything matches on. Only in `Pset_*`/`Qto_*` sets, which IFC
  reserves for buildingSMART's own. The table is keyed by property code, since
  bSDD names a property once for the whole dictionary. It is read live from
  bSDD by `app/api/bsdd/property-names/route.ts` (`lib/bsdd/dictionary-names.ts`):
  the dictionary's listing in English and in pt-PT, three pages each, keeping
  only names that differ from the English and the code. A listing that comes
  back short is an error, not a partial table. Built at most once a day per
  server; a failed rebuild serves the previous table and retries in ten
  minutes, and with no previous table a failure is not cached. With bSDD unreachable there are no labels
  and nothing else changes. Only in Portuguese: in English nothing is asked.
  (`backend/dictionary/`, the admin-updated table, is kept but unused.)
- **Allowed values: the class's, else the property's.** bSDD's IFC 4.3 class
  listing no longer carries `allowedValues` (`IfcWall`'s 233 properties list
  none); the dictionary-level property (`/api/Property/v4`, `.../prop/Status`)
  still does. `useBsddPropertyValues` asks for it only when the class has none,
  for the one property the facet names.
- **Use the class-scoped property `uri`** (`.../class/IfcWall/prop/Pset_WallCommon/Status`),
  not `propertyUri` (`.../prop/Status`). The facet constrains a property in a
  set on a class, and the dictionary-level URI is true of every class that uses
  it.
