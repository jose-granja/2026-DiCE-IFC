/**
 * Whether a request comes from a page on this site.
 *
 * Compared with the host the request was addressed to — what nginx passes on
 * as `Host` and `X-Forwarded-Host` — not with `request.nextUrl.origin`, which
 * Next builds from its own listening address (`localhost:3000`) and so never
 * matches a browser on `127.0.0.1`, a LAN address or the public name. A request
 * with no `Origin` (curl, a same-origin GET) is not a cross-site one.
 */
export function isSameOrigin(headers: Headers): boolean {
  const origin = headers.get("origin");
  if (!origin) return true;
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  try {
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}
