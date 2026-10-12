import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { digest, utf8 } from "../canonical";
import { prepareCms } from "../cms";
import { appendEmbeddedSignature, hasEmbeddedSignature, normalizeIfc } from "../embedded-format";
import { createSoftwareSigningProvider } from "../providers/software";
import type { EmbeddedSigningWorkerApi } from "../../workers/embedded-signing.worker";

const bridge = vi.hoisted(() => ({ expose: vi.fn((api: unknown) => api), transfer: vi.fn((value: unknown) => value) }));
vi.mock("comlink", () => bridge);
import "../../workers/embedded-signing.worker";

const worker = bridge.expose.mock.calls[0][0] as EmbeddedSigningWorkerApi;
const fixture = new Uint8Array(readFileSync(new URL("../../../fixtures/ifc/georeferenced-wall-ifc4.ifc", import.meta.url)));
const source = new TextDecoder().decode(fixture);
const file = (bytes: Uint8Array) => new File([bytes as BlobPart], "model.ifc");
let signed: Uint8Array;

beforeAll(async () => {
  const provider = await createSoftwareSigningProvider({ keyType: "EC" });
  const certificate = await provider.getSigningCertificate();
  const prepared = await prepareCms(await digest("SHA-256", normalizeIfc(fixture)), certificate, new Date("2026-10-12T12:00:00Z"));
  const signature = await provider.sign({ dataToBeSigned: prepared.dataToBeSigned,
    hash: prepared.hash, expectCertificateDer: certificate.certificateDer });
  signed = appendEmbeddedSignature(fixture, prepared.complete(signature));
});

describe("embedded signature discovery", () => {
  it("does not turn quoted markers or ordinary comments into signatures", () => {
    const quoted = source.replace("'Fixture'", "'A '' value /* SIGNATURE; fake ENDSEC; */'");
    expect(hasEmbeddedSignature(utf8(quoted))).toBe(false);
    expect(hasEmbeddedSignature(utf8(source + "/* A comment about /* SIGNATURE; */"))).toBe(false);
    expect(hasEmbeddedSignature(utf8(source + "/* SIGNATURES are described elsewhere */"))).toBe(false);
    expect(hasEmbeddedSignature(fixture)).toBe(false);
  });

  it.each(["/* SIGNATURE; broken ENDSEC; */", "/* SIGNATURE broken */", "/* signature; broken */", "/*SIGNATURE", "/\n*\tSIG\nNATURE; broken */"])(
    "detects a claimed signature even when malformed: %s", (comment) => {
      expect(hasEmbeddedSignature(utf8(source + comment))).toBe(true);
    },
  );

  it("returns no signature for an ordinary non-ASCII IFC without hashing it", async () => {
    const input = file(utf8(source.replace("'Fixture'", "'José'")));
    const read = vi.spyOn(input, "arrayBuffer");
    const hash = vi.spyOn(crypto.subtle, "digest");
    try {
      expect(await worker.inspect(input)).toEqual({ value: undefined });
      expect(read).toHaveBeenCalledTimes(1);
      expect(hash).not.toHaveBeenCalled();
    } finally { hash.mockRestore(); }
  });

  it("verifies a genuine signed IFC and returns its signer for the viewer", async () => {
    const result = await worker.inspect(file(signed));
    expect(result).toMatchObject({ value: { signatures: [{
      valid: true, algorithm: "ES256", signingTime: "2026-10-12T12:00:00Z",
    }] } });
    if ("value" in result) expect(result.value?.signatures[0].subject).toBeTruthy();
  });

  it("reports altered signed model content as invalid", async () => {
    const altered = utf8(new TextDecoder().decode(signed).replace("IFCWALL", "IFCSLAB"));
    expect(await worker.inspect(file(altered))).toMatchObject({ value: { signatures: [{ valid: false }] } });
  });

  it("reports a non-ASCII alteration of a signed file instead of hiding its badge", async () => {
    const altered = utf8(new TextDecoder().decode(signed).replace("'Fixture'", "'José'"));
    expect(await worker.inspect(file(altered))).toEqual({ error: "non-ascii" });
  });

  it("reports malformed or truncated claimed signatures as invalid rather than unsigned", async () => {
    for (const comment of ["/* SIGNATURE broken */", "/* signature; broken */", "/*SIGNATURE", "/*SIGNATURE;??ENDSEC;*/"]) {
      const result = await worker.inspect(file(utf8(source + comment)));
      expect(result).toHaveProperty("error");
      expect(result).not.toEqual({ error: "unsigned-file" });
    }
  });

  it("rejects an unsigned suffix appended after a signature", async () => {
    expect(await worker.inspect(file(utf8(new TextDecoder().decode(signed) + "/* changed */"))))
      .toEqual({ error: "invalid-signature" });
  });

  it("keeps the explicit verification API strict for unsigned input", async () => {
    expect(await worker.verify(file(fixture))).toEqual({ error: "unsigned-file" });
  });
});
