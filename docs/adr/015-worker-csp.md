# ADR 015 — A Content-Security-Policy for the Web Workers

- **Status:** Accepted
- **Date:** 2026-11-06
- **Related:** AGENTS.md §1 (the privacy line), ADR 007 (the companion's loopback origins), ADR 013 (the proxy), ADR 014 (the texture libraries)

## Context

`proxy.ts` mints the page's CSP per request, and AGENTS.md §1 calls its
`connect-src` the complete list of origins the app can send anything to. Its
matcher skips `/_next/static/`, which is right for the page: those files are
immutable and need no nonce.

But a dedicated Web Worker started from a URL does **not** inherit the page's
policy. It is governed by the CSP on its own script's response (CSP 3, "Initialize
a global object's CSP list"; only `blob:`/`data:` workers inherit from their
creator). Measured on a production build (`next build && next start`) by loading
a model in `/viewer` and listing the workers Playwright saw:

- **Every bundled worker starts from the same script**,
  `/_next/static/chunks/turbopack-worker-<hash>.js#params=[…chunk list…]`. That
  bootstrap `importScripts` the worker's chunks. The `new URL("./x.worker.ts",
  import.meta.url)` in `lib/workers/*-client.ts` and `lib/signing/embedded.ts`
  is rewritten to it; the `.ts` copies under `/_next/static/media/` are emitted
  but never run.
- **That response carried no CSP.** A worker could `fetch` any origin. The
  workers are where models, issue sets and signatures are parsed, so the one
  place a leak would matter most was the one place `connect-src` did not reach.
- **fflate's async unzip starts nested workers from `blob:` URLs** inside those
  workers. Those inherit the policy of the worker that made them.
- **Cesium's own workers** (`/cesium/Workers/*`, copied into `public/`) are
  *not* under `/_next/static/`, so the proxy already gives them the page's
  policy for that path. Nothing changes for them here.

## Decision

1. **A static header on `/_next/static/:path*` in `next.config.ts`**, built by
   `workerCsp()` in `lib/http/csp.ts`. Browsers enforce a CSP only on documents
   and workers and ignore it on an ordinary script response, so on the page's
   own chunks it does nothing (the whole suite hydrates with it on). It covers
   the whole directory, not just `turbopack-worker-*.js`: if a future Next
   renames the bootstrap, the header still lands.
2. **The worker policy is narrower than the page's, not a copy of it:**

   ```
   default-src 'none'
   script-src 'self' 'wasm-unsafe-eval'        (+ 'unsafe-eval' under next dev)
   worker-src 'self' blob:
   connect-src 'self' <texture libraries> blob: data:
   upgrade-insecure-requests                   (not under next dev)
   ```

   - **No tile, Cesium ion, companion or Turnstile origins.** Each of those is
     reached from the page only; no bundled worker has a reason to call them.
     The companion matters most: the rule is that it receives a digest and
     nothing else (§1), and the code that holds whole models now cannot reach
     it at all.
   - **The texture libraries are allowed, on every page.** The texture-colour
     worker (ADR 014) fetches the previews it measures. The page allows them
     on `/viewer` only, but a worker's policy is fixed when the worker script
     is served, and that script is the same bootstrap whichever page starts
     it. Only the viewer starts that worker.
   - **No nonce and no `'strict-dynamic'`.** A worker has no inline scripts to
     stamp, and `'strict-dynamic'` would make the browser ignore `'self'`, so
     the bootstrap's `importScripts` of its own chunks would be refused.
   - **`'wasm-unsafe-eval'`** for the IFC parser and geometry kernel, xmllint,
     SQLite and laz-perf, as on the page.
   - **`default-src 'none'`**, so a directive not listed refuses rather than
     falling back to `'self'`.
3. **One list of texture-library origins**, `TEXTURE_LIBRARY_ORIGINS`, used by
   both policies; `lib/http/__tests__/csp.test.ts` holds it equal to
   `POLYHAVEN_ORIGINS` + `INTO360_ORIGIN`.

## Alternatives

- **Copy the page's `connect-src` into the worker policy.** Simpler to explain
  and keeps the two identical, but it grants every worker the companion and the
  tile/ion hosts for no use. Rejected: a worker needing one of them should fail
  loudly and be a decision, not inherit it by default.
- **Run the proxy on the worker bootstrap** (widen the matcher). It would give
  workers the *page's* policy, including `'strict-dynamic'` (which blocks the
  bootstrap's `importScripts`) and a nonce for every static file request, for
  no gain over a static header.
- **One policy per worker.** The URL the server sees is the same bootstrap for
  every worker — the chunk list is in the fragment, which is never sent — so
  the server cannot tell them apart. Per-worker policies would need each worker
  to be its own entry file outside the bundler.

## Consequences

- A new worker that needs a third-party origin fails with a `connect-src`
  violation in that worker until the origin is added to `workerCsp`, with the
  ADR AGENTS.md §1 requires for any new origin.
- `e2e/worker-csp.spec.ts` checks it in a browser. A worker reaches an allowed
  origin, and is refused a foreign one and the companion, each answered by
  `page.route` so that only the policy can make the request fail. A `blob:`
  worker started from inside a worker is refused too. If Next stops sending
  the header on the bootstrap, these tests fail.
- `nginx/nginx.conf` proxies `/_next/static/` to Next unchanged and adds no
  CSP of its own, so production gets the same header.
