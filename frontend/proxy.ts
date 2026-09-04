import { NextResponse, type NextRequest } from "next/server";

/**
 * Content-Security-Policy, with a per-request nonce.
 *
 * Next 16 renamed `middleware` to `proxy`; the runtime is Node.js and cannot be
 * configured.
 *
 * **Why a nonce and not a static header.** Next injects inline `<script>` tags
 * to bootstrap hydration and stream RSC payloads. A `script-src` without
 * `'nonce-…'` or `'unsafe-inline'` blocks them, and the app silently never
 * hydrates: the server-rendered HTML looks correct, so the failure shows up as
 * "nothing is interactive" rather than an error. Setting the CSP on the
 * *request* headers as well is what lets Next read the nonce and stamp it onto
 * its own scripts.
 *
 * `'strict-dynamic'` then lets those nonced scripts load the chunk graph without
 * every chunk URL being enumerated, while still refusing anything an injection
 * introduces.
 *
 * `connect-src` is the security control that matters most here: it is the
 * complete list of origins this app is physically able to send anything to.
 * Adding one needs an ADR first (AGENTS.md §1). The loopback entries for the
 * signing companion are ADR 007.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";

  const tileOrigin = process.env.NEXT_PUBLIC_TILE_ORIGIN ?? "";
  const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? "";

  /**
   * MapTiler, only when a key is configured.
   *
   * Street, OSM and satellite basemaps from one provider (ADR 003, amended).
   * Absent from the CSP entirely when `NEXT_PUBLIC_MAPTILER_KEY` is unset, so a
   * deployment that has not opted in grants nothing — the styles are not
   * offered in the UI either, and the two are driven by the same variable so
   * they cannot drift apart.
   *
   * Satellite is raster, so its tiles are images: unlike a vector style this
   * genuinely needs `img-src` as well as `connect-src`.
   */
  const maptilerOrigin = process.env.NEXT_PUBLIC_MAPTILER_KEY
    ? "https://api.maptiler.com"
    : "";

  /**
   * Cesium ion 3D tiles, only when a token is configured.
   *
   * Same opt-in shape as MapTiler: no token means these origins are absent from
   * the CSP and the style is absent from the menu, both from this one variable.
   *
   * Two hosts, and both are needed: `api.cesium.com` exchanges the token for an
   * asset endpoint, and that endpoint streams from `assets.ion.cesium.com`.
   * Allowing only the first gives a tileset that authenticates and then loads
   * nothing. The tiles themselves are glTF fetched with `fetch`, so
   * `connect-src` covers them, and their textures arrive inside the glTF
   * rather than as separate image requests — but ion's own attribution
   * *logos* (Google's, Bing's) are plain `<img>` tags loaded straight from
   * `assets.ion.cesium.com`, measured by the CSP violation that motivated
   * this comment: `img-src` needs these origins too, not just `connect-src`.
   */
  const ionOrigins = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN
    ? [
        // Exchanges the token for an asset endpoint.
        "https://api.cesium.com",
        // Streams the tiles that endpoint points at.
        "https://assets.ion.cesium.com",
        // Cesium's default imagery and geocoder assets are served from ion's
        // CDN, and world terrain from its own host.
        "https://assets.cesium.com",
        // Google Photorealistic 3D Tiles, reachable through an ion account.
        "https://tile.googleapis.com",
      ].join(" ")
    : "";

  /**
   * The signing companion, on loopback.
   *
   * A browser cannot reach a smart card, so signing goes through a small local
   * service (ADR 007). Without this the fetch is blocked by our own CSP and the
   * setup page reports the companion as missing while it is plainly running —
   * which is exactly what happened the first time.
   *
   * Loopback only, and both spellings: `localhost` and `127.0.0.1` are distinct
   * origins to a browser. The port is configurable because the companion's is.
   * This grants nothing to the network: no remote host can be named here.
   */
  const companionPort = process.env.NEXT_PUBLIC_COMPANION_PORT ?? "8765";
  const companion = [
    `http://127.0.0.1:${companionPort}`,
    `http://localhost:${companionPort}`,
  ].join(" ");

  const connect = ["'self'", apiOrigin, tileOrigin, maptilerOrigin, ionOrigins, companion]
    .filter(Boolean)
    .join(" ");

  const images = ["'self'", "blob:", "data:", tileOrigin, maptilerOrigin, ionOrigins]
    .filter(Boolean)
    .join(" ");

  const csp = [
    `default-src 'self'`,
    // 'wasm-unsafe-eval' is required by the IFC parser and geometry kernel.
    // In development React also uses eval() to rebuild server-side error stacks;
    // neither React nor Next uses it in production.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${
      isDev ? " 'unsafe-eval'" : ""
    }`,
    // Tailwind and the radix primitives inject styles at runtime.
    `style-src 'self' 'unsafe-inline'`,
    // blob: for the Web Workers and canvas snapshots.
    `worker-src 'self' blob:`,
    // The tile origin is here for *raster* styles only. A vector style fetches
    // everything — tiles, glyphs, and the sprite — with `fetch`, so
    // `connect-src` covers it; that was checked by reverting this line and
    // watching the OpenFreeMap basemap load unchanged. A raster style loads its
    // tiles as ordinary images and would need this. The origin is already
    // trusted for `connect-src`, which is the stronger permission, so granting
    // it costs nothing.
    `img-src ${images}`,
    `font-src 'self' data:`,
    `connect-src ${connect} blob: data:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ]
    .join("; ")
    .replace(/\s{2,}/g, " ")
    .trim();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except Next's own static assets and image optimiser, which are
     * immutable and do not execute scripts. Prefetch requests are excluded so a
     * prefetched RSC payload is not rendered under a nonce it will never reuse.
     */
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
