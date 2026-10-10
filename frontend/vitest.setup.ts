/**
 * Run libxml2 in-process for tests.
 *
 * The app validates XML in a Web Worker (see `lib/workers/xmllint.worker.ts`).
 * jsdom has no `Worker`, and in any case the point of these tests is to check
 * our schemas and our generated XML against the real libxml2 — not to check
 * that Comlink forwards a message. So the worker is replaced by a direct call
 * to the same library, which `vitest.config.mts` aliases to its Node build.
 */

import { setXmllintRunner } from "@/lib/workers/xmllint-client";

setXmllintRunner(async (request) => {
  const module_ = await import("xmllint-wasm");
  const { validateXML } = (module_ as { default?: unknown }).default
    ? ((module_ as unknown as { default: typeof module_ }).default as typeof module_)
    : module_;

  const result = await validateXML(request as Parameters<typeof validateXML>[0]);

  return {
    valid: result.valid,
    errors: (result.errors ?? []).map((error) => ({
      line: error.loc?.lineNumber,
      message: error.message ?? error.rawMessage ?? "Unknown schema error",
    })),
  };
});
