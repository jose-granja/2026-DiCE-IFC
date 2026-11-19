/**
 * Run the built validator (`public/validator/`) on an IFC file under Node, with
 * nothing but those files — the same loading the browser worker does — and print
 * each stage's result. For checking a build, and for comparing with the service.
 *
 *   npm run validator:check -- path/to/model.ifc [stage …] [--json out.json]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "public", "validator");
const args = process.argv.slice(2);
const jsonAt = args.indexOf("--json");
const jsonOut = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : null;
const [model, ...only] = args;
if (!model) {
  console.error("usage: npm run validator:check -- model.ifc [stage …] [--json out.json]");
  process.exit(2);
}

const STAGES = ["header_syntax", "header", "syntax", "prerequisites", "schema", "normative_ia", "normative_ip", "industry_practices"];
const t0 = performance.now();
const lap = (label: string) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)} s] ${label}`);

process.on("uncaughtException", (error) => {
  console.error("validator check failed:", String(error?.message ?? error).split("\n").slice(-40).join("\n"));
  process.exit(1);
});
process.on("unhandledRejection", (error: unknown) => {
  console.error("validator check failed:", String((error as Error)?.message ?? error).split("\n").slice(-40).join("\n"));
  process.exit(1);
});

const { loadPyodide } = await import(pathToFileURL(join(assets, "pyodide.mjs")).href);
const py = await loadPyodide({
  indexURL: `${assets}/`,
  lockFileURL: join(assets, "pyodide-lock.json"),
  packageCacheDir: assets,
  // As the worker: a fixed hash seed, so set orders (in messages, in a rule's tags) repeat run to run.
  env: { PYTHONHASHSEED: "0" },
  stdout: () => {},
  stderr: () => {},
});
const lock = JSON.parse(readFileSync(join(assets, "pyodide-lock.json"), "utf8"));
await py.loadPackage(Object.keys(lock.packages), { messageCallback: () => {} });
const site = py.runPython("import site; site.getsitepackages()[0]");
py.unpackArchive(new Uint8Array(readFileSync(join(assets, "site-overlay.zip"))), "zip", { extractDir: site });
py.unpackArchive(new Uint8Array(readFileSync(join(assets, "validator.zip"))), "zip", { extractDir: "/validator" });
py.runPython("import sys; sys.path.insert(0, '/validator'); import dice_validator");
lap("loaded from public/validator/");

py.FS.mkdirTree("/work");
py.FS.writeFile("/work/model.ifc", new Uint8Array(readFileSync(model)));
const results: unknown[] = [];
for (const stage of only.length ? only : STAGES) {
  const result = JSON.parse(await py.runPythonAsync(`dice_validator.run_stage(${JSON.stringify(stage)}, "/work/model.ifc")`));
  results.push(result);
  const outcomes = result.outcomes as Array<{ severity: string; rule?: string; feature?: string }>;
  const counts: Record<string, number> = {};
  for (const o of outcomes) {
    const key = `${o.rule ?? ""}${o.rule ? " " : ""}${o.severity}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const failing = Object.entries(counts).filter(([key]) => /WARNING|ERROR/.test(key)).sort();
  // WebAssembly memory only grows: this is the run's peak so far (Pyodide's internal handle, for measuring only).
  const heapMb = Math.round(((py as { _module?: { HEAP8?: Int8Array } })._module?.HEAP8?.length ?? 0) / 1e6);
  lap(`${stage}: ${result.status}, ${result.info.seconds} s, wasm ${heapMb} MB` + (failing.length ? ` — ${failing.map(([k, n]) => `${k} ×${n}`).join(", ")}` : ""));
  for (const crash of result.info.crashed ?? []) console.log(`    rule error ${crash.rule}: ${crash.error}`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 1));
