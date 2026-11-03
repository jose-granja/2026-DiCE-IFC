/**
 * The human check's rules, without Cloudflare: the pass cookie cannot be
 * forged, stretched or kept past its time; pages and API calls are gated and
 * static files are not; the way back after the check stays on this site; and
 * a token is accepted only when Cloudflare says so.
 */

import { describe, expect, it, vi } from "vitest";

import {
  SITEVERIFY_URL,
  TURNSTILE_ACTION,
  checkToken,
  gateFor,
  humanCheckConfig,
  issuePass,
  safeNext,
  verifyPass,
} from "../pass";

const SECRET = "test-secret";
const config = { siteKey: "site", secretKey: SECRET, passSeconds: 3600 };

describe("humanCheckConfig", () => {
  it("is off unless both keys are set", () => {
    expect(humanCheckConfig({})).toBeNull();
    expect(humanCheckConfig({ TURNSTILE_SITE_KEY: "a" })).toBeNull();
    expect(humanCheckConfig({ TURNSTILE_SECRET_KEY: "b" })).toBeNull();
    expect(humanCheckConfig({ TURNSTILE_SITE_KEY: " a ", TURNSTILE_SECRET_KEY: "b" })).toEqual({
      siteKey: "a",
      secretKey: "b",
      passSeconds: 24 * 3600,
    });
  });

  it("keeps the pass between a minute and thirty days", () => {
    const keys = { TURNSTILE_SITE_KEY: "a", TURNSTILE_SECRET_KEY: "b" };
    expect(humanCheckConfig({ ...keys, TURNSTILE_PASS_HOURS: "2" })?.passSeconds).toBe(7200);
    expect(humanCheckConfig({ ...keys, TURNSTILE_PASS_HOURS: "0" })?.passSeconds).toBe(60);
    expect(humanCheckConfig({ ...keys, TURNSTILE_PASS_HOURS: "100000" })?.passSeconds).toBe(720 * 3600);
    expect(humanCheckConfig({ ...keys, TURNSTILE_PASS_HOURS: "soon" })?.passSeconds).toBe(24 * 3600);
  });
});

describe("the pass", () => {
  const now = Date.UTC(2026, 10, 3, 12);

  it("is accepted until it expires", async () => {
    const pass = await issuePass(SECRET, 3600, now);
    expect(await verifyPass(pass, SECRET, now)).toBe(true);
    expect(await verifyPass(pass, SECRET, now + 3599_000)).toBe(true);
    expect(await verifyPass(pass, SECRET, now + 3600_000)).toBe(false);
  });

  it("cannot be forged, stretched or carried to another deployment", async () => {
    const pass = await issuePass(SECRET, 3600, now);
    const [version, expires, signature] = pass.split(".");
    expect(await verifyPass(`${version}.${Number(expires) + 86_400}.${signature}`, SECRET, now)).toBe(false);
    expect(await verifyPass(pass, "another-secret", now)).toBe(false);
    expect(await verifyPass(`${version}.${expires}.${signature.slice(0, -2)}AA`, SECRET, now)).toBe(false);
    for (const junk of [undefined, "", "yes", "v1", "v1.1.", `v2.${expires}.${signature}`, `${pass}.extra`, "v1.9999999999.!!"]) {
      expect(await verifyPass(junk, SECRET, now)).toBe(false);
    }
  });
});

describe("gateFor", () => {
  it("gates pages and API calls, not the check, the privacy page or static files", () => {
    expect(gateFor("/")).toBe("page");
    expect(gateFor("/viewer")).toBe("page");
    expect(gateFor("/sign/ifc")).toBe("page");
    expect(gateFor("/api/tsa")).toBe("api");
    expect(gateFor("/api/bsdd/search")).toBe("api");
    expect(gateFor("/human-check")).toBeNull();
    expect(gateFor("/api/human-check")).toBeNull();
    expect(gateFor("/privacy")).toBeNull();
    expect(gateFor("/third-party-licenses.txt")).toBeNull();
    expect(gateFor("/templates/mqt-default.xlsx")).toBeNull();
    // A dot in an API path is still an API call.
    expect(gateFor("/api/ogc/capabilities.xml")).toBe("api");
  });
});

describe("safeNext", () => {
  it("keeps a path on this site", () => {
    expect(safeNext("/viewer?panel=bcf")).toBe("/viewer?panel=bcf");
    expect(safeNext("/")).toBe("/");
  });

  it("never leaves the site, or loops back to the check", () => {
    for (const bad of [null, "", "viewer", "https://evil.example", "//evil.example", "/\\evil.example", "/human-check", "/human-check?next=/", `/${"a".repeat(3000)}`, "/a\nb"]) {
      expect(safeNext(bad)).toBe("/");
    }
  });
});

describe("checkToken", () => {
  const answer = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;

  it("asks Cloudflare with the secret and the token, and nothing else", async () => {
    const fetchImpl = answer({ success: true, action: TURNSTILE_ACTION });
    expect(await checkToken("token-1", config, fetchImpl)).toEqual({ ok: true });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(SITEVERIFY_URL);
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ secret: SECRET, response: "token-1" });
  });

  it("refuses what Cloudflare refuses, and a token made for another action", async () => {
    expect(await checkToken("t", config, answer({ success: false, "error-codes": ["timeout-or-duplicate"] }))).toEqual({
      ok: false,
      reason: "invalid",
      codes: ["timeout-or-duplicate"],
    });
    expect(await checkToken("t", config, answer({ success: true, action: "login" }))).toMatchObject({ ok: false });
    // Cloudflare's test keys answer without an action.
    expect(await checkToken("t", config, answer({ success: true }))).toEqual({ ok: true });
  });

  it("refuses an empty or oversized token without asking", async () => {
    const fetchImpl = answer({ success: true });
    expect(await checkToken("", config, fetchImpl)).toMatchObject({ ok: false });
    expect(await checkToken("x".repeat(2049), config, fetchImpl)).toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed when Cloudflare cannot be reached", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await checkToken("t", config, down)).toEqual({ ok: false, reason: "unreachable", codes: [] });
  });
});
