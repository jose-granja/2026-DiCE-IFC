"use client";

/**
 * Unwrapping `.ifczip` containers.
 *
 * An ifcZIP is a ZIP holding an `.ifc`. A **signed** one is the same archive
 * with `META-INF/` added — that is the whole point of ADR 002's container
 * choice: it stays a valid ifcZIP for tools that know nothing about signatures.
 * So the viewer can open both with the same code, and gets signature checking
 * for free on the ones that carry it.
 *
 * The model bytes handed to the parser are the entry's bytes **exactly as
 * stored**. That matters beyond tidiness: the signature covers those bytes, so
 * anything that rewrote them on the way in would make a valid container report
 * as tampered.
 */

import { unzipSync } from "fflate";

export type UnwrappedModel = {
  /** The `.ifc` inside, as a File the worker can parse. */
  file: File;
  /** The container's own bytes, kept so the signature can be verified. */
  container: Uint8Array | null;
  /** Name of the entry the model came from, for display. */
  entryName: string | null;
  /**
   * The archive's images, by lower-case file name without its folder: what the
   * model's `IfcImageTexture`s refer to (a relative name, usually beside the
   * model). Empty for a plain `.ifc`.
   */
  images: Map<string, Uint8Array>;
};

/** Raster files a texture reference may name. */
const IMAGE_ENTRY = /\.(png|jpe?g|webp|gif|bmp)$/i;

/** The key an image is found by: its file name, lower-cased, without folders. */
export function imageKey(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).toLowerCase();
}

/** ZIP local file header, `PK\003\004`. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export function looksLikeZip(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((byte, index) => bytes[index] === byte);
}

/**
 * Return the model to parse.
 *
 * A plain `.ifc` passes straight through — this must not cost anything for the
 * ordinary case. Anything that is actually a ZIP is opened and searched for a
 * model, whatever the file is called: `.ifczip`, `.zip`, or an `.ifc` that is
 * really an archive.
 */
export async function unwrapModel(file: File): Promise<UnwrappedModel> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (!looksLikeZip(head)) {
    return { file, container: null, entryName: null, images: new Map() };
  }

  const container = new Uint8Array(await file.arrayBuffer());

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(container);
  } catch (error) {
    throw new Error(
      `${file.name} looks like a ZIP but could not be opened: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }

  const found = findModelEntry(entries);
  if (!found) {
    throw new Error(
      `${file.name} is a ZIP but contains no .ifc file. ` +
        `An ifcZIP holds one model; this archive holds ${
          Object.keys(entries).length
        } entries, none of them a model.`,
    );
  }

  return {
    // The stored bytes, unmodified — the signature is over exactly these.
    file: new File([found.bytes as BlobPart], found.name, {
      type: "application/x-step",
    }),
    container,
    entryName: found.name,
    images: archiveImages(entries),
  };
}

function archiveImages(entries: Record<string, Uint8Array>): Map<string, Uint8Array> {
  const images = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.startsWith("META-INF/") || !IMAGE_ENTRY.test(name)) continue;
    // The first of two images with the same name wins, as it would on disk.
    if (!images.has(imageKey(name))) images.set(imageKey(name), bytes);
  }
  return images;
}

/**
 * The model entry.
 *
 * `META-INF/` is skipped: it holds the signature and the manifest, never a
 * model. The largest candidate wins when there are several, because an archive
 * with more than one `.ifc` has no defined "main" model and the biggest is the
 * least surprising guess.
 */
function findModelEntry(
  entries: Record<string, Uint8Array>,
): { name: string; bytes: Uint8Array } | null {
  const candidates = Object.entries(entries)
    .filter(([name]) => !name.startsWith("META-INF/") && name !== "mimetype")
    .filter(([name]) => /\.(ifc|ifcxml)$/i.test(name))
    .sort((a, b) => b[1].length - a[1].length);

  const first = candidates[0];
  return first ? { name: first[0], bytes: first[1] } : null;
}
