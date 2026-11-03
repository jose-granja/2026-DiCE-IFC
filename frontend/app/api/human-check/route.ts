import { NextResponse, type NextRequest } from "next/server";

import { isSameOrigin } from "@/lib/http/same-origin";
import { MAX_TOKEN_LENGTH, PASS_COOKIE, checkToken, humanCheckConfig, issuePass } from "@/lib/human-check/pass";

/**
 * Turns a solved Turnstile widget into a pass (ADR 013).
 *
 * The browser sends the widget's token and nothing else; this checks it with
 * Cloudflare and, if Cloudflare agrees, sets the pass cookie `proxy.ts` looks
 * for. The cookie is HttpOnly, so page scripts cannot read or forge it.
 */

const fail = (error: string, status: number) =>
  NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: NextRequest) {
  const config = humanCheckConfig();
  if (!config) return fail("The human check is not enabled on this deployment.", 404);

  // A page on another site must not be able to mint passes with its own visitors' tokens.
  if (!isSameOrigin(request.headers)) return fail("Cross-origin requests are not accepted.", 403);

  const text = await request.text();
  if (text.length > MAX_TOKEN_LENGTH + 64) return fail("That is not a token.", 413);
  let token = "";
  try {
    token = String((JSON.parse(text) as { token?: unknown }).token ?? "");
  } catch {
    return fail("The request must be JSON.", 400);
  }

  const result = await checkToken(token, config);
  if (!result.ok) {
    return result.reason === "unreachable"
      ? fail("Cloudflare could not be reached to confirm the check.", 502)
      : fail("The check was not accepted.", 403);
  }

  const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  // Behind nginx the request arrives as http; the visitor's own scheme is in the header.
  const secure =
    request.headers.get("x-forwarded-proto") === "https" || request.nextUrl.protocol === "https:";
  response.cookies.set(PASS_COOKIE, await issuePass(config.secretKey, config.passSeconds), {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: config.passSeconds,
  });
  return response;
}
