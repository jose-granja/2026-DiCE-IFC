/**
 * The IFC engine entry point for the whole app.
 *
 * Import from here, never from `@ifc-lite/*` or `@thatopen/*`. Swapping an
 * engine — for the whole app or for one module — is a change to this file and a
 * new implementation of `IfcEngineAdapter`, not a change to any page.
 *
 * See `docs/adr/001-ifc-engine.md`.
 */

import { ifcLiteAdapter } from "./ifc-lite-adapter";
import type { IfcEngineAdapter } from "./types";

export * from "./types";

/**
 * Implementations available to `getIfcAdapter`. A That Open implementation
 * would be registered here under `"that-open"` once it exists — the
 * conformance suite in `./conformance.ts` is what qualifies it.
 */
const ADAPTERS: Record<string, IfcEngineAdapter> = {
  "ifc-lite": ifcLiteAdapter,
};

const DEFAULT_ENGINE = "ifc-lite";

/**
 * The adapter a module should use.
 *
 * `engineId` exists so a single module can be moved to a different engine if it
 * hits a gap, without moving the rest of the app. Callers that do not care pass
 * nothing.
 */
export function getIfcAdapter(engineId: string = DEFAULT_ENGINE): IfcEngineAdapter {
  const adapter = ADAPTERS[engineId];
  if (!adapter) {
    throw new Error(
      `Unknown IFC engine "${engineId}". Registered: ${Object.keys(ADAPTERS).join(", ")}`,
    );
  }
  return adapter;
}

export function listIfcEngines(): string[] {
  return Object.keys(ADAPTERS);
}
