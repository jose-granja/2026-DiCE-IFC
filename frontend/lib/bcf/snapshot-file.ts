/**
 * A picture from the user's computer as a viewpoint snapshot — a site photo,
 * a marked-up drawing, a screenshot from another tool.
 *
 * Every picture is drawn again and stored as a PNG, whatever it came as:
 * - BCF readers expect a PNG or JPEG snapshot, and the annotations live in a
 *   PNG chunk (`annotations.ts`), so one format keeps both working;
 * - a phone photo's EXIF — where it was taken, by what — stays on the user's
 *   computer instead of travelling in every exported topic;
 * - it is made no larger than `MAX_SNAPSHOT_SIDE` on its longest side, the size
 *   the BCF guidance asks of a snapshot, so a 12-megapixel photo does not make
 *   the archive tens of megabytes.
 */

import { newGuid, type BcfViewpoint } from "./types";

export const MAX_SNAPSHOT_SIDE = 1500;
/** Larger files are refused before decoding: no picture of a view needs this much. */
export const MAX_SNAPSHOT_FILE_BYTES = 50 * 1024 * 1024;

export class SnapshotFileError extends Error {
  constructor(
    readonly code: "notImage" | "tooLarge" | "unreadable",
    message: string,
  ) {
    super(message);
    this.name = "SnapshotFileError";
  }
}

/** The size to draw a picture at: as it is, or scaled down to fit `max` keeping its shape. */
export function fitWithin(width: number, height: number, max = MAX_SNAPSHOT_SIDE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Read a picture file into a snapshot: a PNG, at most `MAX_SNAPSHOT_SIDE` on its longest side. */
export async function snapshotFromImageFile(file: File): Promise<{ fileName: string; bytes: Uint8Array }> {
  if (file.type && !file.type.startsWith("image/")) {
    throw new SnapshotFileError("notImage", "The file is not a picture.");
  }
  if (file.size > MAX_SNAPSHOT_FILE_BYTES) {
    throw new SnapshotFileError("tooLarge", "The picture is too large.");
  }

  let bitmap: ImageBitmap;
  try {
    // Turned the way the camera says, as every image viewer shows it.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new SnapshotFileError("unreadable", "The browser cannot read this picture.");
  }

  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new SnapshotFileError("unreadable", "The browser cannot draw the picture.");
    // A see-through PNG would show whatever is behind it in each reader: give it the snapshot's white.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new SnapshotFileError("unreadable", "The browser cannot encode the picture.");
    return { fileName: `snapshot-${newGuid()}.png`, bytes: new Uint8Array(await blob.arrayBuffer()) };
  } finally {
    bitmap.close();
  }
}

/**
 * A viewpoint that is only a picture: no camera, no elements, no planes. BCF
 * allows it — every reader shows the snapshot — and "Update" can give it the
 * viewer's view later.
 */
export function pictureViewpoint(snapshot: { fileName: string; bytes: Uint8Array }): BcfViewpoint {
  const guid = newGuid();
  return {
    guid,
    fileName: `viewpoint-${guid}.bcfv`,
    camera: null,
    components: null,
    clippingPlanes: [],
    lines: [],
    bitmaps: [],
    snapshot,
  };
}

/**
 * Whether opening the viewpoint would change anything in the viewer. Elements
 * count even when none are listed: "everything visible" still undoes a hide.
 */
export function hasViewToRestore(viewpoint: BcfViewpoint): boolean {
  return Boolean(viewpoint.camera || viewpoint.components || viewpoint.clippingPlanes.length > 0);
}
