/**
 * A project as a folder on disk.
 *
 * Writing a folder needs the File System Access API (`showDirectoryPicker`),
 * which Chromium has and Firefox and Safari do not. There the same folder goes
 * into a `.zip` instead — one download, the same layout inside — and loading
 * accepts either. Reading a folder needs nothing special: `<input
 * webkitdirectory>` works in every current browser.
 *
 * Everything here stays on the machine. Files are written to and read from the
 * folder the user picked; nothing is uploaded (AGENTS.md §1).
 */

import { PROJECT_FILE } from "./manifest";
import { readZip, writeZip, ZipFormatError } from "./zip";

export type ProjectFile = {
  /** Relative to the project folder, `/`-separated. */
  path: string;
  data: Blob;
};

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * A file or folder name that every desktop file system accepts: no path
 * separators, none of Windows' reserved characters, no control characters, no
 * trailing dot or space. A name is the user's own (a model called
 * "Bloco A: estrutura.ifc"), so it is cleaned, not refused.
 */
export function safeFileName(name: string, fallback = "file"): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[. ]+$/, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned.slice(0, 200);
}

/**
 * Hands out unique paths inside one folder. Case-insensitive, because macOS
 * and Windows are: `Wall.ifc` and `wall.ifc` would be one file there, and the
 * second write would silently replace the first model.
 */
export function uniquePaths() {
  const taken = new Set<string>();
  return (folder: string, name: string): string => {
    const clean = safeFileName(name);
    const dot = clean.lastIndexOf(".");
    // `.city.json` keeps both parts as its extension; anything else splits at
    // the last dot. A leading dot is a name, not an extension.
    const double = /\.(city\.json)$/i.exec(clean);
    const stem = double ? clean.slice(0, double.index) : dot > 0 ? clean.slice(0, dot) : clean;
    const extension = double ? clean.slice(double.index) : dot > 0 ? clean.slice(dot) : "";
    for (let attempt = 1; ; attempt += 1) {
      const candidate = `${folder}/${attempt === 1 ? stem : `${stem} (${attempt})`}${extension}`;
      const key = candidate.toLocaleLowerCase();
      if (!taken.has(key)) {
        taken.add(key);
        return candidate;
      }
    }
  };
}

/** `DiCE-IFC project 2026-10-13 1405`, from the local clock. */
export function projectFolderName(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `DiCE-IFC project ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

type DirectoryPicker = (options?: {
  id?: string;
  mode?: "read" | "readwrite";
  startIn?: string;
}) => Promise<FileSystemDirectoryHandle>;

function directoryPicker(): DirectoryPicker | null {
  if (typeof window === "undefined") return null;
  const picker = (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  return typeof picker === "function" ? picker.bind(window) : null;
}

/** Whether this browser can write a real folder, rather than a `.zip` of one. */
export function canWriteFolders(): boolean {
  return directoryPicker() !== null;
}

/**
 * Ask where to put the project. Resolves to null when the user cancels the
 * picker — that is a choice, not an error.
 */
export async function pickParentDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const picker = directoryPicker();
  if (!picker) return null;
  try {
    return await picker({ id: "dice-ifc-project", mode: "readwrite" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  }
}

async function exists(parent: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await parent.getDirectoryHandle(name);
    return true;
  } catch {
    try {
      await parent.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Write the project into a new folder inside `parent`, and return its name.
 *
 * Always a new folder — `name (2)` when `name` is taken — never into an
 * existing one: overwriting a project the user saved earlier, or files that
 * merely share a name with ours, would lose work without asking.
 */
export async function writeProjectFolder(
  parent: FileSystemDirectoryHandle,
  name: string,
  files: ProjectFile[],
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const base = safeFileName(name, "DiCE-IFC project");
  let folderName = base;
  for (let attempt = 2; await exists(parent, folderName); attempt += 1) {
    folderName = `${base} (${attempt})`;
  }
  const root = await parent.getDirectoryHandle(folderName, { create: true });

  const total = files.reduce((sum, file) => sum + file.data.size, 0);
  let done = 0;
  for (const file of files) {
    const parts = file.path.split("/");
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      directory = await directory.getDirectoryHandle(part, { create: true });
    }
    const handle = await directory.getFileHandle(parts[parts.length - 1], { create: true });
    const writable = await handle.createWritable();
    try {
      // A Blob is streamed to disk, not read into memory first, which is what
      // lets a project with a gigabyte of models save at all.
      await writable.write(file.data);
    } finally {
      await writable.close();
    }
    done += file.data.size;
    onProgress?.(done, total);
  }
  return folderName;
}

/**
 * The same folder as a `.zip`, for a browser that cannot write folders.
 *
 * Stored, not compressed: IFC compresses well, but deflating a large federation
 * on the main thread would freeze the tab for longer than the download takes,
 * and the point is a folder the user can unpack, not a smaller file. See
 * `zip.ts` for why this is not fflate's streaming writer.
 */
export async function projectZip(folderName: string, files: ProjectFile[]): Promise<Blob> {
  const root = safeFileName(folderName, "DiCE-IFC project");
  return writeZip(files.map((file) => ({ path: `${root}/${file.path}`, data: file.data })));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type ProjectSource = {
  /** The folder's own name, for messages. */
  name: string;
  manifestText: string;
  /** Look a manifest path up among the folder's files. */
  file: (path: string) => File | undefined;
};

export type ProjectFolderErrorCode = "noManifest" | "notZip";

/** Why a folder or archive was refused; `code` is for the UI to translate. */
export class ProjectFolderError extends Error {
  constructor(
    readonly code: ProjectFolderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectFolderError";
  }
}

function normalise(path: string): string {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
}

/**
 * Index files by their path inside the folder that holds `project.json`.
 *
 * The shallowest `project.json` wins, so a project folder that happens to
 * contain an older project folder (a backup copied inside) opens as itself.
 */
function indexFiles(entries: Array<{ path: string; file: File }>, fallbackName: string) {
  const manifests = entries
    .map((entry) => ({ ...entry, path: normalise(entry.path) }))
    .filter((entry) => entry.path === PROJECT_FILE || entry.path.endsWith(`/${PROJECT_FILE}`))
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  const manifest = manifests[0];
  if (!manifest) {
    throw new ProjectFolderError(
      "noManifest",
      `There is no ${PROJECT_FILE} in that folder. Choose the folder that “Save project” created.`,
    );
  }

  const root = manifest.path.slice(0, manifest.path.length - PROJECT_FILE.length);
  const byPath = new Map<string, File>();
  for (const entry of entries) {
    const relative = normalise(entry.path);
    if (!relative.startsWith(root)) continue;
    byPath.set(relative.slice(root.length).toLocaleLowerCase(), entry.file);
  }
  const name = root.replace(/\/$/, "").split("/").pop() || fallbackName;
  return { manifest: manifest.file, byPath, name };
}

/** From `<input webkitdirectory>`: every file carries its path in `webkitRelativePath`. */
export async function readProjectFromFileList(files: Iterable<File>): Promise<ProjectSource> {
  return readProjectFromEntries(
    [...files].map((file) => ({ path: file.webkitRelativePath || file.name, file })),
    "project",
  );
}

/**
 * From files already gathered with their paths — a folder in the browser's own
 * storage, say (`lib/viewer/workspace.ts`). `name` is used when the files sit
 * at the root, with no folder of their own to be named after.
 */
export async function readProjectFromEntries(
  entries: Array<{ path: string; file: File }>,
  name: string,
): Promise<ProjectSource> {
  const indexed = indexFiles(entries, name);
  return {
    name: indexed.name,
    manifestText: await indexed.manifest.text(),
    file: (path) => indexed.byPath.get(normalise(path).toLocaleLowerCase()),
  };
}

/** From a `.zip` that `projectZip` — or the user, zipping the folder — made. */
export async function readProjectFromZip(archive: File): Promise<ProjectSource> {
  let entries: Array<{ path: string; file: File }>;
  try {
    entries = await readZip(archive);
  } catch (error) {
    // "Not a zip" and "damaged" are the same thing to someone who picked the
    // wrong file; the ZIP64 and encryption messages name something they can do.
    if (error instanceof ZipFormatError && /ZIP64|encrypted/.test(error.message)) throw error;
    throw new ProjectFolderError("notZip", `${archive.name} is not a zip archive.`);
  }
  if (entries.length === 0) {
    throw new ProjectFolderError("notZip", `${archive.name} is not a zip archive.`);
  }
  const { manifest, byPath, name } = indexFiles(entries, archive.name.replace(/\.zip$/i, ""));
  return {
    name,
    manifestText: await manifest.text(),
    file: (path) => byPath.get(normalise(path).toLocaleLowerCase()),
  };
}
