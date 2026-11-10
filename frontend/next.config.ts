import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

import { workerCsp } from "./lib/http/csp";

// No i18n routing — the locale comes from a cookie. See i18n/config.ts.
const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
  // Next 16: Turbopack config is top-level, no longer under `experimental`.
  turbopack: {
    resolveAlias: {
      // `@ifc-lite/pointcloud`'s own LAZ reader reaches `laz-perf` through a
      // dynamic import. Turbopack traces the target, and laz-perf's emscripten
      // loader imports the bare WASI specifiers `env` and
      // `wasi_snapshot_preview1`, which are instantiation-time import objects
      // rather than modules, so the build fails. Stubbing the package keeps the
      // loader out of the graph. That reader is never used: `lib/pointcloud/laz.ts`
      // reads .laz files with a copy of laz-perf served from `public/laz-perf/`
      // (`scripts/copy-cesium-assets.mts`). See lib/empty-module.ts.
      "laz-perf": "./lib/empty-module.ts",
      // The deep, Vite-flavoured `?url` import of the wasm asset. Turbopack
      // does not understand `?url` and tries to bundle the .wasm as a module,
      // synthesising an ESM loader with WASI imports it cannot resolve.
      "laz-perf/lib/web/laz-perf.wasm?url": "./lib/empty-module.ts",
      "laz-perf/lib/web/laz-perf.wasm": "./lib/empty-module.ts",
      // `lib/ids/validate.ts` picks the xmllint build at runtime — the Node one
      // when there is no `Worker` (jsdom tests), the browser one otherwise.
      // Turbopack traces both branches, so the Node build drags `worker_threads`
      // into the browser bundle. It is never *executed* there, because a browser
      // always has `Worker`.
      worker_threads: { browser: "./lib/empty-module.ts" },
    },
  },

  // Standalone output ships a traced subset of node_modules instead of the
  // whole tree — but it also makes `next start` a no-op, which breaks local
  // `npm start` and the Playwright web server. So it is opt-in, set only by
  // Dockerfile.prod, which copies .next/standalone and runs server.js directly.
  ...(process.env.BUILD_STANDALONE === "1"
    ? { output: "standalone" as const }
    : {}),

  /**
   * The texture library (ADR 016) lives at `/texture-library/` on this origin.
   * In production nginx sends it to the backend (`backend/`) and serves its
   * files itself; under `next dev` and `next start` this forwards it to
   * `TEXTURE_LIBRARY_ORIGIN` (the backend's `runserver`, by default), so the
   * browser never talks to another origin either way. Unset in production
   * builds, where nginx answers first.
   */
  async rewrites() {
    const origin =
      process.env.TEXTURE_LIBRARY_ORIGIN ??
      (process.env.NODE_ENV === "development" ? "http://127.0.0.1:8000" : "");
    return origin ? [{ source: "/texture-library/:path*", destination: `${origin}/texture-library/:path*` }] : [];
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // The IFC/geometry WASM workers want SharedArrayBuffer, which is
          // gated behind cross-origin isolation. `credentialless` keeps
          // same-origin subresources working without a CORP header on each.
          //
          // Keep in sync with nginx/nginx.conf, which sets the same pair in
          // production — the Next dev server is not in that path.
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },

          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          // Nothing in this app needs a camera, a microphone or a location.
          // The georeferencing module places a *model* on a map; it never asks
          // where the user is.
          {
            key: "Permissions-Policy",
            value:
              "camera=(), microphone=(), geolocation=(), interest-cohort=(), usb=(), serial=()",
          },
        ],
      },
      {
        // The Web Workers' CSP (ADR 015). A dedicated worker takes its policy
        // from its own script's response, not from the page, and every bundled
        // worker starts from `/_next/static/chunks/turbopack-worker-*.js` —
        // which `proxy.ts` skips. Browsers ignore a CSP on an ordinary script
        // response, so on the other chunks this header does nothing; it is set
        // on the whole directory so a renamed bootstrap is still covered.
        // `e2e/worker-csp.spec.ts` proves a worker cannot leave the allow-list.
        source: "/_next/static/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: workerCsp({ isDev: process.env.NODE_ENV === "development" }),
          },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
