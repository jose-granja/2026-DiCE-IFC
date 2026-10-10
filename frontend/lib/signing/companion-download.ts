"use client";

/**
 * Where to get the signing companion, for the machine asking.
 *
 * The setup page offers one button rather than a table of platforms: someone
 * whose signing just failed should not have to work out which build is theirs.
 *
 * ## Why the location is configurable
 *
 * The installers are built by `.github/workflows/companion.yml` and attached to
 * a GitHub release, but *which* release is a deployment decision — a firm
 * running this internally may host approved builds on their own server, and
 * pointing at a public download would be the wrong default there.
 *
 * `NEXT_PUBLIC_COMPANION_DOWNLOAD_BASE` names the directory holding the files.
 * With it unset the app serves them itself from `/companion/` (`npm run
 * copy:companion` puts the compiled ones there). Which files exist is not
 * checked here: when `public/companion/` is empty the page reports the link is
 * not available rather than offering one that 404s, see `isDownloadAvailable`.
 */

export type CompanionPlatform = "macos-arm64" | "macos-x64" | "windows" | "unknown";

export type CompanionDownload = {
  platform: CompanionPlatform;
  label: string;
  filename: string;
  href: string;
  /** Shown next to the button. Both installers are unsigned; say so. */
  warning: string;
};

/** Kept in step with `companion/pyproject.toml`. */
export const COMPANION_VERSION = "0.1.1";

const CONFIGURED_BASE = (process.env.NEXT_PUBLIC_COMPANION_DOWNLOAD_BASE ?? "").replace(
  /\/+$/,
  "",
);

/** Served by this app itself unless a deployment points elsewhere. */
const SELF_HOSTED = CONFIGURED_BASE === "";
const BASE = SELF_HOSTED ? "/companion" : CONFIGURED_BASE;

/**
 * Which build this machine needs.
 *
 * `navigator.userAgentData` is the only honest source for Apple Silicon vs
 * Intel — the user-agent string reports "Intel Mac OS X" on both, because
 * Safari and Chrome freeze it there for fingerprinting reasons. When the
 * high-entropy hint is unavailable the arm64 build is offered, since every Mac
 * sold since 2020 is one; the page lists the other build alongside.
 */
export function detectPlatform(architecture?: string): CompanionPlatform {
  if (typeof navigator === "undefined") return "unknown";

  const agent = navigator.userAgent;
  if (/Windows/i.test(agent)) return "windows";

  if (/Mac OS X|Macintosh/i.test(agent)) {
    if (architecture === "x86") return "macos-x64";
    return "macos-arm64";
  }

  // Linux has no installer: there is no packaged Autenticação.gov middleware to
  // build one against for every distribution, so `pip install` is the route.
  return "unknown";
}

/** Ask the browser for the CPU architecture, when it will say. */
export async function detectArchitecture(): Promise<string | undefined> {
  type WithData = Navigator & {
    userAgentData?: {
      getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>;
    };
  };

  const data = (navigator as WithData).userAgentData;
  if (!data?.getHighEntropyValues) return undefined;

  try {
    const values = await data.getHighEntropyValues(["architecture"]);
    return values.architecture;
  } catch {
    return undefined;
  }
}

const FILES: Record<Exclude<CompanionPlatform, "unknown">, string> = {
  "macos-arm64": `DiCE-IFC-Companion-${COMPANION_VERSION}-macos-arm64.pkg`,
  "macos-x64": `DiCE-IFC-Companion-${COMPANION_VERSION}-macos-x86_64.pkg`,
  // Released builds are the Inno Setup installer. What this app serves itself
  // is whatever `build_windows.ps1` left in `dist_win`, which on a machine
  // without Inno Setup is the bare program.
  windows: SELF_HOSTED
    ? "dice-companion.exe"
    : `DiCE-IFC-Companion-${COMPANION_VERSION}-windows-setup.exe`,
};

const LABELS: Record<Exclude<CompanionPlatform, "unknown">, string> = {
  "macos-arm64": "Download for macOS (Apple Silicon)",
  "macos-x64": "Download for macOS (Intel)",
  windows: "Download for Windows",
};

const WARNINGS: Record<Exclude<CompanionPlatform, "unknown">, string> = {
  "macos-arm64":
    "Not signed by Apple yet, so macOS will say “unidentified developer”. Right-click the downloaded file and choose Open.",
  "macos-x64":
    "Not signed by Apple yet, so macOS will say “unidentified developer”. Right-click the downloaded file and choose Open.",
  windows: SELF_HOSTED
    ? "The program itself, not an installer: run it and keep it running (it does not start with Windows yet). Not code-signed, so SmartScreen will warn on first run — choose “More info”, then “Run anyway”."
    : "Not code-signed yet, so SmartScreen will warn on first run. Choose “More info”, then “Run anyway”.",
};

/** The download for a platform, or `null` when none is configured. */
export function companionDownload(
  platform: CompanionPlatform,
): CompanionDownload | null {
  if (platform === "unknown") return null;

  return {
    platform,
    label: LABELS[platform],
    filename: FILES[platform],
    href: `${BASE}/${FILES[platform]}`,
    warning: WARNINGS[platform],
  };
}

/**
 * Is the file actually there? Only asked of downloads this app serves itself:
 * `public/companion/` is filled by `npm run copy:companion` and is empty on a
 * checkout that never built the companion, where the button would 404. A
 * deployment that names its own host is trusted, and not probed.
 */
export async function isDownloadAvailable(download: CompanionDownload): Promise<boolean> {
  if (!SELF_HOSTED) return true;
  try {
    const response = await fetch(download.href, { method: "HEAD" });
    // Next answers an unknown path with its HTML 404 page; a file is not HTML.
    return response.ok && !(response.headers.get("content-type") ?? "").includes("text/html");
  } catch {
    return false;
  }
}

/** The download for this machine and the builds for others, keeping only those that exist. */
export async function availableDownloads(
  platform: CompanionPlatform,
): Promise<{ download: CompanionDownload | null; others: CompanionDownload[] }> {
  const keep = async (entry: CompanionDownload | null) =>
    entry && (await isDownloadAvailable(entry)) ? entry : null;
  const [download, ...others] = await Promise.all([
    keep(companionDownload(platform)),
    ...otherDownloads(platform).map((entry) => keep(entry)),
  ]);
  return { download, others: others.filter((entry): entry is CompanionDownload => entry !== null) };
}

/** The other builds, for someone whose machine was guessed wrong. */
export function otherDownloads(platform: CompanionPlatform): CompanionDownload[] {
  const all: Exclude<CompanionPlatform, "unknown">[] = [
    "macos-arm64",
    "macos-x64",
    "windows",
  ];
  return all
    .filter((entry) => entry !== platform)
    .map((entry) => companionDownload(entry))
    .filter((entry): entry is CompanionDownload => entry !== null);
}
