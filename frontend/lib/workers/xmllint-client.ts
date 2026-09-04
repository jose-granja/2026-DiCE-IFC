"use client";

/**
 * Main-thread handle on the libxml2 worker.
 *
 * Everything that validates XML against a schema — `lib/ids/validate.ts` and
 * `lib/bcf/validate.ts` — goes through here. Neither imports `xmllint-wasm`
 * itself; see the note in `xmllint.worker.ts` for why that matters.
 *
 * One worker, kept alive between validations: starting it re-downloads and
 * re-instantiates a megabyte of WebAssembly, and validating twice in a row is
 * the normal case while someone edits a specification.
 */

import * as Comlink from "comlink";

import type {
  XmllintRequest,
  XmllintResult,
  XmllintWorkerApi,
} from "./xmllint.worker";

let worker: Worker | null = null;
let api: Comlink.Remote<XmllintWorkerApi> | null = null;

export type XmllintRunner = (request: XmllintRequest) => Promise<XmllintResult>;

/**
 * Overridden by `vitest.setup.ts` so tests run libxml2 in-process.
 *
 * jsdom has no `Worker`, and the point of the tests is to check our schemas and
 * our XML against the real libxml2 — not to check that Comlink forwards a
 * message. The default path, the one that ships, is the worker below.
 */
let runner: XmllintRunner | null = null;

export function setXmllintRunner(next: XmllintRunner | null) {
  runner = next;
}

function getApi(): Comlink.Remote<XmllintWorkerApi> {
  if (!api) {
    worker = new Worker(new URL("./xmllint.worker.ts", import.meta.url), {
      type: "module",
    });
    api = Comlink.wrap<XmllintWorkerApi>(worker);
  }
  return api;
}

export async function validateXml(request: XmllintRequest): Promise<XmllintResult> {
  if (runner) return runner(request);
  return getApi().validate(request);
}

/** Release the worker. Used by tests; the app keeps it for the session. */
export function disposeXmllint() {
  worker?.terminate();
  worker = null;
  api = null;
}

export type { XmllintRequest, XmllintResult } from "./xmllint.worker";
