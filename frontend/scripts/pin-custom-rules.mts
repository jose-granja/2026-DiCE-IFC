/**
 * Pin our own rules (DiCE-IFC-Rules) to a commit: download it from GitHub, and
 * write the repository, the commit and the tarball's SHA-256 to
 * `validator/manifest.json` (`customRules`). The next `npm run validator:assets`
 * ships exactly that commit; nothing is fetched while the app runs (ADR 018).
 *
 *   npm run validator:pin-rules -- owner/DiCE-IFC-Rules <40-character commit>
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [github, commit] = process.argv.slice(2);
if (!github || !/^[\w.-]+\/[\w.-]+$/.test(github) || !commit || !/^[0-9a-f]{40}$/.test(commit)) {
  console.error("usage: npm run validator:pin-rules -- owner/repo <commit: the full 40-character SHA>");
  process.exit(2);
}

const url = `https://codeload.github.com/${github}/tar.gz/${commit}`;
const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
if (!response.ok) {
  console.error(`${url}: HTTP ${response.status} (is the repository public, and the commit pushed?)`);
  process.exit(1);
}
const sha256 = createHash("sha256").update(new Uint8Array(await response.arrayBuffer())).digest("hex");

const path = join(dirname(fileURLToPath(import.meta.url)), "..", "validator", "manifest.json");
const manifest = JSON.parse(readFileSync(path, "utf8"));
manifest.customRules = { name: manifest.customRules?.name ?? "DiCE-IFC-Rules", github, commit, sha256, license: manifest.customRules?.license ?? "MIT" };
// As the manifest is written: two spaces, non-ASCII escaped.
writeFileSync(path, JSON.stringify(manifest, null, 2).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) + "\n");
console.log(`customRules: ${github} ${commit.slice(0, 7)}, sha256 ${sha256}. Now: npm run validator:assets`);
