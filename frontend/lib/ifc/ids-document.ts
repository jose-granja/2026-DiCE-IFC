/**
 * Parsing an IDS document for the engine — on the **main thread**.
 *
 * The second file allowed to import `@ifc-lite/*`, and it exists for one
 * concrete reason: `parseIDS` needs `DOMParser`, and a Web Worker does not have
 * one. The engine's own source says so:
 *
 * > Only Node needs the xmldom fallback. A browser WORKER has no DOMParser
 * > either, but it also never parses IDS (the main thread does, where
 * > DOMParser exists)…
 *
 * Passing the XML into the worker and parsing it there fails at runtime with
 * "No DOMParser implementation available" — which is what the first version of
 * this did. So the split is: **parse here, validate in the worker**. The parsed
 * document is plain data, so Comlink structured-clones it across the boundary.
 *
 * It stays a separate module rather than living in `ifc-lite-adapter.ts`
 * because the main thread must not pull in the parser, the geometry processor
 * and their WebAssembly just to read a specification. This imports the IDS
 * parser and nothing else.
 *
 * `EngineIdsDocument` is deliberately opaque. Nothing outside `lib/ifc` reads
 * its fields, so the engine's IDS types never leak into the app — the boundary
 * `docs/adr/001-ifc-engine.md` exists to protect.
 */

import { parseIDS } from "@ifc-lite/ids";

/** A parsed IDS document, meaningful only to the engine. */
export type EngineIdsDocument = { readonly __engineIdsDocument: unique symbol };

export class IdsDocumentParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdsDocumentParseError";
  }
}

export function parseIdsForEngine(xml: string): EngineIdsDocument {
  try {
    return parseIDS(xml) as unknown as EngineIdsDocument;
  } catch (error) {
    throw new IdsDocumentParseError(
      error instanceof Error
        ? `That IDS could not be read: ${error.message}`
        : "That IDS could not be read.",
    );
  }
}
