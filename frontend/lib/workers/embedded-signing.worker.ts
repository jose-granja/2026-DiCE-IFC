/// <reference lib="webworker" />
import * as Comlink from "comlink";
import { digest } from "@/lib/signing/canonical";
import { appendEmbeddedSignature, EmbeddedIfcError, hasEmbeddedSignature, inspectEmbeddedIfc, type EmbeddedBlock, type EmbeddedIfcErrorCode } from "@/lib/signing/embedded-format";
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
/** Set when co-signing: how many signatures the finished file must carry, all valid. */
let expectedSignatures: number | undefined;

/** Each block covers the normalized file up to where it starts. */
async function verifyBlocks(normalized: Uint8Array, blocks: EmbeddedBlock[]) {
  const signatures = [];
  for (const block of blocks) {
    const result = await verifyCms(block.cms, await digest("SHA-256", normalized.subarray(0, block.start)));
    signatures.push({ valid: result.valid, subject: result.certificate?.subject,
      issuer: result.certificate?.issuer, serial: result.certificate?.serial, signingTime: result.signingTime,
      algorithm: result.certificate?.supportedAlgorithms[0], details: result.details, timestamp: result.timestamp });
  }
  return signatures;
}

async function verifyBytes(bytes: Uint8Array) {
  const { normalized, blocks } = inspectEmbeddedIfc(bytes);
  if (!blocks.length) throw new EmbeddedIfcError("unsigned-file");
  return { signatures: await verifyBlocks(normalized, blocks) };
}

const api = {
  /**
   * Read and hash the file to sign. A new signature refuses a signed file. A
   * co-signature (ADR 011, amended) needs one, and covers the whole normalized
   * file — the model and every signature before it; the existing signatures
   * are verified here so the page can refuse before the card is asked.
   */
  prepare(file: File, cosign = false) {
    return reply(async () => {
      original = new Uint8Array(await file.arrayBuffer());
      const { normalized, blocks } = inspectEmbeddedIfc(original);
      if (blocks.length && !cosign) throw new EmbeddedIfcError("already-signed");
      const signatures = cosign ? await verifyBlocks(normalized, blocks) : [];
      expectedSignatures = cosign ? blocks.length + 1 : undefined;
      contentDigest = await digest("SHA-256", normalized);
      return { contentDigest, signatures };
    });
  },
  async finish(cms: Uint8Array) {
    const result = await reply(async () => {
      if (!original || !contentDigest) throw new EmbeddedIfcError("invalid-ifc");
      const checked = await verifyCms(cms, contentDigest);
      if (!checked.valid) throw new EmbeddedIfcError("invalid-signature");
      const bytes = appendEmbeddedSignature(original, cms);
      if (expectedSignatures !== undefined) {
        // A co-signed file is checked as a whole: every signature, in order.
        const { signatures } = await verifyBytes(bytes);
        if (signatures.length !== expectedSignatures || !signatures.every((signature) => signature.valid)) {
          throw new EmbeddedIfcError("invalid-signature");
        }
      }
      original = undefined;
      contentDigest = undefined;
      expectedSignatures = undefined;
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
