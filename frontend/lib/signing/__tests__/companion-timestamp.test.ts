// @vitest-environment node

/**
 * The Cartão de Cidadão time-stamp through the companion, from the page's side:
 * the request is built here, and the answer is checked here — the companion
 * only relays, so a reply for another hash or another request is refused.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../companion-settings", () => ({
  getCompanionSettings: () => ({ url: "http://127.0.0.1:8765", token: "t" }),
  getPairedSettings: async () => ({ url: "http://127.0.0.1:8765", token: "t" }),
  repairCompanion: async () => "t",
}));

import { base64, fromBase64 } from "../canonical";
import {
  companionTimestampStatus,
  requestCompanionTimestamp,
  TimestampLimitError,
} from "../providers/companion";
import { checkTimestampToken } from "../timestamp";
import { fakeTimestampResponse } from "./fake-tsa";

const DIGEST = new Uint8Array(32).fill(0xcd);

/** A companion whose `/timestamp` answers with `reply(request)`. */
function companion(reply: (query: Uint8Array) => { status?: number; json: unknown }) {
  const sent: Uint8Array[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/status")) {
      return Response.json({ features: ["sign", "timestamp"], timestamp: { name: "Cartão de Cidadão", remaining: 7 } });
    }
    const query = fromBase64(JSON.parse(String(init?.body)).request);
    sent.push(query);
    const { status = 200, json } = reply(query);
    return Response.json(json, { status });
  }));
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

describe("asking the companion for a Cartão de Cidadão time-stamp", () => {
  it("sends a request for this hash only, and checks the token it gets back", async () => {
    const sent = companion((query) => ({ json: { reply: base64(fakeTimestampResponse(query)), name: "Cartão de Cidadão" } }));
    const stamped = await requestCompanionTimestamp(DIGEST);
    expect(sent).toHaveLength(1);
    expect(sent[0].length).toBeLessThan(80);
    expect(checkTimestampToken(fromBase64(stamped.token), { digest: DIGEST }).valid).toBe(true);
    expect(stamped.time).toBe("2026-10-12T09:30:00.000Z");
  });

  it("refuses a token for another hash, or for another request", async () => {
    companion((query) => ({ json: { reply: base64(fakeTimestampResponse(query, { imprintOverride: new Uint8Array(32) })) } }));
    await expect(requestCompanionTimestamp(DIGEST)).rejects.toThrow();
    companion((query) => ({ json: { reply: base64(fakeTimestampResponse(query, { nonceOverride: Uint8Array.of(9, 9, 9) })) } }));
    await expect(requestCompanionTimestamp(DIGEST)).rejects.toThrow();
  });

  it("reports the service's limit as such, so the page can word it", async () => {
    companion(() => ({ status: 429, json: { code: "rate-limited", retryAfter: 600, error: "limit" } }));
    const error = await requestCompanionTimestamp(DIGEST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TimestampLimitError);
    expect(error).toMatchObject({ code: "rate-limited", retryAfter: 600 });
  });

  it("reads what the companion can do from its status", async () => {
    companion(() => ({ json: {} }));
    expect(await companionTimestampStatus()).toEqual({ state: "available", name: "Cartão de Cidadão", remaining: 7 });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ version: "0.1.1" })));
    expect(await companionTimestampStatus()).toEqual({ state: "outdated" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect(await companionTimestampStatus()).toEqual({ state: "absent" });
  });
});
