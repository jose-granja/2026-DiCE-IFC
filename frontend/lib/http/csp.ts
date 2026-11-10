/**
 * Content-Security-Policy pieces shared by the two places that send one:
 *
 * - `proxy.ts`, the **page** policy, minted per request with a nonce;
 * - `next.config.ts`, the **worker** policy, a static header on
 *   `/_next/static/*` (ADR 015).
 *
 * A dedicated Web Worker started from a URL does not inherit the page's
 * policy: it takes the one on its own script's response. Every bundled worker
 * in this app starts from the same Turbopack bootstrap,
 * `/_next/static/chunks/turbopack-worker-<hash>.js`, which the proxy's matcher
 * skips. Without the header below, workers — the code that holds the models,
 * issue sets and signatures — could `fetch` anywhere.
 *
 * No `@/` imports here: `next.config.ts` imports this file, and its loader does
 * not resolve the path alias.
 */

/**
 * The policy for every script under `/_next/static/` — in effect, for the
 * Web Workers, because a browser ignores a CSP header on a classic `<script>`
 * or a module script response and enforces it only on a document or a worker.
 *
 * Narrower than the page's, on purpose (ADR 015):
 * - `connect-src` is `'self'`, nothing else. The map tile and Cesium ion
 *   origins, the signing companion and Turnstile are reached from the page
 *   only; no worker has any reason to call them. (The texture library is this
 *   origin's own, ADR 016, so it needs no entry.)
 * - `script-src 'self' 'wasm-unsafe-eval'`: the bootstrap `importScripts` its
 *   chunks from this origin, and the IFC parser, geometry kernel, xmllint,
 *   SQLite and laz-perf are WebAssembly. No nonce — a worker has no inline
 *   scripts to stamp — and so no `'strict-dynamic'`, which would make the
 *   browser ignore `'self'`. `'unsafe-eval'` only under `next dev`, as on the
 *   page.
 * - `worker-src 'self' blob:`: fflate's async unzip starts nested workers from
 *   `blob:` URLs, and a nested worker inherits this policy.
 * - `default-src 'none'`, so anything not listed — fonts, images, media — is
 *   refused rather than falling back to `'self'`. Directives that only mean
 *   something to a document (`base-uri`, `form-action`, `frame-ancestors`)
 *   are left out.
 */
export function workerCsp({ isDev }: { isDev: boolean }): string {
  return [
    `default-src 'none'`,
    `script-src 'self' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
    `worker-src 'self' blob:`,
    `connect-src 'self' blob: data:`,
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}
