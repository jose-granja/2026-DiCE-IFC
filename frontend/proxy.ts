import { NextResponse, type NextRequest } from "next/server";

import {
  CHECK_PATH,
  PASS_COOKIE,
  TURNSTILE_ORIGIN,
  gateFor,
  humanCheckConfig,
  verifyPass,
} from "@/lib/human-check/pass";
import { TEXTURE_LIBRARY_ORIGINS } from "@/lib/http/csp";

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
 *
 * **This is the page's policy only.** A Web Worker takes its policy from its
 * own script's response, and every bundled worker starts from a script under
 * `/_next/static/`, which the matcher below skips. Those get `workerCsp` from
 * `lib/http/csp.ts`, set in `next.config.ts` (ADR 015).
 *
 * **The human check comes first** (ADR 013), when the deployment turned it on:
 * a page request without a valid pass is sent to `/human-check`, an API call
 * is refused. It runs on prefetches too — skipping the proxy for them, as the
 * matcher once did, would let a `Purpose: prefetch` header walk past it.
 */
export async function proxy(request: NextRequest) {
  const humanCheck = humanCheckConfig();
  const { pathname, search } = request.nextUrl;
  if (humanCheck) {
    const gate = gateFor(pathname);
    if (gate && !(await verifyPass(request.cookies.get(PASS_COOKIE)?.value, humanCheck.secretKey))) {
      if (gate === "api") {
        return NextResponse.json(
          { error: "Open the site in a browser and pass the human check first." },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      }
      // On the host the visitor used (nginx passes it through) and the scheme
      // they used: behind a TLS proxy this server itself only ever sees http.
      const target = request.nextUrl.clone();
      target.pathname = CHECK_PATH;
      target.search = `?next=${encodeURIComponent(pathname + search)}`;
      if (request.headers.get("x-forwarded-proto") === "https") target.protocol = "https:";
      const redirect = NextResponse.redirect(target, 307);
      redirect.headers.set("Cache-Control", "no-store");
      return redirect;
    }
  }

  // A prefetched RSC payload is not rendered under a nonce it would never reuse.
  if (
    request.headers.has("next-router-prefetch") ||
    request.headers.get("purpose") === "prefetch"
  ) {
    return NextResponse.next();
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";

  const tileOrigin = process.env.NEXT_PUBLIC_TILE_ORIGIN ?? "";

  /**
   * Cesium ion — terrain, 3D tiles and the Google Maps 2D map, which ion
   * proxies through `assets.ion.cesium.com` — only when a token is configured.
   *
   * No token means these origins are absent from the CSP and the 3D world
   * context is unavailable, both from this one variable.
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

  /**
   * Cloudflare Turnstile, on the check page only and only when it is on: the
   * widget's script (added by our own nonced code, which `'strict-dynamic'`
   * trusts), the frame it runs in, and the calls that frame's parent makes.
   */
  const turnstile = humanCheck && pathname === CHECK_PATH ? TURNSTILE_ORIGIN : "";

  /**
   * The texture libraries for the viewer's realistic materials (ADR 014),
   * listed in `lib/http/csp.ts`.
   *
   * All are read with `fetch` and decoded in the page (or in the
   * texture-colour worker, whose policy is `workerCsp` there), so
   * `connect-src` covers them and `img-src` needs nothing. Only on the viewer,
   * the one page with the switch.
   */
  const textureLibraries = pathname === "/viewer" || pathname.startsWith("/viewer/")
    ? TEXTURE_LIBRARY_ORIGINS.join(" ")
    : "";

  const connect = ["'self'", tileOrigin, ionOrigins, companion, turnstile, textureLibraries]
    .filter(Boolean)
    .join(" ");

  const images = ["'self'", "blob:", "data:", tileOrigin, ionOrigins]
    .filter(Boolean)
    .join(" ");

  const csp = [
    `default-src 'self'`,
    // 'wasm-unsafe-eval' is required by the IFC parser and geometry kernel.
    // In development React also uses eval() to rebuild server-side error stacks;
    // neither React nor Next uses it in production.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${
      isDev ? " 'unsafe-eval'" : ""
    } ${turnstile}`,
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
    `frame-src 'self' ${turnstile}`,
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
     * immutable and need no nonce. The worker scripts among them get their
     * policy from `next.config.ts` instead (ADR 015). Prefetches come through
     * too, for the human check; the proxy itself leaves them without a nonce.
     */
    "/((?!_next/static|_next/image|favicon.ico|favicon.svg).*)",
  ],
};
