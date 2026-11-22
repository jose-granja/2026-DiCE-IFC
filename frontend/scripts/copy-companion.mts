/**
 * Put the compiled signing companion where the setup page can offer it.
 *
 *   npm run copy:companion
 *
 * The companion is built on its own machine type (`companion/packaging/
 * build_macos.sh`, `build_windows.ps1`) into `companion/dist_mac` and
 * `companion/dist_win`. This copies what is there into `public/companion/`, so
 * the app serves it from its own origin at `/companion/<file>` — the default
 * download location (see `lib/signing/companion-download.ts`), no third party
 * involved.
 *
 * Copied rather than committed: these are build products, and `public/
 * companion/` is gitignored. Nothing to copy is not an error — a checkout that
 * never built the companion, or a Docker build whose context is only
 * `frontend/`, simply serves no download and the page says how to build one.
 * To ship them in an image, run this on the host before building it.
 */

import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const companion = resolve(here, "../../companion");
const target = resolve(here, "../public/companion");

type Source = { directory: string; pattern: RegExp };

const SOURCES: Source[] = [
  // macOS installers, one per architecture built.
  { directory: join(companion, "dist_mac"), pattern: /^DiCE-IFC-Companion-.+-macos-.+\.pkg$/ },
  // Windows: the Inno Setup installer when there is one, and the program,
  // which `build_windows.ps1` names `DiCE-IFC-Companion-<v>-win.exe`.
  { directory: join(companion, "dist_win"), pattern: /^DiCE-IFC-Companion-.+-(windows-setup|win)\.exe$/ },
];

/** `companion/pyproject.toml`'s version, which names the builds. */
async function companionVersion(): Promise<string | undefined> {
  try {
    return /^version\s*=\s*"([^"]+)"/m.exec(await readFile(join(companion, "pyproject.toml"), "utf8"))?.[1];
  } catch {
    return undefined;
  }
}

/** `file` in `directory`, served as `name`. */
const found: Array<{ directory: string; file: string; name: string }> = [];
for (const { directory, pattern } of SOURCES) {
  if (!existsSync(directory)) continue;
  for (const file of await readdir(directory)) {
    if (pattern.test(file)) found.push({ directory, file, name: file });
  }
}

// A Windows build from before the program had a versioned name leaves only
// `dice-companion.exe`. Serve it under the name the setup page links
// (`lib/signing/companion-download.ts`), unless a named one is already there.
const bare = join(companion, "dist_win", "dice-companion.exe");
const version = await companionVersion();
if (existsSync(bare) && version && !found.some(({ name }) => name.endsWith("-win.exe"))) {
  found.push({ directory: join(companion, "dist_win"), file: "dice-companion.exe", name: `DiCE-IFC-Companion-${version}-win.exe` });
}

// Only when there is something fresh to put in its place: a Docker build has
// no `companion/` in its context, and there `public/companion/` is whatever
// `COPY . .` brought in, which must survive this script running.
if (found.length > 0) {
  // Start clean, so a download left over from an older build is not served
  // next to (or instead of) the current one.
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
}

const copied: string[] = [];
for (const { directory, file, name } of found) {
  await cp(join(directory, file), join(target, name));
  copied.push(name);
}

console.log(
  copied.length > 0
    ? `Companion downloads in public/companion: ${copied.join(", ")}`
    : "No compiled companion found in companion/dist_mac or dist_win; the setup page will offer no download.",
);
