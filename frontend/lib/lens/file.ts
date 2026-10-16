/**
 * A list of lenses as a file — what the Lens tab downloads and uploads, and
 * what a project folder keeps at `lenses/lenses.json`.
 *
 * One format for both, so a predefined set of lenses made once — an office's
 * "Structural review" and "Fire compartments" — can be handed round on its own
 * or travel inside a project, and read back by either door.
 *
 * Read as untrusted input: every lens goes through `lensSchema`, and one that
 * does not pass is left out and counted rather than failing the rest.
 */

import { lensSchema } from "./schema";
import type { Lens } from "./types";

export const LENS_FILE_FORMAT = "dice-ifc-lenses";
export const LENS_FILE_VERSION = 1;
export const LENS_FILE_NAME = "dice-ifc-lenses.json";

export type LensFile = {
  format: typeof LENS_FILE_FORMAT;
  version: number;
  /** The lens that was on, when the list came from a project; a built-in's id is fine. */
  activeId: string | null;
  lenses: Lens[];
};

export type LensFileErrorCode = "notJson" | "notLensFile" | "newerVersion";

export class LensFileError extends Error {
  constructor(
    readonly code: LensFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LensFileError";
  }
}

/** The user's own lenses — built-ins are in every copy of the app and are not written. */
export function serializeLenses(lenses: Lens[], activeId: string | null = null): string {
  const file: LensFile = {
    format: LENS_FILE_FORMAT,
    version: LENS_FILE_VERSION,
    activeId,
    lenses: lenses.filter((lens) => !lens.builtin),
  };
  return JSON.stringify(file, null, 2);
}

export function parseLensFile(text: string): { lenses: Lens[]; activeId: string | null; skipped: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LensFileError("notJson", "The file is not valid JSON.");
  }
  if (!raw || typeof raw !== "object" || (raw as { format?: unknown }).format !== LENS_FILE_FORMAT) {
    throw new LensFileError("notLensFile", "The file is not a DiCE-IFC lens list.");
  }
  const file = raw as Partial<LensFile> & { lenses?: unknown };
  if (typeof file.version === "number" && file.version > LENS_FILE_VERSION) {
    throw new LensFileError("newerVersion", "The lens list was saved by a newer version of DiCE-IFC.");
  }
  const entries = Array.isArray(file.lenses) ? file.lenses : [];
  const lenses = entries.flatMap((entry) => {
    const result = lensSchema.safeParse(entry);
    // The schema has no `builtin`, so a file cannot pass one off as shipped with the app.
    return result.success ? [result.data as Lens] : [];
  });
  return {
    lenses,
    activeId: typeof file.activeId === "string" ? file.activeId : null,
    skipped: entries.length - lenses.length,
  };
}
