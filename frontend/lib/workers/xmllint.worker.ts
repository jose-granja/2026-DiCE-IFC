/**
 * libxml2 (WebAssembly) in a Web Worker.
 *
 * **The only module in the app that imports `xmllint-wasm`**, and it is a
 * worker for two reasons.
 *
 * The first is the ordinary one: schema validation is a megabyte of
 * WebAssembly and pure CPU over the whole document, which is exactly what
 * AGENTS.md §7 says belongs off the UI thread.
 *
 * The second is a resolution problem worth recording. `xmllint-wasm` declares
 * `main: index-node.js` (CommonJS, `require`s `worker_threads`) and
 * `browser: index-browser.mjs`, with no `exports` map. Importing it from a
 * Client Component made Turbopack resolve it **twice** — once for the browser
 * bundle and once for the SSR pass — and the SSR pass has to resolve
 * `index-node.js`, whose `worker_threads` dependency `next.config.ts` aliases
 * for the `browser` condition only. That produced an intermittent
 * "Module not found: Can't resolve 'xmllint-wasm'" naming a package that was
 * installed and resolvable, with an import trace listing both
 * `[Client Component Browser]` and `[Client Component SSR]`.
 *
 * A worker module is only ever compiled for the browser, so the SSR branch
 * does not exist and the `browser` field applies unambiguously. The fix is
 * structural rather than a guess at the resolver's behaviour.
 */

import * as Comlink from "comlink";

export type XmllintFile = { fileName: string; contents: string };

export type XmllintRequest = {
  xml: XmllintFile[];
  schema: string[];
  preload?: XmllintFile[];
};

export type XmllintError = {
  message: string;
  line?: number;
};

export type XmllintResult = {
  valid: boolean;
  errors: XmllintError[];
};

type XmllintModule = {
  validateXML: (options: XmllintRequest) => Promise<{
    valid: boolean;
    errors?: Array<{
      message?: string;
      rawMessage?: string;
      loc?: { lineNumber?: number };
    }>;
  }>;
};

/**
 * Dynamic, so the WebAssembly is only fetched when someone actually validates —
 * spawning the worker costs nothing until then.
 */
async function load(): Promise<XmllintModule> {
  const module_ = await import("xmllint-wasm");
  return ((module_ as { default?: unknown }).default ??
    module_) as unknown as XmllintModule;
}

export const xmllintApi = {
  async validate(request: XmllintRequest): Promise<XmllintResult> {
    const { validateXML } = await load();
    const result = await validateXML(request);

    return {
      valid: result.valid,
      errors: (result.errors ?? []).map((error) => ({
        line: error.loc?.lineNumber,
        // libxml2's raw text is precise but noisy; the message without the
        // file/line prefix reads better next to a line number.
        message: error.message ?? error.rawMessage ?? "Unknown schema error",
      })),
    };
  },
};

export type XmllintWorkerApi = typeof xmllintApi;

Comlink.expose(xmllintApi);
