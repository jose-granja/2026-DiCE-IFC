"use client";

/**
 * Checking the signature on a container the viewer opened.
 *
 * Runs when a `.ifczip` turns out to carry `META-INF/signaturesNNN.xml`, and
 * writes the result onto the model in the store so the model list can show it.
 *
 * It reports what it actually checked, and no more. `verifyContainer` proves
 * that the bytes are the ones that were signed and that the signer held the key
 * for the enclosed certificate. Whether that certificate is a genuine
 * Portuguese qualified certificate, and whether it was revoked, needs the
 * trusted list and OCSP — so `trust` stays `not-checked` and the UI must not
 * imply otherwise.
 */

import { summariseSignature } from "@/lib/signing/summary";
import { useViewerStore } from "./store";
import type { UnwrappedModel } from "./container";

export async function verifySignedContainer(
  modelId: string,
  containerName: string,
  unwrapped: UnwrappedModel,
): Promise<void> {
  if (!unwrapped.container) return;

  const signature = await summariseSignature(unwrapped.container, containerName);

  // The model may have been closed while this ran.
  const store = useViewerStore.getState();
  if (!store.models.some((model) => model.summary.id === modelId)) return;

  store.updateModel(modelId, { signature });
}
