import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SignatureSummary } from "@/lib/signing/summary";

const boundary = vi.hoisted(() => ({
  summariseSignature: vi.fn(), summariseEmbeddedSignature: vi.fn(),
  updateModel: vi.fn(), models: [{ summary: { id: "model-1" } }],
}));
vi.mock("@/lib/signing/summary", () => ({
  summariseSignature: boundary.summariseSignature,
  summariseEmbeddedSignature: boundary.summariseEmbeddedSignature,
}));
vi.mock("../store", () => ({ useViewerStore: { getState: () => ({
  models: boundary.models, updateModel: boundary.updateModel,
}) } }));
import { verifySignedContainer } from "../signature";

const raw = new File(["IFC content"], "model.ifc");
const summary: SignatureSummary = {
  containerName: "model.ifc", format: "embedded", valid: true, problems: [],
  signers: [{ subject: "CN=Signer", issuer: "CN=Issuer", algorithm: "ES256", valid: true, trust: "not-checked" }],
};

beforeEach(() => {
  vi.resetAllMocks();
  boundary.models = [{ summary: { id: "model-1" } }];
});

describe("viewer signature verification", () => {
  it("verifies raw IFC embedded signatures and puts the result on the model", async () => {
    boundary.summariseEmbeddedSignature.mockResolvedValue(summary);
    await verifySignedContainer("model-1", raw.name, { file: raw, container: null, entryName: null });
    expect(boundary.summariseEmbeddedSignature).toHaveBeenCalledWith(raw);
    expect(boundary.summariseSignature).not.toHaveBeenCalled();
    expect(boundary.updateModel).toHaveBeenCalledWith("model-1", { signature: summary });
  });

  it("leaves unsigned raw IFC with no signature badge", async () => {
    boundary.summariseEmbeddedSignature.mockResolvedValue(undefined);
    await verifySignedContainer("model-1", raw.name, { file: raw, container: null, entryName: null });
    expect(boundary.updateModel).toHaveBeenCalledWith("model-1", { signature: undefined });
  });

  it("retains invalid raw signatures visibly on the model", async () => {
    const invalid = { ...summary, valid: false, embeddedProblem: "invalid-signature" };
    boundary.summariseEmbeddedSignature.mockResolvedValue(invalid);
    await verifySignedContainer("model-1", raw.name, { file: raw, container: null, entryName: null });
    expect(boundary.updateModel).toHaveBeenCalledWith("model-1", { signature: invalid });
  });

  it("preserves the existing IFCZIP verification path", async () => {
    const archive = new Uint8Array([80, 75, 3, 4]);
    boundary.summariseSignature.mockResolvedValue({ ...summary, containerName: "model.ifczip", format: undefined });
    await verifySignedContainer("model-1", "model.ifczip", { file: raw, container: archive, entryName: raw.name });
    expect(boundary.summariseSignature).toHaveBeenCalledWith(archive, "model.ifczip");
    expect(boundary.summariseEmbeddedSignature).not.toHaveBeenCalled();
  });

  it("does not update a model closed while verification was running", async () => {
    boundary.summariseEmbeddedSignature.mockImplementation(async () => {
      boundary.models = [];
      return summary;
    });
    await verifySignedContainer("model-1", raw.name, { file: raw, container: null, entryName: null });
    expect(boundary.updateModel).not.toHaveBeenCalled();
  });
});
