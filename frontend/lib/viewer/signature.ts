"use client";

/**
 * Checking signatures on an IFC model or container the viewer opened.
 *
 * Checks `.ifczip` containers and discovers embedded signature comments in raw
 * IFC files. Writes the result onto the model so the model list can show it.
 *
 * It reports what it actually checked, and no more. `verifyContainer` proves
 * that the bytes are the ones that were signed and that the signer held the key
 * for the enclosed certificate. Whether that certificate is a genuine
 * Portuguese qualified certificate, and whether it was revoked, needs the
 * trusted list and OCSP — so `trust` stays `not-checked` and the UI must not
 * imply otherwise.
 */

import { summariseEmbeddedSignature, summariseSignature } from "@/lib/signing/summary";
import { useViewerStore } from "./store";
import type { UnwrappedModel } from "./container";

export async function verifySignedContainer(
  modelId: string,
  containerName: string,
  unwrapped: UnwrappedModel,
): Promise<void> {
  const signature = unwrapped.container
    ? await summariseSignature(unwrapped.container, containerName)
    : await summariseEmbeddedSignature(unwrapped.file);

  // The model may have been closed while this ran.
  const store = useViewerStore.getState();
  if (!store.models.some((model) => model.summary.id === modelId)) return;

  store.updateModel(modelId, { signature });
}
