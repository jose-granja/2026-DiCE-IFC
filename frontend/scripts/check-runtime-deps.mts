/**
 * Fail the build if shipped code imports a devDependency.
 *
 *   npx tsx scripts/check-runtime-deps.mts
 *
 * `xmllint-wasm` was declared as a devDependency while being imported from
 * `lib/ids/validate.ts` and `lib/bcf/validate.ts` — both shipped client code.
 * Locally that resolves, because a dev install has every package on disk. Any
 * install that omits dev dependencies — `npm ci --omit=dev`, a production
 * Docker image — drops it, and the build fails with "Module not found:
 * xmllint-wasm" for a package that is right there in package.json.
 *
 * The failure is invisible in normal development and total in production, which
 * is exactly the kind of thing worth a check rather than a memory.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** True when `index` falls in a block comment, or on a line-comment line. */
function inComment(
  source: string,
  blocks: ReadonlyArray<readonly [number, number]>,
  index: number,
): boolean {
  if (blocks.some(([start, end]) => index >= start && index < end)) return true;

  const lineStart = source.lastIndexOf("\n", index) + 1;
  return source.slice(lineStart, index).trimStart().startsWith("//");
}

/** Directories whose imports end up in the bundle. */
const SHIPPED = ["app", "components", "lib", "config"];
const SHIPPED_FILES = ["proxy.ts", "next.config.ts"];

/**
 * Build scripts. Not shipped, but they still have to resolve.
 *
 * These run from `prebuild`, so an undeclared import here fails the production
 * image rather than the bundle — and it fails *only* there, because a
 * development machine has the package hoisted from something else's
 * dependencies. `scripts/copy-cesium-assets.mts` imported `esbuild` that way
 * and broke the Docker build while every local command passed.
 *
 * A devDependency is correct for these, so they are checked for being declared
 * at all rather than for being declared in the right half.
 */
const BUILD_SCRIPTS = ["scripts"];

/** Test files may import test tooling; they are not shipped. */
const IS_TEST = /(^|\/)__tests__\/|\.test\.[cm]?tsx?$/;

/**
 * `lib/ifc/conformance.ts` imports vitest and lives outside `__tests__/`
 * because both the adapter test and any future engine's test share it. Nothing
 * that renders reaches it — it is only ever imported from a test file.
 */
const ALLOWED = new Set(["lib/ifc/conformance.ts"]);

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const dev = new Set(Object.keys(pkg.devDependencies ?? {}));
const runtime = new Set(Object.keys(pkg.dependencies ?? {}));

function* walk(target: string): Generator<string> {
  const full = path.join(ROOT, target);
  let stats;
  try {
    stats = statSync(full);
  } catch {
    return;
  }

  if (stats.isFile()) {
    if (/\.[cm]?tsx?$/.test(target) && !IS_TEST.test(target)) yield target;
    return;
  }
  for (const entry of readdirSync(full)) yield* walk(path.join(target, entry));
}

const problems: string[] = [];
const undeclared: string[] = [];

const shippedFiles = new Set([
  ...SHIPPED.flatMap((d) => [...walk(d)]),
  ...SHIPPED_FILES,
]);
const scriptFiles = BUILD_SCRIPTS.flatMap((d) => [...walk(d)]);

for (const file of [...shippedFiles, ...scriptFiles]) {
  if (ALLOWED.has(file)) continue;
  const shipped = shippedFiles.has(file);

  let source: string;
  try {
    source = readFileSync(path.join(ROOT, file), "utf8");
  } catch {
    continue;
  }

  // Where every /* … */ sits, so matches inside one can be ignored.
  const blockComments = [...source.matchAll(/\/\*[\s\S]*?\*\//g)].map(
    (comment) => [comment.index, comment.index + comment[0].length] as const,
  );

  // Static and dynamic imports. Deliberately not a full parser: this runs on
  // every build and only needs to spot bare specifiers.
  for (const match of source.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g,
  )) {
    // Skip matches sitting in a comment.
    //
    // The regex is not a parser, so ordinary prose can look like an import. A
    // comment reading `to tell "not loaded" from "loaded elsewhere"` matched
    // `from "loaded elsewhere"`, and one explaining why we no longer
    // `import("cesium")` matched that. Both failed the build asking for a
    // package that was never imported. A check that fails on the wording of a
    // comment is worse than no check.
    //
    // Line comments are recognised by their own line; block comments need the
    // ranges, because a line inside one need not start with `*`.
    if (inComment(source, blockComments, match.index)) continue;

    const specifier = match[1];
    if (/^[./]/.test(specifier) || specifier.startsWith("@/")) continue;
    if (specifier.startsWith("node:")) continue;
    // Type-only aliases for code that is served rather than bundled. They
    // resolve through `tsconfig` paths to a .d.ts and never reach a package.
    if (specifier.endsWith("-runtime")) continue;

    const name = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];

    if (isBuiltin(name)) continue;

    // A build script may use a devDependency; shipped code may not.
    if (shipped && dev.has(name)) {
      problems.push(`${name} (imported by ${file})`);
    } else if (!runtime.has(name) && !dev.has(name)) {
      undeclared.push(`${name} (imported by ${file})`);
    }
  }
}

function isBuiltin(name: string): boolean {
  // `generated.ts` inlines XSDs whose documentation text contains things that
  // look like import statements; and Node builtins may appear unprefixed.
  return ["fs", "path", "crypto", "url", "util", "buffer", "keybase"].includes(name);
}

const unique = (values: string[]) => [...new Set(values)].sort();

if (problems.length > 0) {
  console.error(
    "These packages are imported by shipped code but declared as devDependencies.\n" +
      "They will be missing from any install that omits dev dependencies:\n",
  );
  for (const problem of unique(problems)) console.error(`  ${problem}`);
  console.error("\nMove them to `dependencies` in package.json.");
  process.exit(1);
}

if (undeclared.length > 0) {
  console.error("These packages are imported but not declared at all:\n");
  for (const problem of unique(undeclared)) console.error(`  ${problem}`);
  process.exit(1);
}

console.log("Runtime dependencies are declared correctly.");
