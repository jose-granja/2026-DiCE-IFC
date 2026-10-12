"use client";

/**
 * Asking this deployment for a time-stamp.
 *
 * Only a hash goes out, as hex in a small JSON body — never a document, never
 * the signature, never a name. The deployment's own server (`app/api/tsa`) turns
 * it into an RFC 3161 request and talks to the time-stamp authority; see ADR 012.
 */

import { base64, fromBase64 } from "./canonical";
import { checkTimestampToken } from "./timestamp";

export type TimestampService = { configured: boolean; name?: string };

/** Whether this deployment has a time-stamp authority, and what it calls it. */
export async function timestampService(): Promise<TimestampService> {
  try {
    const response = await fetch("/api/tsa", { cache: "no-store" });
    if (!response.ok) return { configured: false };
    return (await response.json()) as TimestampService;
  } catch {
    return { configured: false };
  }
}

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** A `SignOptions.timestamper` that asks `/api/tsa`. */
export async function requestTimestamp(
  digest: Uint8Array,
): Promise<{ token: string; time: string; tsa?: string }> {
  const response = await fetch("/api/tsa", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ digest: hex(digest) }),
  });
  const answer = (await response.json().catch(() => ({}))) as {
    token?: string;
    time?: string;
    tsa?: string;
    error?: string;
  };
  if (!response.ok || !answer.token || !answer.time) {
    throw new Error(answer.error ?? `The time-stamp service answered ${response.status}.`);
  }

  // The server checked it; so does the page that is about to embed it. A token
  // that stamps some other hash would otherwise ride along inside a signature
  // it says nothing about.
  const checked = checkTimestampToken(fromBase64(answer.token), { digest });
  if (!checked.valid) throw new Error(checked.problems.join(" "));

  return { token: base64(fromBase64(answer.token)), time: answer.time, tsa: answer.tsa };
}
