"use client";

/**
 * Viewpoint snapshots as images for the PDF report (`pdf-report.ts`).
 *
 * Each is drawn again and written as a JPEG rather than handed over as it is:
 * - a snapshot is a full-viewport PNG, and fifty of them as PNG make a PDF of
 *   tens of megabytes; as JPEG at report size it is a few hundred kilobytes;
 * - pdfmake reads PNG and JPEG only, and not every PNG variant — an imported
 *   archive's snapshot can be anything. The browser decodes whatever it can
 *   show, and what it cannot is left out of the map, so one bad image costs
 *   one picture, not the report.
 */

import type { BcfTopic } from "./types";

/** Longest side, in pixels: sharp across an A4 page at print size, and no more. */
const REPORT_IMAGE_SIDE = 1400;

export async function reportImages(
  topics: BcfTopic[],
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<Map<string, string>> {
  const viewpoints = topics.flatMap((topic) => topic.viewpoints.filter((viewpoint) => viewpoint.snapshot));
  const out = new Map<string, string>();
  for (const [index, viewpoint] of viewpoints.entries()) {
    options.signal?.throwIfAborted();
    options.onProgress?.(index, viewpoints.length);
    const image = await asJpeg(viewpoint.snapshot!.bytes);
    if (image) out.set(viewpoint.guid, image);
  }
  options.onProgress?.(viewpoints.length, viewpoints.length);
  return out;
}

async function asJpeg(bytes: Uint8Array): Promise<string | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
  } catch {
    return null;
  }
  try {
    const scale = Math.min(1, REPORT_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    // JPEG has no transparency: what was see-through prints white, not black.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    bitmap.close();
  }
}
