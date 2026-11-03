/**
 * A proxy to one RFC 3161 time-stamp authority.
 *
 * **Why a proxy:** time-stamp authorities send no CORS headers, and the ones that
 * charge per stamp want credentials that must never reach a browser. Something
 * server-side has to ask.
 *
 * **What crosses the wire** (AGENTS.md §1, ADR 012): a SHA-256 hash and a random
 * number, in a request this handler builds itself. The browser sends only the
 * hash, as hex in JSON — it never builds or sends the binary request, so there
 * is nothing here shaped like a file. The hash is of a `SignatureValue`: a
 * signature over digests, which says nothing about what was signed.
 *
 * **Not an open relay.** The authority is fixed by the deployment
 * (`TSA_URL`), never named by the caller, and the caller can say nothing but a
 * 32-byte hash. A time-stamp costs money per stamp and this endpoint is public,
 * so it is also rate-limited per client and refuses other origins.
 *
 * **It never logs a digest.** Nothing here writes one anywhere.
 *
 * Configuration, all server-side and none `NEXT_PUBLIC_`:
 *   TSA_URL, TSA_USERNAME, TSA_PASSWORD (Basic auth, optional), TSA_NAME
 *   (shown to the user), TSA_RATE_LIMIT_PER_HOUR (default 60 per client).
 */

import { NextResponse, type NextRequest } from "next/server";

import { isSameOrigin } from "@/lib/http/same-origin";
import { base64 } from "@/lib/signing/canonical";
import {
  TIMESTAMP_REPLY_TYPE,
  TIMESTAMP_REQUEST_TYPE,
  buildTimestampRequest,
  checkTimestampToken,
  parseTimestampResponse,
  randomNonce,
} from "@/lib/signing/timestamp";

export const dynamic = "force-dynamic";

/** The hash is the only thing a caller may send; anything larger is not a hash. */
const MAX_BODY_BYTES = 256;
const MAX_REPLY_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 15_000;

function settings() {
  const url = (process.env.TSA_URL ?? "").trim();
  return {
    url,
    username: process.env.TSA_USERNAME ?? "",
    password: process.env.TSA_PASSWORD ?? "",
    name: (process.env.TSA_NAME ?? "").trim(),
    perHour: Math.max(1, Number(process.env.TSA_RATE_LIMIT_PER_HOUR ?? 60) || 60),
  };
}

// Per client, in memory. One process is all this deployment is; a cluster would
// want a shared store, and would say so by being a cluster.
const hits = new Map<string, number[]>();

function allowed(client: string, perHour: number, now = Date.now()): boolean {
  const recent = (hits.get(client) ?? []).filter((at) => now - at < 3_600_000);
  if (recent.length >= perHour) {
    hits.set(client, recent);
    return false;
  }
  recent.push(now);
  hits.set(client, recent);
  // Forget clients that stopped, or the map only ever grows.
  if (hits.size > 10_000) {
    for (const [key, times] of hits) if (times.every((at) => now - at >= 3_600_000)) hits.delete(key);
  }
  return true;
}

export async function GET() {
  const { url, name } = settings();
  return NextResponse.json(
    { configured: url !== "", name: url !== "" ? name || undefined : undefined },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const fail = (error: string, status: number) =>
  NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: NextRequest) {
  const { url, username, password, name, perHour } = settings();
  if (!url) return fail("No time-stamp authority is configured for this deployment.", 501);

  // A page on another site must not be able to spend this deployment's stamps.
  if (!isSameOrigin(request.headers)) return fail("Cross-origin requests are not accepted.", 403);

  const client = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
  if (!allowed(client, perHour)) return fail("Too many time-stamp requests; try again later.", 429);

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return fail("That is not a hash.", 413);

  let digestHex = "";
  try {
    digestHex = String((JSON.parse(text) as { digest?: unknown }).digest ?? "");
  } catch {
    return fail("The request must be JSON.", 400);
  }
  if (!/^[0-9a-f]{64}$/i.test(digestHex)) return fail("The digest must be 64 hex characters (SHA-256).", 400);

  const digest = Uint8Array.from(digestHex.match(/../g)!.map((pair) => parseInt(pair, 16)));
  const nonce = randomNonce();

  let reply: Uint8Array;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": TIMESTAMP_REQUEST_TYPE,
        Accept: TIMESTAMP_REPLY_TYPE,
        ...(username
          ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
          : {}),
      },
      body: buildTimestampRequest({ digest, nonce }) as BodyInit,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) return fail(`The time-stamp authority answered ${response.status}.`, 502);

    reply = new Uint8Array(await response.arrayBuffer());
    if (reply.length > MAX_REPLY_BYTES) return fail("The time-stamp authority's answer was too large.", 502);
  } catch {
    return fail("The time-stamp authority could not be reached.", 502);
  }

  let token: Uint8Array;
  try {
    const parsed = parseTimestampResponse(reply);
    if (!parsed.granted) return fail(parsed.reason, 502);
    token = parsed.token;
  } catch {
    return fail("The time-stamp authority's answer could not be read.", 502);
  }

  // The answer must be about *this* hash and *this* request, or it is somebody
  // else's stamp.
  const checked = checkTimestampToken(token, { digest, nonce });
  if (!checked.valid) return fail(checked.problems.join(" "), 502);

  return NextResponse.json(
    {
      token: base64(token),
      time: checked.token.genTime.toISOString(),
      tsa: name || checked.token.tsa || undefined,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
