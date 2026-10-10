/**
 * Write the licence notices for everything this application ships.
 *
 *   node --experimental-strip-types scripts/generate-licenses.mts
 *
 * MIT, ISC, BSD and Apache-2.0 all ask that the copyright and licence text
 * travel with what is redistributed, and a web app redistributes its
 * dependencies to every visitor. The result is `public/third-party-licenses.txt`,
 * linked from the About page.
 *
 * It walks the *production* dependency closure from `package.json` — the same
 * set that ends up in the browser bundle and the server — through
 * `node_modules`, so it cannot drift from what is installed. Packages that share
 * the same notice are listed together under one copy of it.
 *
 * Generated, not committed: it is derived entirely from `node_modules`, like
 * `public/cesium/`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "public", "third-party-licenses.txt");

type Manifest = {
  name: string;
  version: string;
  license?: string | { type?: string };
  licenses?: Array<{ type?: string }>;
  repository?: string | { url?: string };
  homepage?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Manifest;

/** Node's own lookup: `node_modules/<name>` here, then in each parent directory. */
function locate(name: string, from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

const licenceOf = (manifest: Manifest): string => {
  if (typeof manifest.license === "string") return manifest.license;
  if (manifest.license?.type) return manifest.license.type;
  const listed = manifest.licenses?.map((entry) => entry.type).filter(Boolean);
  return listed?.length ? listed.join(" OR ") : "UNKNOWN";
};

const repositoryOf = (manifest: Manifest): string => {
  const raw = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  return (raw ?? manifest.homepage ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
};

/** The notice file shipped with a package: LICENSE, LICENCE, COPYING, NOTICE. */
function noticeOf(dir: string): string {
  const files = readdirSync(dir).filter(
    (file) => /^(licen[sc]e|copying|notice)(\.|$|-)/i.test(file) && statSync(join(dir, file)).isFile(),
  );
  files.sort((a, b) => Number(/notice/i.test(a)) - Number(/notice/i.test(b)));
  return files
    .map((file) => readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n").trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Packages that ship no licence metadata, with what their own repository states.
 * Kept to the ones actually found missing, and checked by hand.
 */
const KNOWN: Record<string, { license: string; notice: string }> = {
  "png-js": {
    license: "MIT",
    notice:
      "png.js — Copyright (c) Devon Govett. Released under the MIT licence, as stated in its repository\n(https://github.com/devongovett/png.js); the package itself ships no licence file.",
  },
};

type Found = { name: string; version: string; license: string; repository: string; notice: string };

const seen = new Map<string, Found>();
const queue: Array<{ name: string; from: string }> = [];
const rootManifest = read(join(root, "package.json"));
for (const name of Object.keys(rootManifest.dependencies ?? {})) queue.push({ name, from: root });

while (queue.length > 0) {
  const { name, from } = queue.pop()!;
  const dir = locate(name, from);
  // Optional packages for other platforms (native binaries) are legitimately absent.
  if (!dir) continue;
  const manifest = read(join(dir, "package.json"));
  const key = `${manifest.name}@${manifest.version}`;
  if (seen.has(key)) continue;
  const known = KNOWN[manifest.name];
  seen.set(key, {
    name: manifest.name,
    version: manifest.version,
    license: licenceOf(manifest) === "UNKNOWN" && known ? known.license : licenceOf(manifest),
    repository: repositoryOf(manifest),
    notice: noticeOf(dir) || known?.notice || "",
  });
  for (const dependency of [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]) {
    queue.push({ name: dependency, from: dir });
  }
}

const packages = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

// Packages whose notice text is identical share one copy of it.
const groups = new Map<string, Found[]>();
for (const found of packages) {
  const text = found.notice || `(No licence file is shipped with this package; it declares ${found.license}.)`;
  const key = createHash("sha256").update(text).digest("hex");
  groups.set(key, [...(groups.get(key) ?? []), found]);
}

const rule = "=".repeat(78);
const lines: string[] = [
  "DiCE-IFC — third-party notices",
  "",
  "DiCE-IFC itself is released under the MIT licence (see LICENSE in the source repository).",
  "It is built on the open-source software and data listed below.",
  "",
  `Generated from the installed production dependencies: ${packages.length} packages.`,
  "",
  rule,
  "NOTES",
  rule,
  "",
  "@ifc-lite/* (IFC-Lite) is licensed under the Mozilla Public License 2.0. It is used",
  "unmodified. The source of every file in those packages is available from their",
  "repository, https://github.com/LTplus-AG/ifc-lite, and the MPL-2.0 text is reproduced below.",
  "",
  rule,
  "OTHER COMPONENTS (not npm packages)",
  rule,
  "",
  "Geist and Geist Mono (fonts) — Copyright (c) The Geist Project Authors.",
  "  SIL Open Font License 1.1 — https://openfontlicense.org — https://github.com/vercel/geist-font",
  "",
  "EGM96 geoid model — resampled from the National Geospatial-Intelligence Agency's",
  "  WW15MGH.GRD. Public domain (work of the U.S. Government).",
  "",
  "EPSG Geodetic Parameter Dataset — IOGP (International Association of Oil & Gas Producers),",
  "  https://epsg.org, distributed here through the epsg-index package. Used subject to the",
  "  EPSG terms of use; provided without warranty.",
  "",
  "buildingSMART IDS 1.0 and BCF 2.1 / 3.0 XML schemas — buildingSMART International,",
  "  https://www.buildingsmart.org. IFC, BCF, IDS and bSDD are buildingSMART names; this",
  "  application is not endorsed by or affiliated with buildingSMART International.",
  "",
  "libxml2, compiled to WebAssembly (xmllint-wasm) — MIT. Copyright (C) Daniel Veillard et al.",
  "",
  "laz-perf (LAZ decoding) — Apache-2.0, https://github.com/hobuinc/laz-perf",
  "",
];

for (const [, members] of groups) {
  const first = members[0];
  const text = first.notice || `(No licence file is shipped with this package; it declares ${first.license}.)`;
  lines.push(rule);
  for (const member of members) {
    lines.push(`${member.name}@${member.version} — ${member.license}${member.repository ? ` — ${member.repository}` : ""}`);
  }
  lines.push(rule, "", text, "");
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, lines.join("\n"));
console.log(`third-party licences: ${packages.length} packages, ${groups.size} distinct notices → public/third-party-licenses.txt`);

const unknown = packages.filter((found) => found.license === "UNKNOWN");
if (unknown.length > 0) {
  console.warn(`  no licence declared: ${unknown.map((found) => `${found.name}@${found.version}`).join(", ")}`);
}
