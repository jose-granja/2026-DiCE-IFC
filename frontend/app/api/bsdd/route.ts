/**
 * A read-only proxy for the buildingSMART Data Dictionary.
 *
 * **Why a proxy at all:** `api.bsdd.buildingsmart.org` sends no CORS headers —
 * verified, on both a GET with an `Origin` and a preflight — so a browser
 * cannot call it. Something server-side has to.
 *
 * **Why here and not in Django:** this is same-origin, so `connect-src 'self'`
 * already covers it and the CSP needs no third-party entry. It also keeps IDS
 * authoring working when the API container is not running; suggestions are help,
 * not a dependency.
 *
 * **What crosses the wire.** A search term the author typed, and dictionary or
 * class URIs. bSDD sees the query but not who asked — the request comes from
 * the deployment, not the browser. **No model, BCF or IDS content is ever sent**
 * (AGENTS.md §1); the only free text is what someone typed into a search box,
 * and the UI does not search on every keystroke.
 *
 * Reads only. There is no method here but GET, and the upstream path is
 * checked against a list rather than passed through.
 */

import { NextResponse, type NextRequest } from "next/server";

const UPSTREAM = "https://api.bsdd.buildingsmart.org";

/**
 * The endpoints this proxy will forward, and nothing else.
 *
 * Without a list this is an open forwarder for anything under the bSDD host,
 * and a typo in a caller becomes a way to reach an endpoint nobody reviewed.
 */
const ALLOWED = new Set([
  "/api/Dictionary/v1",
  "/api/Class/Search/v1",
  "/api/Class/v1",
  "/api/Class/Properties/v1",
  "/api/Property/v4",
]);

/** bSDD data changes on the order of months; an hour is conservative. */
const CACHE_SECONDS = 3600;

/** Anything longer is not a search term. */
const MAX_QUERY_LENGTH = 200;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const path = searchParams.get("path") ?? "";

  if (!ALLOWED.has(path)) {
    return NextResponse.json(
      { error: `bSDD endpoint "${path}" is not proxied.` },
      { status: 400 },
    );
  }

  if (path === "/api/Class/v1" && searchParams.has("IncludeClassProperties")) {
    return NextResponse.json(
      { error: "Use the dedicated bSDD class-properties endpoint." },
      { status: 400 },
    );
  }

  const upstream = new URL(path, UPSTREAM);
  for (const [key, value] of searchParams) {
    if (key === "path") continue;
    if (value.length > MAX_QUERY_LENGTH) {
      return NextResponse.json(
        { error: "That query is too long to be a search term." },
        { status: 413 },
      );
    }
    upstream.searchParams.set(key, value);
  }

  try {
    const response = await fetch(upstream, {
      headers: { Accept: "application/json" },
      // Next's own fetch cache: identical lookups cost nothing, which matters
      // when several facet editors ask for the same class.
      next: { revalidate: CACHE_SECONDS },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: `bSDD returned ${response.status}.` },
        { status: 502 },
      );
    }

    return NextResponse.json(await response.json(), {
      headers: { "Cache-Control": `private, max-age=${CACHE_SECONDS}` },
    });
  } catch (error) {
    // A dictionary that cannot be reached is a missing suggestion, not a
    // broken editor — the caller degrades rather than failing.
    return NextResponse.json(
      {
        error:
          error instanceof Error && error.name === "TimeoutError"
            ? "bSDD did not respond in time."
            : "bSDD could not be reached.",
      },
      { status: 502 },
    );
  }
}
