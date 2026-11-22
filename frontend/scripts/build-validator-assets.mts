/**
 * Assemble `public/validator/`: buildingSMART's validation service, to run in the
 * browser on Pyodide (ADR 018, `validator/README.md`).
 *
 *   - Pyodide's core, from the `pyodide` package (version pinned in the manifest)
 *   - the Pyodide packages the rules need, from Pyodide's CDN, each checked
 *     against the SHA-256 in Pyodide's own lockfile
 *   - the pinned wheels (ifcopenshell, the pure-Python ones from PyPI), checked
 *     against `validator/manifest.json`
 *   - `validator.zip`: ifc-gherkin-rules and its data model (pinned archives,
 *     checked), the service's header check, our driver — unpacked to /validator —
 *     and our own rules (DiCE-IFC-Rules, `customRules`), when there are any
 *   - `site-overlay.zip`: simple_spf and the rtree/pyproj stand-ins — unpacked
 *     into site-packages
 *   - `pyodide-lock.json`: only what is shipped, so nothing is fetched elsewhere
 *
 * Downloads are cached in `.cache/validator/`. Without network and without a
 * cache the validator is left out (the panel says it is unavailable) rather than
 * failing the build. `DICE_VALIDATOR=off` skips it.
 *
 * Our own rules come from the commit pinned in `customRules`, or, with
 * `DICE_RULES_DIR=<checkout>`, from a local checkout of the rules repository (to
 * write and test rules). Rules that cannot be shipped are left out with a
 * warning; buildingSMART's stages are built regardless.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { zipSync } from "fflate";

type Wheel = { name: string; version: string; file: string; url: string; sha256: string; license: string; imports: string[] };
type Archive = { name: string; url: string; sha256: string; to: string; include: string[]; exclude?: string[]; license: string };
/** Our own rules: a GitHub repository ("owner/repo") at a pinned commit, its tarball's SHA-256. */
type CustomRulesPin = { name: string; github: string | null; commit: string | null; sha256: string | null; license: string };
type Manifest = {
  service: Record<string, string>;
  pyodide: { version: string; cdn: string; packages: string[]; dropDependencies: Record<string, string[]> };
  wheels: Wheel[];
  archives: Archive[];
  customRules?: CustomRulesPin;
};
/** What was shipped of our own rules: in build.json, and as `custom_rules.json` for the driver. */
type CustomRulesBuild = {
  name: string;
  source: "github" | "local";
  github: string | null;
  commit: string | null;
  /** Built from a checkout with changes not committed. */
  modified: boolean;
  rules: string[];
  /** Where a rule's file is read on GitHub: this + its path in the repository. */
  docs: string | null;
};
type LockEntry = { name: string; version: string; file_name: string; sha256: string; depends: string[]; imports: string[];
  install_dir: string; package_type: string; unvendored_tests?: boolean };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "validator");
const out = join(root, "public", "validator");
const cache = join(root, ".cache", "validator");
const CORE = ["pyodide.mjs", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip"];

if (process.env.DICE_VALIDATOR === "off") {
  console.log("validator: skipped (DICE_VALIDATOR=off)");
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")) as Manifest;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function fetchVerified(url: string, expected: string, name: string): Promise<Uint8Array> {
  mkdirSync(cache, { recursive: true });
  const cached = join(cache, `${expected.slice(0, 16)}-${name}`);
  if (existsSync(cached)) {
    const bytes = new Uint8Array(readFileSync(cached));
    if (sha256(bytes) === expected) return bytes;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status} from ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`${name}: SHA-256 ${actual}, expected ${expected} (${url})`);
  writeFileSync(cached, bytes);
  return bytes;
}

/** Files of a .tar.gz, by path (pax `path` headers honoured, the archive's top folder dropped). */
function untar(gz: Uint8Array): Map<string, Uint8Array> {
  const tar = gunzipSync(gz);
  const files = new Map<string, Uint8Array>();
  const text = (from: number, length: number) => new TextDecoder().decode(tar.subarray(from, from + length)).replace(/\0[\s\S]*$/, "");
  let offset = 0;
  let paxPath: string | null = null;
  while (offset + 512 <= tar.length) {
    const name = text(offset, 100);
    if (!name) break;
    const size = parseInt(text(offset + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(tar[offset + 156] || 48);
    const prefix = text(offset + 345, 155);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (type === "x") {
      const match = /\d+ path=([^\n]+)\n/.exec(new TextDecoder().decode(body));
      paxPath = match ? match[1] : null;
    } else if (type === "0" || type === "\0") {
      const full = paxPath ?? (prefix ? `${prefix}/${name}` : name);
      files.set(full.split("/").slice(1).join("/"), body);
      paxPath = null;
    } else if (type !== "g") {
      paxPath = null;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

async function build() {
  const pyodideDir = join(root, "node_modules", "pyodide");
  const installed = JSON.parse(readFileSync(join(pyodideDir, "package.json"), "utf8")).version;
  if (installed !== manifest.pyodide.version) {
    throw new Error(`pyodide ${installed} installed, manifest pins ${manifest.pyodide.version}: npm install`);
  }
  const staging = `${out}.tmp`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  let bytes = 0;
  const put = (name: string, data: Uint8Array) => {
    writeFileSync(join(staging, name), data);
    bytes += data.length;
  };

  // 1. Pyodide's core.
  for (const name of CORE) {
    copyFileSync(join(pyodideDir, name), join(staging, name));
    bytes += statSync(join(staging, name)).size;
  }

  // 2. Its packages: what the rules need and their dependencies, minus the declared-but-unused.
  const baseLock = JSON.parse(readFileSync(join(pyodideDir, "pyodide-lock.json"), "utf8")) as {
    info: Record<string, unknown>;
    packages: Record<string, LockEntry>;
  };
  // Python's own name comparison: case and "-"/"_" do not matter (the lockfile mixes them).
  const norm = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");
  const byName = new Map(Object.entries(baseLock.packages).map(([key, entry]) => [norm(key), [key, entry] as const]));
  const keep = new Map<string, LockEntry>();
  const visit = (name: string) => {
    const found = byName.get(norm(name));
    if (!found) throw new Error(`Pyodide ${manifest.pyodide.version} has no package ${name}`);
    const [key, entry] = found;
    if (keep.has(key)) return;
    const dropped = (manifest.pyodide.dropDependencies[key] ?? []).map(norm);
    const depends = entry.depends.filter((dep) => !dropped.includes(norm(dep)));
    keep.set(key, { ...entry, depends });
    depends.forEach(visit);
  };
  manifest.pyodide.packages.forEach(visit);
  for (const entry of keep.values()) {
    put(entry.file_name, await fetchVerified(`${manifest.pyodide.cdn}${entry.file_name}`, entry.sha256, entry.file_name));
  }

  // 3. The pinned wheels.
  const wheelEntries: Record<string, LockEntry> = {};
  for (const wheel of manifest.wheels) {
    put(wheel.file, await fetchVerified(wheel.url, wheel.sha256, wheel.file));
    wheelEntries[wheel.name] = {
      name: wheel.name, version: wheel.version, file_name: wheel.file, sha256: wheel.sha256,
      depends: [], imports: wheel.imports, install_dir: "site", package_type: "package", unvendored_tests: false,
    };
  }

  // 4. The lockfile of exactly what is shipped.
  const lock = { info: baseLock.info, packages: { ...Object.fromEntries(keep), ...wheelEntries } };
  writeFileSync(join(staging, "pyodide-lock.json"), JSON.stringify(lock));

  // 5. validator.zip: the rules, their data model, the header check, the driver.
  const tree: Record<string, Uint8Array> = {};
  for (const archive of manifest.archives) {
    const files = untar(await fetchVerified(archive.url, archive.sha256, `${archive.name}.tar.gz`));
    for (const [path, data] of files) {
      const included = archive.include.some((prefix) => (prefix.endsWith("/") || prefix === "" ? path.startsWith(prefix) : path === prefix));
      if (!included || (archive.exclude ?? []).includes(path)) continue;
      if (/(^|\/)(test|tests|docs)\//.test(path) || /\.(png|svg|ifc)$/i.test(path)) continue;
      tree[`${archive.to}/${path}`] = data;
    }
  }
  // Our replacements for files of the rules (`python/overrides/`, e.g. a Django-free
  // validation_results.py): each must replace a file that is there.
  const overrides = join(source, "python", "overrides");
  for (const file of existsSync(overrides) ? walk(overrides) : []) {
    const target = `rules/${relative(overrides, file)}`;
    if (!(target in tree)) throw new Error(`override ${target} replaces nothing`);
    tree[target] = new Uint8Array(readFileSync(file));
  }
  const python = join(source, "python");
  tree["dice_validator.py"] = new Uint8Array(readFileSync(join(python, "dice_validator.py")));
  for (const file of walk(join(python, "vendor", "header_policy"))) {
    tree[`header_policy/${relative(join(python, "vendor", "header_policy"), file)}`] = new Uint8Array(readFileSync(file));
  }
  // Our own rules, next to buildingSMART's so they share its steps and environment.
  const custom = await customRules(tree);
  put("validator.zip", zipSync(tree, { level: 9 }));

  // 6. site-overlay.zip: into site-packages.
  const overlay: Record<string, Uint8Array> = {};
  for (const file of walk(join(python, "vendor", "simple_spf"))) {
    overlay[`ifcopenshell/simple_spf/${relative(join(python, "vendor", "simple_spf"), file)}`] = new Uint8Array(readFileSync(file));
  }
  for (const file of walk(join(python, "shims"))) {
    overlay[relative(join(python, "shims"), file)] = new Uint8Array(readFileSync(file));
  }
  put("site-overlay.zip", zipSync(overlay, { level: 9 }));

  // 7. Notices: what ships, its licence and where it came from.
  const notice = [
    "In-browser IFC validation (ADR 018): third-party components served from /validator/.",
    "",
    `Pyodide ${manifest.pyodide.version} — MPL-2.0 — https://github.com/pyodide/pyodide`,
    ...[...keep.values()].map((entry) => `${entry.name} ${entry.version} — Pyodide build; licence in the package's metadata — ${manifest.pyodide.cdn}${entry.file_name}`),
    ...manifest.wheels.map((wheel) => `${wheel.name} ${wheel.version} — ${wheel.license} — ${wheel.url}`),
    ...manifest.archives.map((archive) => `${archive.name} — ${archive.license} — ${archive.url}`),
    ...(custom ? [`${custom.name} (${custom.rules.length} rules) — ${manifest.customRules?.license ?? "see its repository"} — ${custom.github ? `https://github.com/${custom.github}${custom.commit ? `/tree/${custom.commit}` : ""}` : "a local checkout"}`] : []),
    "buildingSMART validate (header policy) — MIT — https://github.com/buildingSMART/validate",
    "ifcopenshell.simple_spf (from IfcOpenShell v0.8.6-8b5b400) — LGPL-2.1 — https://github.com/IfcOpenShell/step-file-parser",
    "EPSG Geodetic Parameter Dataset (via PROJ 9.5.1, EPSG v11.022) — EPSG terms of use — https://epsg.org/terms-of-use.html",
    "",
  ].join("\n");
  writeFileSync(join(staging, "NOTICE.txt"), notice);

  // 8. What was built, for the panel and for the record.
  const build = {
    service: manifest.service,
    pyodide: manifest.pyodide.version,
    packages: [...keep.keys(), ...Object.keys(wheelEntries)].sort(),
    bytes,
    customRules: custom,
  };
  writeFileSync(join(staging, "build.json"), JSON.stringify(build, null, 2));

  rmSync(out, { recursive: true, force: true });
  copyDir(staging, out);
  rmSync(staging, { recursive: true, force: true });
  console.log(`validator: ${build.packages.length} packages, ${(bytes / 1e6).toFixed(1)} MB in public/validator/`
    + (custom ? `; ${custom.name}: ${custom.rules.join(", ")} (${custom.source}${custom.commit ? ` ${custom.commit.slice(0, 7)}` : ""}${custom.modified ? ", with uncommitted changes" : ""})` : ""));
}

// ---------------------------------------------------------------------------
// Our own rules (DiCE-IFC-Rules): their own stage, `dice_rules` (ADR 018)
// ---------------------------------------------------------------------------

/** Where they go in validator.zip: features run by path, steps loaded only in their stage (dice_validator.py). */
const CUSTOM_FEATURES = "rules/features/custom/";
const CUSTOM_STEPS = "rules/features/steps/dice_custom_steps/";
const CUSTOM_STEPS_LOADER = `"""DiCE-IFC: the steps of our own rules (DiCE-IFC-Rules, features/steps/), as the package
dice_custom_steps — loaded only when dice_validator runs their stage, so buildingSMART's
stages run with buildingSMART's steps alone."""
import importlib
import os
import pkgutil

if os.environ.get("DICE_RULES_STAGE") == "1":
    import dice_custom_steps

    for _module in pkgutil.iter_modules(dice_custom_steps.__path__):
        importlib.import_module(f"dice_custom_steps.{_module.name}")
`;

/** The rules repository's files, by path: a local checkout (DICE_RULES_DIR) or the pinned commit. */
async function customRuleSource(): Promise<{ files: Map<string, Uint8Array>; meta: Omit<CustomRulesBuild, "rules" | "docs"> } | null> {
  const pin = manifest.customRules;
  const local = process.env.DICE_RULES_DIR;
  if (local) {
    const dir = resolve(local);
    if (!existsSync(dir)) throw new Error(`DICE_RULES_DIR ${dir} does not exist`);
    const files = new Map<string, Uint8Array>();
    const skip = (path: string) => /(^|\/)(\.git|node_modules|__pycache__)(\/|$)/.test(path);
    for (const file of walk(dir)) {
      const path = relative(dir, file).split("\\").join("/");
      if (!skip(path)) files.set(path, new Uint8Array(readFileSync(file)));
    }
    const git = (...args: string[]) => {
      try {
        return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        return null;
      }
    };
    return {
      files,
      meta: { name: pin?.name ?? "custom rules", source: "local", github: pin?.github ?? null,
        commit: git("rev-parse", "HEAD"), modified: Boolean(git("status", "--porcelain")) },
    };
  }
  if (!pin?.github || !pin.commit || !pin.sha256) return null;
  const url = `https://codeload.github.com/${pin.github}/tar.gz/${pin.commit}`;
  return {
    files: untar(await fetchVerified(url, pin.sha256, `${pin.name}.tar.gz`)),
    meta: { name: pin.name, source: "github", github: pin.github, commit: pin.commit, modified: false },
  };
}

/**
 * Put our rules into validator.zip's tree: `features/rules/**.feature` under
 * features/custom/, `features/steps/` as the package dice_custom_steps. Each rule
 * must be named "CODE - Title", its code unique and its prefix not one of
 * buildingSMART's, so a finding never reads as theirs.
 */
async function customRules(tree: Record<string, Uint8Array>): Promise<CustomRulesBuild | null> {
  let source;
  try {
    source = await customRuleSource();
  } catch (error) {
    console.warn(`validator: custom rules left out — ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  if (!source) return null;
  const theirs = new Set(Object.keys(tree).map((path) => /^rules\/features\/rules\/([^/]+)\//.exec(path)?.[1]).filter(Boolean));
  const placed: Record<string, Uint8Array> = {};
  const codes = new Map<string, string>();
  const problems: string[] = [];
  let steps = false;
  for (const [path, data] of source.files) {
    const feature = /^features\/rules\/(.+\.feature)$/.exec(path);
    if (feature) {
      const name = /^\s*Feature:\s*(.+?)\s*$/m.exec(new TextDecoder().decode(data))?.[1] ?? "";
      const code = name.split(" - ")[0].trim();
      // A prefix of letters (ours: "DiCE") and three digits; never a prefix of buildingSMART's, in any case.
      const prefix = /^([A-Za-z]{2,8})\d{3}$/.exec(code)?.[1];
      if (!prefix || !name.includes(" - ")) problems.push(`${path}: the feature must be named "PREFIX123 - Title" (letters, then three digits), not "${name}"`);
      else if (theirs.has(prefix.toUpperCase())) problems.push(`${path}: ${prefix} is one of buildingSMART's prefixes`);
      else if (codes.has(code)) problems.push(`${path}: ${code} is also ${codes.get(code)}`);
      else codes.set(code, path);
      placed[`${CUSTOM_FEATURES}${feature[1]}`] = data;
      continue;
    }
    const step = /^features\/steps\/(.+)$/.exec(path);
    if (step && !/\.md$/i.test(step[1])) {
      placed[`${CUSTOM_STEPS}${step[1]}`] = data;
      if (step[1].endsWith(".py")) steps = true;
    }
    if (/^LICENSE(\.\w+)?$/i.test(path)) placed[`${CUSTOM_FEATURES}${path}`] = data;
  }
  if (problems.length) {
    console.warn(`validator: custom rules left out —\n  ${problems.join("\n  ")}`);
    return null;
  }
  if (!codes.size) {
    console.warn(`validator: custom rules left out — no features/rules/**/*.feature in ${source.meta.name}`);
    return null;
  }
  if (steps) {
    placed[`${CUSTOM_STEPS}__init__.py`] ??= new Uint8Array();
    placed["rules/features/steps/zz_dice_custom_steps.py"] = new TextEncoder().encode(CUSTOM_STEPS_LOADER);
  }
  Object.assign(tree, placed);
  const { github, commit, source: from } = source.meta;
  const build: CustomRulesBuild = {
    ...source.meta,
    rules: [...codes.keys()].sort(),
    // A pinned commit's files, or, from a checkout, the default branch's (the commit may not be pushed).
    docs: github ? `https://github.com/${github}/blob/${from === "github" && commit ? commit : "HEAD"}/` : null,
  };
  tree["custom_rules.json"] = new TextEncoder().encode(JSON.stringify(build));
  return build;
}

function copyDir(from: string, to: string) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) copyFileSync(join(from, name), join(to, name));
}

try {
  await build();
} catch (error) {
  // A build without the validator still works; the panel says it is unavailable.
  rmSync(`${out}.tmp`, { recursive: true, force: true });
  console.warn(`validator: not built — ${error instanceof Error ? error.message : String(error)}`);
}
