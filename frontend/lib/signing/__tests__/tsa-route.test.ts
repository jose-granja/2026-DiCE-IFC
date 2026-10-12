// @vitest-environment node

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "@/app/api/tsa/route";
import { base64, fromBase64 } from "../canonical";
import { checkTimestampToken } from "../timestamp";
import { fakeTimestampResponse } from "./fake-tsa";

const DIGEST = "ab".repeat(32);
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost:3000/api/tsa", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

let seenRequests: Array<{ url: string; headers: Headers; body: Uint8Array }> = [];

function fakeAuthority(options: Parameters<typeof fakeTimestampResponse>[1] = {}, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = new Uint8Array(init.body as ArrayBuffer);
      seenRequests.push({ url, headers: new Headers(init.headers), body });
      return new Response(status === 200 ? (fakeTimestampResponse(body, options) as BodyInit) : "no", { status });
    }),
  );
}

beforeEach(() => {
  seenRequests = [];
  vi.stubEnv("TSA_URL", "https://tsa.example.org/ts");
  vi.stubEnv("TSA_NAME", "Example Qualified TSA");
  vi.stubEnv("TSA_RATE_LIMIT_PER_HOUR", "1000");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GET /api/tsa", () => {
  it("says whether an authority is configured, and what it is called, and nothing of its secrets", async () => {
    vi.stubEnv("TSA_USERNAME", "account");
    vi.stubEnv("TSA_PASSWORD", "hunter2");
    const body = await (await GET()).json();
    expect(body).toEqual({ configured: true, name: "Example Qualified TSA" });
    expect(JSON.stringify(body)).not.toMatch(/hunter2|account|example\.org/);
  });

  it("says no when there is none", async () => {
    vi.stubEnv("TSA_URL", "");
    expect(await (await GET()).json()).toEqual({ configured: false });
  });
});

describe("POST /api/tsa", () => {
  it("stamps a hash, asking the configured authority and no other", async () => {
    fakeAuthority();
    const response = await POST(post({ digest: DIGEST }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tsa).toBe("Example Qualified TSA");
    expect(body.time).toBe("2026-10-12T09:30:00.000Z");
    expect(checkTimestampToken(fromBase64(body.token), { digest: fromBase64(base64(Uint8Array.from(DIGEST.match(/../g)!.map((b) => parseInt(b, 16))))) }).valid).toBe(true);

    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0].url).toBe("https://tsa.example.org/ts");
    expect(seenRequests[0].headers.get("content-type")).toBe("application/timestamp-query");
    // The request the authority sees is small: a hash, a nonce, and the framing.
    expect(seenRequests[0].body.length).toBeLessThan(80);
  });

  it("sends credentials to the authority when configured, never back to the caller", async () => {
    vi.stubEnv("TSA_USERNAME", "account");
    vi.stubEnv("TSA_PASSWORD", "hunter2");
    fakeAuthority();
    const response = await POST(post({ digest: DIGEST }));

    expect(seenRequests[0].headers.get("authorization")).toBe(`Basic ${Buffer.from("account:hunter2").toString("base64")}`);
    expect(await response.text()).not.toMatch(/hunter2/);
  });

  it("will not stamp anything but a SHA-256 hash", async () => {
    fakeAuthority();
    for (const body of [{ digest: "zz".repeat(32) }, { digest: "ab".repeat(20) }, { digest: 5 }, {}, "not json"]) {
      const response = await POST(post(body));
      expect([400, 413]).toContain(response.status);
    }
    expect(seenRequests).toHaveLength(0);
  });

  it("will not take a body that is more than a hash", async () => {
    fakeAuthority();
    const response = await POST(post({ digest: DIGEST, file: "x".repeat(5000) }));
    expect(response.status).toBe(413);
    expect(seenRequests).toHaveLength(0);
  });

  it("does not let another site spend the stamps", async () => {
    fakeAuthority();
    const response = await POST(post({ digest: DIGEST }, { origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect(seenRequests).toHaveLength(0);
  });

  it("limits how many a client may take", async () => {
    vi.stubEnv("TSA_RATE_LIMIT_PER_HOUR", "2");
    fakeAuthority();
    const headers = { "x-forwarded-for": "203.0.113.7" };
    expect((await POST(post({ digest: DIGEST }, headers))).status).toBe(200);
    expect((await POST(post({ digest: DIGEST }, headers))).status).toBe(200);
    expect((await POST(post({ digest: DIGEST }, headers))).status).toBe(429);
    // Someone else is not held up by it.
    expect((await POST(post({ digest: DIGEST }, { "x-forwarded-for": "203.0.113.8" }))).status).toBe(200);
  });

  it("reports an authority that refuses, is down, or answers about something else", async () => {
    fakeAuthority({ status: 2 });
    expect((await POST(post({ digest: DIGEST }, { "x-forwarded-for": "1.1.1.1" }))).status).toBe(502);

    fakeAuthority({}, 503);
    const down = await POST(post({ digest: DIGEST }, { "x-forwarded-for": "1.1.1.2" }));
    expect(down.status).toBe(502);
    expect((await down.json()).error).toMatch(/503/);

    fakeAuthority({ imprintOverride: new Uint8Array(32) });
    const wrong = await POST(post({ digest: DIGEST }, { "x-forwarded-for": "1.1.1.3" }));
    expect(wrong.status).toBe(502);
    expect((await wrong.json()).error).toMatch(/different signature value/);
  });

  it("is 501 where no authority is configured", async () => {
    vi.stubEnv("TSA_URL", "");
    expect((await POST(post({ digest: DIGEST }))).status).toBe(501);
  });
});
