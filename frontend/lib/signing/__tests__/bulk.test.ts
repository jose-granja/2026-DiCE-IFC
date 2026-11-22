import { beforeEach, describe, expect, it, vi } from "vitest";

import { BulkSigningError, cosignFormat, cosignIfcBatch, signIfcBatch, signIfcFiles, type BatchOutput, type BatchProgress } from "../bulk";
import { cosignContainer, CosignError } from "../cosign";
import { cosignEmbeddedIfc, signEmbeddedIfc } from "../embedded";
import { EmbeddedIfcError } from "../embedded-format";
import { SigningError, type SigningCertificate, type SigningProvider } from "../provider";
import { signFiles } from "../sign";

// These tests cover queue and device boundaries. The existing embedded and
// roundtrip suites exercise the signatures with real keys and OpenSSL.
vi.mock("../embedded", () => ({ signEmbeddedIfc: vi.fn(), cosignEmbeddedIfc: vi.fn() }));
vi.mock("../cosign", async (original) => ({ ...(await original<typeof import("../cosign")>()), cosignContainer: vi.fn() }));
vi.mock("../sign", () => ({ signFiles: vi.fn() }));

const certificate: SigningCertificate = {
  certificateDer: "first-card", chainDer: [], subject: "Test", issuer: "Test",
  serial: "1", notBefore: "2026-01-01", notAfter: "2030-01-01",
  keyType: "RSA", supportedAlgorithms: ["RS256"],
};
const bytes = new Uint8Array([1, 2, 3]);
const embeddedOptions = { format: "embedded", mode: "per-file" } as const;
const zipOptions = { format: "ifczip", mode: "per-file" } as const;
const files = (names = ["one.ifc", "two.ifc", "three.ifc"]) => names.map((name) => new File([bytes], name));

function provider(): SigningProvider {
  return {
    id: "mock",
    getReadiness: vi.fn(async () => ({ providerId: "mock" as const, ready: true, checks: [] })),
    getSigningCertificate: vi.fn(async () => certificate),
    sign: vi.fn(async (request) => ({
      certificateDer: request.expectCertificateDer, algorithm: "RS256" as const, signatureValue: "signature",
    })),
  };
}

async function signWith(device: SigningProvider) {
  const cert = await device.getSigningCertificate();
  await device.sign({ dataToBeSigned: bytes, hash: "SHA-256", expectCertificateDer: cert.certificateDer });
  return cert;
}

function embeddedOutput(name: string, cert = certificate) {
  return { bytes, name: name.replace(/\.ifc$/i, "-signed.ifc"), certificate: cert, signingTime: "2026-10-12T12:00:00.000Z" };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(signEmbeddedIfc).mockImplementation(async (file, device, options) => {
    options?.onProgress?.("reading");
    options?.onProgress?.("certificate");
    const cert = await signWith(device);
    options?.onProgress?.("signing");
    options?.onProgress?.("verifying");
    return embeddedOutput(file.name, cert);
  });
  vi.mocked(signFiles).mockImplementation(async (inputs, device, options) => {
    await signWith(device);
    options?.onProgress?.({ phase: "done", current: 1, total: inputs.length });
    return [{
      name: inputs[0].name.replace(/\.[^.]+$/, ".ifczip"), bytes,
      covers: inputs.map((file) => file.name),
    }];
  });
});

describe("IFC batch preflight", () => {
  it.each([
    { names: [], options: zipOptions, code: "empty-selection" },
    { names: ["same.ifc", "SAME.IFC"], options: zipOptions, code: "duplicate-name" },
    { names: ["same.ifc", "same.ifc"], options: embeddedOptions, code: "duplicate-name" },
    { names: ["model.pdf"], options: zipOptions, code: "unsupported-format" },
    { names: ["model.ifcxml"], options: embeddedOptions, code: "unsupported-format" },
    { names: ["model.ifc"], options: { format: "embedded", mode: "combined" } as const, code: "invalid-mode" },
  ])("rejects $code before touching the card", async ({ names, options, code }) => {
    const device = provider();
    await expect(signIfcBatch(files(names), device, options)).rejects.toMatchObject({
      name: "BulkSigningError", code,
    });
    expect(device.getSigningCertificate).not.toHaveBeenCalled();
    expect(device.sign).not.toHaveBeenCalled();
    expect(signEmbeddedIfc).not.toHaveBeenCalled();
    expect(signFiles).not.toHaveBeenCalled();
  });

  it("includes the offending duplicate file name for translated UI errors", async () => {
    try {
      await signIfcBatch(files(["model.ifc", "model.ifc"]), provider(), zipOptions);
      expect.fail("Expected a validation error");
    } catch (error) {
      expect(error).toBeInstanceOf(BulkSigningError);
      expect(error).toMatchObject({ code: "duplicate-name", fileName: "model.ifc" });
    }
  });
});

describe("IFC batch queue", () => {
  it("signs embedded files one at a time and publishes each completed file", async () => {
    let active = 0, maximum = 0;
    const emitted: BatchOutput[] = [];
    vi.mocked(signEmbeddedIfc).mockImplementation(async (file, device) => {
      active++;
      maximum = Math.max(maximum, active);
      expect(emitted).toHaveLength(vi.mocked(signEmbeddedIfc).mock.calls.length - 1);
      await signWith(device);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return embeddedOutput(file.name);
    });
    const device = provider();
    const result = await signIfcBatch(files(), device, {
      ...embeddedOptions, onOutput: (output) => emitted.push(output),
    });
    expect(maximum).toBe(1);
    expect(device.sign).toHaveBeenCalledTimes(3);
    expect(result.outputs.map((file) => file.name)).toEqual(["one-signed.ifc", "two-signed.ifc", "three-signed.ifc"]);
    expect(result.outputs).toEqual(emitted);
    expect(result.outputs[0]).toMatchObject({ covers: ["one.ifc"], format: "embedded", certificate });
    expect(result.failures).toEqual([]);
    expect(result.cancelled).toBe(false);
  });

  it("maps progress to the whole batch and normalizes the PIN phase", async () => {
    const progress: BatchProgress[] = [];
    await signIfcBatch(files(), provider(), { ...embeddedOptions, onProgress: (value) => progress.push(value) });
    expect(progress.filter((value) => value.phase === "awaiting-pin")).toEqual([
      { current: 1, total: 3, fileName: "one.ifc", phase: "awaiting-pin" },
      { current: 2, total: 3, fileName: "two.ifc", phase: "awaiting-pin" },
      { current: 3, total: 3, fileName: "three.ifc", phase: "awaiting-pin" },
    ]);
    expect(progress.at(-1)).toEqual({ current: 3, total: 3, fileName: "three.ifc", phase: "done" });
  });

  it("signs a combined IFCZIP once covering all selected formats", async () => {
    const device = provider();
    const selected = files(["model.ifc", "model.ifcxml", "prior.ifczip"]);
    const result = await signIfcBatch(selected, device, { format: "ifczip", mode: "combined" });
    expect(signFiles).toHaveBeenCalledTimes(1);
    expect(device.sign).toHaveBeenCalledTimes(1);
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0].covers).toEqual(selected.map((file) => file.name));
    expect(vi.mocked(signFiles).mock.calls[0][0]).toEqual(selected.map((file) => ({ name: file.name, bytes })));
    expect(vi.mocked(signFiles).mock.calls[0][2]).toMatchObject({ mode: "combined", kind: "ifc" });
  });

  it("keeps independent IFCZIP downloads unique for colliding stems", async () => {
    const device = provider();
    const result = await signIfcBatch(files(["model.ifc", "model.ifcxml", "model (2).ifc"]), device, zipOptions);
    expect(signFiles).toHaveBeenCalledTimes(3);
    expect(device.sign).toHaveBeenCalledTimes(3);
    expect(result.outputs.map((file) => file.name)).toEqual(["model.ifczip", "model (2).ifczip", "model (2) (2).ifczip"]);
    expect(result.outputs.map((file) => file.covers)).toEqual([["model.ifc"], ["model.ifcxml"], ["model (2).ifc"]]);
  });
});

describe("partial failures and card safety", () => {
  it("retains successful outputs and skips an invalid embedded file", async () => {
    const original = vi.mocked(signEmbeddedIfc).getMockImplementation()!;
    vi.mocked(signEmbeddedIfc).mockImplementation((file, ...args) => {
      if (file.name === "two.ifc") return Promise.reject(new EmbeddedIfcError("non-ascii"));
      return original(file, ...args);
    });
    const device = provider();
    const result = await signIfcBatch(files(), device, embeddedOptions);
    expect(device.sign).toHaveBeenCalledTimes(2);
    expect(result.outputs.map((file) => file.covers[0])).toEqual(["one.ifc", "three.ifc"]);
    expect(result.failures).toEqual([{ fileName: "two.ifc", error: new EmbeddedIfcError("non-ascii") }]);
    expect(result.cancelled).toBe(false);
  });

  it.each(["cancelled", "pin-incorrect", "pin-blocked", "card-changed", "not-ready", "unknown", "unsupported-algorithm"] as const)(
    "stops on %s without retrying or losing previous output", async (code) => {
      const original = vi.mocked(signEmbeddedIfc).getMockImplementation()!;
      vi.mocked(signEmbeddedIfc)
        .mockImplementationOnce(original)
        .mockRejectedValueOnce(new SigningError(code, code));
      const emitted: BatchOutput[] = [];
      const result = await signIfcBatch(files(), provider(), {
        ...embeddedOptions, onOutput: (output) => emitted.push(output),
      });
      expect(signEmbeddedIfc).toHaveBeenCalledTimes(2);
      expect(result.outputs).toHaveLength(1);
      expect(result.outputs).toEqual(emitted);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatchObject({ fileName: "two.ifc", error: { code } });
      expect(result.cancelled).toBe(code === "cancelled");
    },
  );

  it("retains the first independent IFCZIP when a later PIN is cancelled", async () => {
    const original = vi.mocked(signFiles).getMockImplementation()!;
    vi.mocked(signFiles).mockImplementationOnce(original).mockRejectedValueOnce(new SigningError("cancelled", "cancelled"));
    const result = await signIfcBatch(files(), provider(), zipOptions);
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0].covers).toEqual(["one.ifc"]);
    expect(result.cancelled).toBe(true);
    expect(signFiles).toHaveBeenCalledTimes(2);
  });

  it("does not automatically continue after an unexpected signing failure", async () => {
    vi.mocked(signEmbeddedIfc).mockRejectedValueOnce(new Error("Worker stopped"));
    const result = await signIfcBatch(files(), provider(), embeddedOptions);
    expect(signEmbeddedIfc).toHaveBeenCalledTimes(1);
    expect(result.outputs).toEqual([]);
    expect(result.failures).toHaveLength(1);
  });

  it("checks the batch certificate before prompting on a replacement card", async () => {
    const device = provider();
    vi.mocked(device.getSigningCertificate)
      .mockResolvedValueOnce(certificate)
      .mockResolvedValueOnce({ ...certificate, certificateDer: "replacement-card" });
    const result = await signIfcBatch(files(), device, embeddedOptions);
    expect(device.sign).toHaveBeenCalledTimes(1);
    expect(result.outputs).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ fileName: "two.ifc", error: { code: "card-changed" } });
  });

  it("refuses an echoed certificate different from the one requested", async () => {
    const device = provider();
    vi.mocked(device.sign).mockResolvedValueOnce({ certificateDer: "wrong-card", algorithm: "RS256", signatureValue: "signature" });
    const result = await signIfcBatch(files(), device, zipOptions);
    expect(device.sign).toHaveBeenCalledTimes(1);
    expect(result.outputs).toHaveLength(0);
    expect(result.failures[0]).toMatchObject({ fileName: "one.ifc", error: { code: "card-changed" } });
  });

  it("can skip an unreadable file when signing individual IFCZIPs", async () => {
    const selected = files();
    vi.spyOn(selected[1], "arrayBuffer").mockRejectedValueOnce(new Error("Unreadable"));
    const result = await signIfcBatch(selected, provider(), zipOptions);
    expect(result.outputs.map((file) => file.covers[0])).toEqual(["one.ifc", "three.ifc"]);
    expect(result.failures[0].fileName).toBe("two.ifc");
  });

  it("does not sign a partial combined archive when an input is unreadable", async () => {
    const selected = files();
    const device = provider();
    vi.spyOn(selected[1], "arrayBuffer").mockRejectedValueOnce(new Error("Unreadable"));
    const result = await signIfcBatch(selected, device, { format: "ifczip", mode: "combined" });
    expect(result.outputs).toEqual([]);
    expect(result.failures[0].fileName).toBe("two.ifc");
    expect(signFiles).not.toHaveBeenCalled();
    expect(device.sign).not.toHaveBeenCalled();
  });
});

describe("co-signing a batch", () => {
  beforeEach(() => {
    vi.mocked(cosignEmbeddedIfc).mockImplementation(async (file, device) => {
      const cert = await signWith(device);
      return { bytes, name: file.name, certificate: cert, signingTime: "2026-11-22T12:00:00.000Z" };
    });
    vi.mocked(cosignContainer).mockImplementation(async (file, device) => {
      await signWith(device);
      return { name: file.name, bytes, covers: ["model.ifc"] };
    });
  });

  it("joins each file's own format: the signatures inside an .ifc, the container of an .ifczip", async () => {
    expect([cosignFormat("a.IFC"), cosignFormat("b.ifczip"), cosignFormat("c.ifcxml")]).toEqual(["embedded", "ifczip", null]);
    const device = provider();
    const result = await cosignIfcBatch(files(["model-signed.ifc", "model.ifczip"]), device, {});
    expect(result.outputs.map((output) => [output.name, output.format])).toEqual([
      ["model-signed.ifc", "embedded"],
      ["model.ifczip", "ifczip"],
    ]);
    expect(cosignEmbeddedIfc).toHaveBeenCalledTimes(1);
    expect(cosignContainer).toHaveBeenCalledTimes(1);
    expect(device.sign).toHaveBeenCalledTimes(2);
  });

  it("refuses what it cannot co-sign before the card", async () => {
    const device = provider();
    await expect(cosignIfcBatch(files(["model.ifcxml"]), device, {})).rejects.toMatchObject({ code: "unsupported-format" });
    await expect(cosignIfcBatch(files(["a.ifc", "A.IFC"]), device, {})).rejects.toMatchObject({ code: "duplicate-name" });
    expect(device.getSigningCertificate).not.toHaveBeenCalled();
  });

  it("skips a file that must not be co-signed, with its reason, and goes on", async () => {
    vi.mocked(cosignEmbeddedIfc).mockImplementationOnce(async () => { throw new CosignError("existing-invalid"); });
    const result = await cosignIfcBatch(files(["altered.ifc", "good.ifc"]), provider(), {});
    expect(result.failures).toMatchObject([{ fileName: "altered.ifc", error: { code: "existing-invalid" } }]);
    expect(result.outputs.map((output) => output.name)).toEqual(["good.ifc"]);
  });

  it("stops when the PIN is cancelled, keeping what was done", async () => {
    vi.mocked(cosignContainer)
      .mockImplementationOnce(async (file, device) => { await signWith(device); return { name: file.name, bytes, covers: [] }; })
      .mockImplementationOnce(async () => { throw new SigningError("cancelled", "Cancelled."); });
    const result = await cosignIfcBatch(files(["one.ifczip", "two.ifczip", "three.ifczip"]), provider(), {});
    expect(result.outputs.map((output) => output.name)).toEqual(["one.ifczip"]);
    expect(result.cancelled).toBe(true);
    expect(cosignContainer).toHaveBeenCalledTimes(2);
  });
});

describe("signing a queue whatever each file carries", () => {
  beforeEach(() => {
    vi.mocked(cosignEmbeddedIfc).mockImplementation(async (file, device) => {
      const cert = await signWith(device);
      return { bytes, name: file.name, certificate: cert, signingTime: "2026-11-22T12:00:00.000Z" };
    });
    vi.mocked(cosignContainer).mockImplementation(async (file, device) => {
      await signWith(device);
      return { name: file.name, bytes, covers: ["model.ifc"] };
    });
  });
  const signedNames = new Set(["author.ifc", "author.ifczip"]);
  const isSigned = (file: File) => signedNames.has(file.name);

  it("signs the new files in the chosen format and adds a signature to the signed ones in theirs", async () => {
    const device = provider();
    const progress: BatchProgress[] = [];
    const result = await signIfcFiles(files(["new.ifc", "author.ifc", "author.ifczip"]), device, {
      ...embeddedOptions, isSigned, onProgress: (step) => progress.push(step),
    });
    expect(result.outputs.map((output) => [output.name, output.format])).toEqual([
      ["new-signed.ifc", "embedded"],
      ["author.ifc", "embedded"],
      ["author.ifczip", "ifczip"],
    ]);
    expect(signEmbeddedIfc).toHaveBeenCalledTimes(1);
    expect(cosignEmbeddedIfc).toHaveBeenCalledTimes(1);
    expect(cosignContainer).toHaveBeenCalledTimes(1);
    // One count over the whole queue, whichever way each file went.
    expect(Math.max(...progress.map((step) => step.current))).toBe(3);
    expect(new Set(progress.map((step) => step.total))).toEqual(new Set([3]));
  });

  it("applies the format only to files with no signature: a signed .ifczip is joined, not re-wrapped", async () => {
    const result = await signIfcFiles(files(["author.ifczip", "new.ifc"]), provider(), { ...zipOptions, isSigned });
    expect(signFiles).toHaveBeenCalledTimes(1);
    expect(vi.mocked(signFiles).mock.calls[0][0].map((input) => input.name)).toEqual(["new.ifc"]);
    expect(cosignContainer).toHaveBeenCalledTimes(1);
    expect(result.outputs.map((output) => output.name)).toEqual(["new.ifczip", "author.ifczip"]);
  });

  it("refuses an unsigned file the chosen format cannot take, before the card", async () => {
    const device = provider();
    await expect(signIfcFiles(files(["plain.ifczip", "author.ifc"]), device, { ...embeddedOptions, isSigned }))
      .rejects.toMatchObject({ code: "unsupported-format", fileName: "plain.ifczip" });
    expect(device.getSigningCertificate).not.toHaveBeenCalled();
  });

  it("stops the whole queue when the PIN is cancelled while signing the new files", async () => {
    vi.mocked(signEmbeddedIfc).mockRejectedValueOnce(new SigningError("cancelled", "Cancelled."));
    const result = await signIfcFiles(files(["new.ifc", "author.ifc"]), provider(), { ...embeddedOptions, isSigned });
    expect(result.cancelled).toBe(true);
    expect(cosignEmbeddedIfc).not.toHaveBeenCalled();
  });

  it("keeps one card for the whole queue", async () => {
    const device = provider();
    vi.mocked(device.getSigningCertificate)
      .mockResolvedValueOnce(certificate)
      .mockResolvedValueOnce({ ...certificate, certificateDer: "second-card" });
    const result = await signIfcFiles(files(["new.ifc", "author.ifc"]), device, { ...embeddedOptions, isSigned });
    expect(result.outputs).toHaveLength(1);
    expect(result.failures).toMatchObject([{ fileName: "author.ifc", error: { code: "card-changed" } }]);
  });
});

