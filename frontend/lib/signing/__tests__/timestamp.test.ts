// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new () => { window: { DOMParser: typeof DOMParser; close(): void } };
};
const dom = new JSDOM();
beforeAll(() => vi.stubGlobal("DOMParser", dom.window.DOMParser));
afterAll(() => {
  vi.unstubAllGlobals();
  dom.window.close();
});

import { base64, fromBase64 } from "../canonical";
import { listSignatureFiles } from "../asice";
import { createSoftwareSigningProvider } from "../providers/software";
import { signIfcBatch } from "../bulk";
import { signFiles } from "../sign";
import {
  buildTimestampRequest,
  checkTimestampToken,
  parseTimestampResponse,
  randomNonce,
  readTimestampToken,
} from "../timestamp";
import { verifyContainer } from "../verify";
import { fakeTimestampResponse } from "./fake-tsa";

const MODEL = new TextEncoder().encode("ISO-10303-21;\nDATA;\n#1=IFCWALL('x',$);\nENDSEC;\nEND-ISO-10303-21;\n");
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));

describe("RFC 3161 request and token", () => {
  const digest = new Uint8Array(32).map((_, i) => i);

  it("builds a request a TSA can read: version 1, SHA-256 imprint, nonce, certReq", () => {
    const nonce = randomNonce();
    const request = buildTimestampRequest({ digest, nonce });
    expect(request[0]).toBe(0x30);
    // The hash and the nonce are in it, and nothing else of ours.
    const text = base64(request);
    expect(fromBase64(text)).toEqual(request);
    expect(request.length).toBeLessThan(80);
  });

  it("refuses to stamp anything but a 32-byte SHA-256", () => {
    expect(() => buildTimestampRequest({ digest: new Uint8Array(20), nonce: randomNonce() })).toThrow(/32 bytes/);
  });

  it("reads a granted response, and the token's time, hash and nonce", () => {
    const nonce = randomNonce();
    const reply = parseTimestampResponse(
      fakeTimestampResponse(buildTimestampRequest({ digest, nonce }), { at: new Date("2026-10-12T09:30:00Z") }),
    );
    expect(reply.granted).toBe(true);
    if (!reply.granted) return;

    const token = readTimestampToken(reply.token);
    expect(token.genTime.toISOString()).toBe("2026-10-12T09:30:00.000Z");
    expect(token.imprint).toEqual(digest);
    expect(token.policy).toBe("1.2.3.4.5");
    expect(checkTimestampToken(reply.token, { digest, nonce }).valid).toBe(true);
  });

  it("reports a refusal with the authority's own status", () => {
    const reply = parseTimestampResponse(
      fakeTimestampResponse(buildTimestampRequest({ digest, nonce: randomNonce() }), { status: 2 }),
    );
    expect(reply).toMatchObject({ granted: false, status: 2 });
    expect(reply.granted === false && reply.reason).toMatch(/rejected/);
  });

  it("rejects a token that stamps a different hash, or answers a different request", () => {
    const nonce = randomNonce();
    const request = buildTimestampRequest({ digest, nonce });
    const other = new Uint8Array(32).fill(9);

    const wrongHash = parseTimestampResponse(fakeTimestampResponse(request, { imprintOverride: other }));
    expect(wrongHash.granted && checkTimestampToken(wrongHash.token, { digest }).valid).toBe(false);

    const replay = parseTimestampResponse(fakeTimestampResponse(request, { nonceOverride: Uint8Array.of(1, 2, 3) }));
    const check = replay.granted ? checkTimestampToken(replay.token, { digest, nonce }) : null;
    expect(check?.valid).toBe(false);
    expect(check && !check.valid && check.problems.join()).toMatch(/nonce/);
  });

  it("says plainly when bytes are not a token", () => {
    const check = checkTimestampToken(new Uint8Array([1, 2, 3, 4]), { digest });
    expect(check.valid).toBe(false);
  });
});

describe("a signature with a time-stamp (XAdES-B-T)", () => {
  /** What the app's own route does, minus the network: stamp whatever hash it is given. */
  const stampWith = (options: Parameters<typeof fakeTimestampResponse>[1] = {}) =>
    vi.fn(async (digest: Uint8Array) => {
      const response = parseTimestampResponse(
        fakeTimestampResponse(buildTimestampRequest({ digest, nonce: randomNonce() }), options),
      );
      if (!response.granted) throw new Error(response.reason);
      return { token: base64(response.token), time: "2026-10-12T09:30:00.000Z", tsa: "Test TSA" };
    });

  it.each(["RSA", "EC"] as const)("embeds the token and verifies it against the signature (%s)", async (keyType) => {
    const timestamper = stampWith();
    const [output] = await signFiles(
      [{ name: "model.ifc", bytes: MODEL }],
      await createSoftwareSigningProvider({ keyType }),
      { timestamper },
    );

    expect(output.timestamp).toMatchObject({ status: "added", tsa: "Test TSA" });
    expect(timestamper).toHaveBeenCalledTimes(1);
    // A hash and nothing else is what the stamper is handed.
    expect(timestamper.mock.calls[0][0]).toHaveLength(32);

    const result = await verifyContainer(output.bytes);
    expect(result.problems).toEqual([]);
    const [signature] = result.signatures;
    expect(signature.valid).toBe(true);
    expect(signature.timestamp).toMatchObject({ matches: true, time: "2026-10-12T09:30:00.000Z", problems: [] });
  });

  it("is B-B, with no timestamp reported, when none was asked for", async () => {
    const [output] = await signFiles([{ name: "model.ifc", bytes: MODEL }], await createSoftwareSigningProvider({ keyType: "EC" }));
    expect(output.timestamp).toBeUndefined();
    const result = await verifyContainer(output.bytes);
    expect(result.signatures[0].timestamp).toBeUndefined();
  });

  it("keeps the signature when the authority fails, and says it has no time-stamp", async () => {
    const [output] = await signFiles(
      [{ name: "model.ifc", bytes: MODEL }],
      await createSoftwareSigningProvider({ keyType: "RSA" }),
      {
        timestamper: async () => {
          throw new Error("The time-stamp authority could not be reached.");
        },
      },
    );

    expect(output.timestamp).toEqual({ status: "failed", error: "The time-stamp authority could not be reached." });
    // The citizen already typed the PIN: the signature is real, just not stamped.
    const result = await verifyContainer(output.bytes);
    expect(result.signatures[0].valid).toBe(true);
    expect(result.signatures[0].timestamp).toBeUndefined();
  });

  it("notices a time-stamp that was taken over a different signature", async () => {
    const [first] = await signFiles(
      [{ name: "model.ifc", bytes: MODEL }],
      await createSoftwareSigningProvider({ keyType: "EC" }),
      { timestamper: stampWith() },
    );
    // Stamp an unrelated hash, as if a token had been copied over from another signature.
    const [second] = await signFiles(
      [{ name: "model.ifc", bytes: MODEL }],
      await createSoftwareSigningProvider({ keyType: "EC" }),
      { timestamper: stampWith({ imprintOverride: await sha256(MODEL) }) },
    );
    expect((await verifyContainer(first.bytes)).signatures[0].timestamp?.matches).toBe(true);

    const stamped = (await verifyContainer(second.bytes)).signatures[0];
    expect(stamped.valid).toBe(true); // the signature itself is fine
    expect(stamped.timestamp?.matches).toBe(false);
    expect(stamped.timestamp?.problems.join()).toMatch(/different signature value/);
  });

  it("puts the stamp in UnsignedProperties, outside what the signature covers", async () => {
    const [output] = await signFiles(
      [{ name: "model.ifc", bytes: MODEL }],
      await createSoftwareSigningProvider({ keyType: "EC" }),
      { timestamper: stampWith() },
    );
    const { unzipSync } = await import("fflate");
    const entries = unzipSync(output.bytes);
    const xml = new TextDecoder().decode(entries[listSignatureFiles(entries)[0]]);
    expect(xml).toMatch(/<xades:UnsignedProperties><xades:UnsignedSignatureProperties><xades:SignatureTimeStamp>/);
    expect(xml).toContain('<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#">');
    expect(xml.indexOf("xades:UnsignedProperties")).toBeGreaterThan(xml.indexOf("xades:SignedProperties"));
  });
});

describe("the IFC page's batch signing", () => {
  it("time-stamps IFCZIP signatures, per file and combined, and carries the outcome out", async () => {
    const timestamper = vi.fn(async (digest: Uint8Array) => {
      const response = parseTimestampResponse(
        fakeTimestampResponse(buildTimestampRequest({ digest, nonce: randomNonce() })),
      );
      if (!response.granted) throw new Error(response.reason);
      return { token: base64(response.token), time: "2026-10-12T09:30:00.000Z" };
    });
    const files = ["a.ifc", "b.ifc"].map((name) => new File([MODEL as BlobPart], name));

    for (const mode of ["per-file", "combined"] as const) {
      timestamper.mockClear();
      const result = await signIfcBatch(files, await createSoftwareSigningProvider({ keyType: "EC" }), {
        format: "ifczip",
        mode,
        timestamper,
      });
      expect(result.failures).toEqual([]);
      expect(timestamper).toHaveBeenCalledTimes(mode === "per-file" ? 2 : 1);
      expect(result.outputs.every((output) => output.timestamp?.status === "added")).toBe(true);
      for (const output of result.outputs) {
        expect((await verifyContainer(output.bytes)).signatures[0].timestamp?.matches).toBe(true);
      }
    }
  });
});
