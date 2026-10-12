import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddedIfcError } from "../embedded-format";
import { inspectEmbeddedSignatures } from "../embedded";
import { summariseEmbeddedSignature } from "../summary";

vi.mock("../embedded", () => ({ inspectEmbeddedSignatures: vi.fn() }));
const file = new File(["model"], "model.ifc");
beforeEach(() => vi.resetAllMocks());

describe("embedded IFC signature summaries", () => {
  it("does not inspect IFCXML as an embedded STEP signature", async () => {
    expect(await summariseEmbeddedSignature(new File(["<ifc/>"], "model.ifcxml"))).toBeUndefined();
    expect(inspectEmbeddedSignatures).not.toHaveBeenCalled();
  });

  it("gives ordinary unsigned IFC no badge", async () => {
    vi.mocked(inspectEmbeddedSignatures).mockResolvedValue(undefined);
    expect(await summariseEmbeddedSignature(file)).toBeUndefined();
  });

  it("reports verified signers without asserting trust", async () => {
    vi.mocked(inspectEmbeddedSignatures).mockResolvedValue({ signatures: [{
      valid: true, subject: "CN=Signer", issuer: "CN=Issuer", algorithm: "RS256", signingTime: "2026-10-12T12:00:00Z",
    }] });
    expect(await summariseEmbeddedSignature(file)).toMatchObject({
      containerName: "model.ifc", format: "embedded", valid: true,
      signers: [{ subject: "CN=Signer", issuer: "CN=Issuer", algorithm: "RS256", valid: true, trust: "not-checked" }],
    });
  });

  it("fails the model summary if any signature fails", async () => {
    vi.mocked(inspectEmbeddedSignatures).mockResolvedValue({ signatures: [{ valid: true }, { valid: false }] });
    expect(await summariseEmbeddedSignature(file)).toMatchObject({ valid: false, embeddedProblem: "invalid-signature" });
  });

  it("keeps malformed signature errors translatable and visible", async () => {
    vi.mocked(inspectEmbeddedSignatures).mockRejectedValue(new EmbeddedIfcError("non-ascii"));
    expect(await summariseEmbeddedSignature(file)).toEqual({
      containerName: "model.ifc", format: "embedded", valid: false, signers: [], problems: [], embeddedProblem: "non-ascii",
    });
  });

  it("does not hide an unexpected worker failure as an unsigned file", async () => {
    vi.mocked(inspectEmbeddedSignatures).mockRejectedValue(new Error("Worker stopped"));
    expect(await summariseEmbeddedSignature(file)).toMatchObject({ valid: false, embeddedProblem: "unknown" });
  });
});
