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
 *     checked), the service's header check, our driver — unpacked to /validator
 *   - `site-overlay.zip`: simple_spf and the rtree/pyproj stand-ins — unpacked
 *     into site-packages
 *   - `pyodide-lock.json`: only what is shipped, so nothing is fetched elsewhere
 *
 * Downloads are cached in `.cache/validator/`. Without network and without a
 * cache the validator is left out (the panel says it is unavailable) rather than
 * failing the build. `DICE_VALIDATOR=off` skips it.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { zipSync } from "fflate";

type Wheel = { name: string; version: string; file: string; url: string; sha256: string; license: string; imports: string[] };
type Archive = { name: string; url: string; sha256: string; to: string; include: string[]; exclude?: string[]; license: string };
type Manifest = {
  service: Record<string, string>;
  pyodide: { version: string; cdn: string; packages: string[]; dropDependencies: Record<string, string[]> };
  wheels: Wheel[];
  archives: Archive[];
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
  };
  writeFileSync(join(staging, "build.json"), JSON.stringify(build, null, 2));

  rmSync(out, { recursive: true, force: true });
  copyDir(staging, out);
  rmSync(staging, { recursive: true, force: true });
  console.log(`validator: ${build.packages.length} packages, ${(bytes / 1e6).toFixed(1)} MB in public/validator/`);
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
