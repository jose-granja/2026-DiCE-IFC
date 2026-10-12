/// <reference lib="webworker" />
import * as Comlink from "comlink";
import { digest } from "@/lib/signing/canonical";
import { appendEmbeddedSignature, EmbeddedIfcError, hasEmbeddedSignature, inspectEmbeddedIfc, type EmbeddedIfcErrorCode } from "@/lib/signing/embedded-format";
import { verifyCms } from "@/lib/signing/cms";

// Explicit error envelopes preserve typed error codes across Comlink.
type Reply<T> = { value: T } | { error: EmbeddedIfcErrorCode };
async function reply<T>(operation: () => Promise<T>): Promise<Reply<T>> {
  try { return { value: await operation() }; }
  catch (error) {
    if (error instanceof EmbeddedIfcError) return { error: error.code };
    throw error;
  }
}
let original: Uint8Array | undefined;
let contentDigest: Uint8Array | undefined;

async function verifyBytes(bytes: Uint8Array) {
  const { normalized, blocks } = inspectEmbeddedIfc(bytes);
  if (!blocks.length) throw new EmbeddedIfcError("unsigned-file");
  const signatures = [];
  for (const block of blocks) {
    const result = await verifyCms(block.cms, await digest("SHA-256", normalized.subarray(0, block.start)));
    signatures.push({ valid: result.valid, subject: result.certificate?.subject,
      issuer: result.certificate?.issuer, signingTime: result.signingTime,
      algorithm: result.certificate?.supportedAlgorithms[0] });
  }
  return { signatures };
}

const api = {
  prepare(file: File) {
    return reply(async () => {
      original = new Uint8Array(await file.arrayBuffer());
      const { normalized, blocks } = inspectEmbeddedIfc(original);
      if (blocks.length) throw new EmbeddedIfcError("already-signed");
      contentDigest = await digest("SHA-256", normalized);
      return contentDigest;
    });
  },
  async finish(cms: Uint8Array) {
    const result = await reply(async () => {
      if (!original || !contentDigest) throw new EmbeddedIfcError("invalid-ifc");
      const checked = await verifyCms(cms, contentDigest);
      if (!checked.valid) throw new EmbeddedIfcError("invalid-signature");
      const bytes = appendEmbeddedSignature(original, cms);
      original = undefined;
      contentDigest = undefined;
      return bytes;
    });
    // Comlink transfers the top-level return value, not a nested typed array.
    return "value" in result
      ? Comlink.transfer(result, [result.value.buffer as ArrayBuffer])
      : result;
  },
  verify(file: File) {
    return reply(async () => verifyBytes(new Uint8Array(await file.arrayBuffer())));
  },
  inspect(file: File) {
    return reply(async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!hasEmbeddedSignature(bytes)) return undefined;
      try { return await verifyBytes(bytes); }
      catch (error) {
        // Discovery found a signature declaration but the strict parser did
        // not accept a block. Keep this visibly invalid in the viewer.
        if (error instanceof EmbeddedIfcError && error.code === "unsigned-file") {
          throw new EmbeddedIfcError("invalid-signature");
        }
        throw error;
      }
    });
  },
};
export type EmbeddedSigningWorkerApi = typeof api;
Comlink.expose(api);
