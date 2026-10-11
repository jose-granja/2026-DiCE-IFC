/**
 * BCF reader: `.bcf` / `.bcfzip` → the normalised 3.0 model in `types.ts`.
 *
 * Reads **BCF 2.1 and 3.0 and returns 3.0**, so the rest of the app never
 * branches on version. Where 2.1 and 3.0 disagree, the strategy is to detect
 * which shape is present rather than to trust `bcf.version` — files in the
 * wild are routinely mislabelled, and a 3.0 file read as 2.1 loses data
 * silently, which is the worst possible failure for an issue tracker.
 *
 * `DOMParser`, not regex. The elements here nest ambiguously — a comment's
 * text child is *also* called `<Comment>`, and 3.0's viewpoint container is
 * called `<Viewpoints>` just like 2.1's viewpoint *entry* — and disambiguating
 * that needs the tree, not a pattern. (The `@ifc-lite/bcf` reader is
 * regex-based and drops every label from a 3.0 file for exactly this reason:
 * 3.0 wraps them in `<Label>` children and its pattern only matches 2.1's flat
 * form. See docs/adr/005-bcf-implementation.md.)
 *
 * Tolerant on the way in, strict on the way out — same contract as `lib/ids`.
 * Anything changed to make a file representable is reported as a `ParseNote`
 * rather than applied silently.
 */

import { unzipSync } from "fflate";

import type { Vec3 } from "@/lib/ifc/types";
import {
  DEFAULT_EXTENSIONS,
  mergeExtensions,
  newGuid,
  type BcfBimSnippet,
  type BcfBitmap,
  type BcfCamera,
  type BcfClippingPlane,
  type BcfColoring,
  type BcfComment,
  type BcfComponent,
  type BcfComponents,
  type BcfDocument,
  type BcfDocumentReference,
  type BcfExtensions,
  type BcfFile,
  type BcfHeaderFile,
  type BcfLine,
  type BcfProject,
  type BcfTopic,
  type BcfVersion,
  type BcfViewpoint,
  type Guid,
} from "./types";

export class BcfParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BcfParseError";
  }
}

/** Something the file said that had to be changed to be representable. */
export type ParseNote = {
  path: string;
  /** The English sentence, for logs and tests. The page words it from `code`. */
  message: string;
  /** Which situation this is — a key under `viewer.bcfPanel.importNotes`. */
  code?: string;
  params?: Record<string, string>;
};

export type BcfParseResult = {
  file: BcfFile;
  notes: ParseNote[];
};

/**
 * Parse a BCF archive.
 *
 * Synchronous and pure, which is what makes it testable without a browser.
 * BCF archives are small — markup is text and snapshots are a few hundred KB —
 * so unlike IFC this does not need a worker; the whole file is typically under
 * a megabyte. `store.ts` still calls it off the render path.
 */
export function parseBcf(bytes: Uint8Array, name = "issues.bcf"): BcfParseResult {
  const notes: ParseNote[] = [];

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (error) {
    throw new BcfParseError(
      `That file could not be read as a zip archive: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }

  const zip = new Archive(entries);
  const sourceVersion = readVersion(zip, notes);
  const project = readProject(zip);
  const documents = readDocuments(zip);
  const extensions = readExtensions(zip, sourceVersion);

  const topics: BcfTopic[] = [];
  for (const folder of zip.topicFolders()) {
    const topic = readTopic(zip, folder, documents, notes, sourceVersion);
    if (topic) topics.push(topic);
  }

  if (topics.length === 0) {
    notes.push({
      path: name,
      message: "No topics were found in this archive.",
      code: "noTopics",
    });
  }

  // Extensions are advisory, so a file that uses a status it never declared is
  // valid input — but the editor should still offer that status. Folding the
  // observed values in is what makes an imported file editable without every
  // dropdown losing its current value.
  const observed = collectVocabulary(topics);
  return {
    file: {
      sourceVersion,
      name,
      project,
      documents,
      extensions: mergeExtensions(extensions, observed),
      topics,
    },
    notes,
  };
}

// ---------------------------------------------------------------------------
// Archive access
// ---------------------------------------------------------------------------

/**
 * Zip entries, addressed case-insensitively.
 *
 * Authoring tools disagree on the case of `markup.bcf` vs `Markup.bcf` and on
 * whether paths carry a `./` prefix. Neither is worth failing an import over.
 */
class Archive {
  private byLowerPath = new Map<string, Uint8Array>();

  constructor(readonly entries: Record<string, Uint8Array>) {
    for (const [path, data] of Object.entries(entries)) {
      this.byLowerPath.set(normalizePath(path).toLowerCase(), data);
    }
  }

  bytes(path: string): Uint8Array | undefined {
    return this.byLowerPath.get(normalizePath(path).toLowerCase());
  }

  text(path: string): string | undefined {
    const data = this.bytes(path);
    return data ? new TextDecoder().decode(data) : undefined;
  }

  /**
   * Topic folders, in archive order.
   *
   * Found by locating every `markup.bcf` rather than by assuming folder names
   * are GUIDs: some exporters name the folder after the topic title, and the
   * spec only requires that the markup live one level down.
   */
  topicFolders(): string[] {
    const folders: string[] = [];
    for (const path of Object.keys(this.entries)) {
      const normalized = normalizePath(path);
      const lower = normalized.toLowerCase();
      if (!lower.endsWith("/markup.bcf")) continue;
      folders.push(normalized.slice(0, normalized.lastIndexOf("/")));
    }
    return folders;
  }

  /** Entries directly inside a topic folder, by their bare file name. */
  inFolder(folder: string): Array<{ fileName: string; data: Uint8Array }> {
    const prefix = `${folder.toLowerCase()}/`;
    const found: Array<{ fileName: string; data: Uint8Array }> = [];
    for (const [path, data] of Object.entries(this.entries)) {
      const normalized = normalizePath(path);
      const lower = normalized.toLowerCase();
      if (!lower.startsWith(prefix)) continue;
      const rest = normalized.slice(prefix.length);
      if (rest.includes("/") || rest === "") continue;
      found.push({ fileName: rest, data });
    }
    return found;
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

// ---------------------------------------------------------------------------
// Version, project, extensions, documents
// ---------------------------------------------------------------------------

function readVersion(zip: Archive, notes: ParseNote[]): BcfVersion {
  const xml = zip.text("bcf.version");
  if (!xml) {
    // The spec requires it, but plenty of exporters omit it. 3.0 is the better
    // guess for anything written recently, and detection does the real work.
    notes.push({
      path: "bcf.version",
      message: "No version file; the archive was read as BCF 3.0.",
      code: "noVersionFile",
    });
    return "3.0";
  }

  const root = parseXml(xml, "bcf.version").documentElement;
  const id = root.getAttribute("VersionId")?.trim();
  if (id === "2.1") return "2.1";
  if (id === "3.0") return "3.0";

  notes.push({
    path: "bcf.version",
    message: `Unknown BCF version "${id ?? ""}"; the archive was read as BCF 3.0.`,
    code: "unknownVersion",
    params: { version: id ?? "" },
  });
  return "3.0";
}

/** `project.bcfp` — `<ProjectExtension>` in 2.1, `<ProjectInfo>` in 3.0. */
function readProject(zip: Archive): BcfProject {
  const xml = zip.text("project.bcfp");
  if (!xml) return {};

  const element = parseXml(xml, "project.bcfp").querySelector("Project");
  if (!element) return {};

  return {
    projectId: element.getAttribute("ProjectId") ?? undefined,
    name: text(child(element, "Name")),
  };
}

/**
 * The project vocabularies.
 *
 * 3.0 has `extensions.xml`, a plain list. 2.1 had `extensions.xsd` — an actual
 * XML Schema whose enumerations *are* the vocabulary, so reading it means
 * pulling `xs:enumeration` values out of named simple types.
 */
function readExtensions(zip: Archive, version: BcfVersion): BcfExtensions {
  const xml = zip.text("extensions.xml");
  if (xml) return readExtensionsXml(xml);

  const xsd = zip.text("extensions.xsd");
  if (xsd) return readExtensionsXsd(xsd);

  void version;
  return { ...DEFAULT_EXTENSIONS };
}

function readExtensionsXml(xml: string): BcfExtensions {
  const root = parseXml(xml, "extensions.xml").documentElement;
  const list = (container: string, item: string) =>
    Array.from(root.getElementsByTagName(item))
      .filter((node) => node.parentElement?.localName === container)
      .map((node) => node.textContent?.trim() ?? "")
      .filter(Boolean);

  return {
    topicTypes: list("TopicTypes", "TopicType"),
    topicStatuses: list("TopicStatuses", "TopicStatus"),
    priorities: list("Priorities", "Priority"),
    topicLabels: list("TopicLabels", "TopicLabel"),
    users: list("Users", "User"),
    snippetTypes: list("SnippetTypes", "SnippetType"),
    stages: list("Stages", "Stage"),
  };
}

function readExtensionsXsd(xsd: string): BcfExtensions {
  const document_ = parseXml(xsd, "extensions.xsd");

  const enumerationsOf = (typeName: string): string[] => {
    const simpleType = Array.from(
      document_.getElementsByTagName("*"),
    ).find(
      (node) =>
        node.localName === "simpleType" &&
        node.getAttribute("name") === typeName,
    );
    if (!simpleType) return [];

    return Array.from(simpleType.getElementsByTagName("*"))
      .filter((node) => node.localName === "enumeration")
      .map((node) => node.getAttribute("value") ?? "")
      .filter(Boolean);
  };

  return {
    topicTypes: enumerationsOf("TopicType"),
    topicStatuses: enumerationsOf("TopicStatus"),
    priorities: enumerationsOf("Priority"),
    topicLabels: enumerationsOf("TopicLabel"),
    // 2.1 named this `UserIdType`; some writers used `User`.
    users: [...enumerationsOf("UserIdType"), ...enumerationsOf("User")],
    snippetTypes: enumerationsOf("SnippetType"),
    stages: enumerationsOf("Stage"),
  };
}

/** The 3.0 project document library: `documents.xml` plus `Documents/`. */
function readDocuments(zip: Archive): BcfDocument[] {
  const xml = zip.text("documents.xml");
  if (!xml) return [];

  const root = parseXml(xml, "documents.xml").documentElement;
  const documents: BcfDocument[] = [];

  for (const element of Array.from(root.getElementsByTagName("Document"))) {
    const guid = element.getAttribute("Guid");
    if (!guid) continue;

    const filename = text(child(element, "Filename")) ?? guid;
    documents.push({
      guid,
      filename,
      description: text(child(element, "Description")),
      bytes: zip.bytes(`Documents/${guid}`) ?? zip.bytes(`Documents/${filename}`) ?? new Uint8Array(),
    });
  }

  return documents;
}

// ---------------------------------------------------------------------------
// Topic
// ---------------------------------------------------------------------------

function readTopic(
  zip: Archive,
  folder: string,
  documents: BcfDocument[],
  notes: ParseNote[],
  version: BcfVersion,
): BcfTopic | null {
  const markup = zip.text(`${folder}/markup.bcf`);
  if (!markup) return null;

  const path = `${folder}/markup.bcf`;
  const root = parseXml(markup, path).documentElement;
  const topicElement = root.getElementsByTagName("Topic")[0];
  if (!topicElement) {
    notes.push({ path, message: "No <Topic> element; the folder was skipped.", code: "noTopicElement" });
    return null;
  }

  const guid = topicElement.getAttribute("Guid") ?? folder;
  const viewpoints = readViewpoints(zip, folder, root, notes, version);

  const topic: BcfTopic = {
    guid,
    serverAssignedId: topicElement.getAttribute("ServerAssignedId") ?? undefined,
    topicType: topicElement.getAttribute("TopicType") ?? undefined,
    topicStatus: topicElement.getAttribute("TopicStatus") ?? undefined,
    title: text(child(topicElement, "Title")) ?? "(untitled)",
    priority: text(child(topicElement, "Priority")),
    index: number(text(child(topicElement, "Index"))),
    labels: readLabels(topicElement),
    // The schema requires both, but files missing them are common enough that
    // rejecting the topic would lose real data. Empty is honest; a fabricated
    // date would not be.
    creationDate: text(child(topicElement, "CreationDate")) ?? "",
    creationAuthor: text(child(topicElement, "CreationAuthor")) ?? "",
    modifiedDate: text(child(topicElement, "ModifiedDate")),
    modifiedAuthor: text(child(topicElement, "ModifiedAuthor")),
    dueDate: text(child(topicElement, "DueDate")),
    assignedTo: text(child(topicElement, "AssignedTo")),
    stage: text(child(topicElement, "Stage")),
    description: text(child(topicElement, "Description")),
    referenceLinks: Array.from(topicElement.getElementsByTagName("ReferenceLink"))
      .map((node) => node.textContent?.trim() ?? "")
      .filter(Boolean),
    bimSnippet: readBimSnippet(topicElement),
    documentReferences: readDocumentReferences(zip, topicElement, documents, notes, path),
    relatedTopics: Array.from(topicElement.getElementsByTagName("RelatedTopic"))
      .map((node) => node.getAttribute("Guid") ?? "")
      .filter(Boolean),
    comments: readComments(root, notes, path),
    viewpoints,
    headerFiles: readHeaderFiles(root),
  };

  if (!topicElement.getAttribute("Guid")) {
    notes.push({
      path,
      message: `Topic had no GUID; the folder name "${folder}" was used instead.`,
      code: "topicNoGuid",
      params: { folder },
    });
  }

  return topic;
}

/**
 * 2.1 repeats `<Labels>text</Labels>`; 3.0 wraps `<Label>` children in a single
 * `<Labels>`. Detected by looking for the children, so a file that mislabels
 * its own version still reads correctly.
 */
function readLabels(topic: Element): string[] {
  const labels: string[] = [];

  for (const container of Array.from(topic.getElementsByTagName("Labels"))) {
    const wrapped = Array.from(container.getElementsByTagName("Label"));
    if (wrapped.length > 0) {
      for (const node of wrapped) {
        const value = node.textContent?.trim();
        if (value) labels.push(value);
      }
    } else {
      const value = container.textContent?.trim();
      if (value) labels.push(value);
    }
  }

  return labels;
}

function readBimSnippet(topic: Element): BcfBimSnippet | undefined {
  const element = child(topic, "BimSnippet");
  if (!element) return undefined;

  return {
    snippetType: element.getAttribute("SnippetType") ?? "",
    // 2.1 spells this `isExternal`, 3.0 `IsExternal`.
    isExternal: boolean_(
      element.getAttribute("isExternal") ?? element.getAttribute("IsExternal"),
      true,
    ),
    reference: text(child(element, "Reference")) ?? "",
    referenceSchema: text(child(element, "ReferenceSchema")) ?? "",
  };
}

/**
 * 2.1's `<ReferencedDocument>` is either a URL or a path inside the archive;
 * 3.0 split those into `<Url>` and a `<DocumentGuid>` into the project library.
 *
 * An internal 2.1 reference is therefore *promoted into the library* on
 * upgrade, since there is no other way to express it in 3.0. That mutates
 * `documents`, which is why it is threaded through rather than returned.
 */
function readDocumentReferences(
  zip: Archive,
  topic: Element,
  documents: BcfDocument[],
  notes: ParseNote[],
  path: string,
): BcfDocumentReference[] {
  const references: BcfDocumentReference[] = [];

  for (const element of Array.from(topic.getElementsByTagName("DocumentReference"))) {
    const guid = element.getAttribute("Guid") ?? newGuid();
    const description = text(child(element, "Description"));

    const documentGuid = text(child(element, "DocumentGuid"));
    const url = text(child(element, "Url"));
    if (documentGuid || url) {
      references.push({ guid, documentGuid, url, description });
      continue;
    }

    const referenced = text(child(element, "ReferencedDocument"));
    if (!referenced) continue;

    const isExternal = boolean_(
      element.getAttribute("isExternal") ?? element.getAttribute("IsExternal"),
      // No flag and it looks like a URL: treat it as one. Guessing "internal"
      // for `https://…` would produce a library entry with no bytes.
      /^[a-z][a-z0-9+.-]*:\/\//i.test(referenced),
    );

    if (isExternal) {
      references.push({ guid, url: referenced, description });
      continue;
    }

    const bytes = zip.bytes(referenced);
    if (!bytes) {
      notes.push({
        path,
        message: `Document "${referenced}" is referenced but not present in the archive; kept as a link.`,
        code: "documentMissing",
        params: { document: referenced },
      });
      references.push({ guid, url: referenced, description });
      continue;
    }

    const promoted: BcfDocument = {
      guid: newGuid(),
      filename: referenced.split("/").pop() ?? referenced,
      description,
      bytes,
    };
    documents.push(promoted);
    references.push({ guid, documentGuid: promoted.guid, description });
    notes.push({
      path,
      message: `Document "${promoted.filename}" was moved into the BCF 3.0 document library.`,
      code: "documentPromoted",
      params: { document: promoted.filename },
    });
  }

  return references;
}

/**
 * Comments.
 *
 * The disambiguation that regex cannot do: a comment's *text* child is also
 * called `<Comment>`. Real comment elements are the ones whose parent is
 * `<Comments>` (3.0) or `<Markup>` (2.1), so the parent is what selects them.
 */
function readComments(root: Element, notes: ParseNote[], path: string): BcfComment[] {
  const comments: BcfComment[] = [];

  for (const element of Array.from(root.getElementsByTagName("Comment"))) {
    const parent = element.parentElement?.localName;
    if (parent !== "Comments" && parent !== "Markup") continue;

    const guid = element.getAttribute("Guid");
    if (!guid) {
      notes.push({ path, message: "A comment had no GUID; one was generated.", code: "commentNoGuid" });
    }

    comments.push({
      guid: guid ?? newGuid(),
      date: text(child(element, "Date")) ?? "",
      author: text(child(element, "Author")) ?? "",
      comment: text(child(element, "Comment")) ?? "",
      // `<Viewpoint Guid="…"/>` in both versions. Some writers emit a
      // `<ViewpointGuid>` element instead, which is not in either schema but
      // costs one line to accept.
      viewpointGuid:
        child(element, "Viewpoint")?.getAttribute("Guid") ??
        text(child(element, "ViewpointGuid")) ??
        undefined,
      modifiedDate: text(child(element, "ModifiedDate")),
      modifiedAuthor: text(child(element, "ModifiedAuthor")),
    });
  }

  return comments;
}

function readHeaderFiles(root: Element): BcfHeaderFile[] {
  const header = root.getElementsByTagName("Header")[0];
  if (!header) return [];

  return Array.from(header.getElementsByTagName("File")).map((element) => ({
    ifcProject: element.getAttribute("IfcProject") ?? undefined,
    ifcSpatialStructureElement:
      element.getAttribute("IfcSpatialStructureElement") ?? undefined,
    isExternal: boolean_(
      element.getAttribute("isExternal") ?? element.getAttribute("IsExternal"),
      true,
    ),
    filename: text(child(element, "Filename")),
    date: text(child(element, "Date")),
    reference: text(child(element, "Reference")),
  }));
}

// ---------------------------------------------------------------------------
// Viewpoints
// ---------------------------------------------------------------------------

/**
 * Viewpoint entries in the markup, then the `.bcfv` each one points at.
 *
 * The element naming is the trap. 2.1 repeats `<Viewpoints Guid="…">` as the
 * *entry*; 3.0 uses `<Viewpoints>` as a plain container holding `<ViewPoint
 * Guid="…">` entries — same word, different role, differing only by a capital
 * P. The `Guid` attribute is what actually distinguishes an entry from a
 * container, so that is the test rather than the tag name.
 */
function readViewpoints(
  zip: Archive,
  folder: string,
  root: Element,
  notes: ParseNote[],
  version: BcfVersion,
): BcfViewpoint[] {
  const entries = [
    ...Array.from(root.getElementsByTagName("ViewPoint")),
    ...Array.from(root.getElementsByTagName("Viewpoints")),
  ].filter((element) => element.hasAttribute("Guid"));

  const viewpoints: BcfViewpoint[] = [];
  const files = zip.inFolder(folder);

  for (const entry of entries) {
    const guid = entry.getAttribute("Guid")!;
    const fileName = text(child(entry, "Viewpoint")) ?? `${guid}.bcfv`;
    const snapshotName = text(child(entry, "Snapshot"));

    const bcfv = zip.text(`${folder}/${fileName}`);
    if (!bcfv) {
      notes.push({
        path: `${folder}/${fileName}`,
        message: "A viewpoint file is missing from the archive; its camera was lost.",
        code: "viewpointMissing",
      });
    }

    const parsed = bcfv
      ? readVisualizationInfo(bcfv, `${folder}/${fileName}`, version)
      : null;
    const snapshotBytes = snapshotName
      ? zip.bytes(`${folder}/${snapshotName}`)
      : undefined;

    viewpoints.push({
      guid,
      fileName,
      index: number(text(child(entry, "Index"))),
      camera: parsed?.camera ?? null,
      components: parsed?.components ?? null,
      clippingPlanes: parsed?.clippingPlanes ?? [],
      lines: parsed?.lines ?? [],
      bitmaps: attachBitmapBytes(parsed?.bitmaps ?? [], zip, folder),
      snapshot:
        snapshotName && snapshotBytes
          ? { fileName: snapshotName, bytes: snapshotBytes }
          : undefined,
    });
  }

  // Some exporters ship a `.bcfv` that no markup entry references. Dropping it
  // would lose the only record of a view, so it is recovered under its own
  // file name.
  const referenced = new Set(viewpoints.map((v) => v.fileName.toLowerCase()));
  for (const { fileName, data } of files) {
    if (!fileName.toLowerCase().endsWith(".bcfv")) continue;
    if (referenced.has(fileName.toLowerCase())) continue;

    const parsed = readVisualizationInfo(
      new TextDecoder().decode(data),
      `${folder}/${fileName}`,
      version,
    );
    viewpoints.push({
      guid: parsed.guid ?? newGuid(),
      fileName,
      camera: parsed.camera,
      components: parsed.components,
      clippingPlanes: parsed.clippingPlanes,
      lines: parsed.lines,
      bitmaps: attachBitmapBytes(parsed.bitmaps, zip, folder),
    });
    notes.push({
      path: `${folder}/${fileName}`,
      message: "A viewpoint file was not listed in the markup; it was recovered.",
      code: "viewpointRecovered",
    });
  }

  return viewpoints.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

type VisualizationInfo = {
  guid?: Guid;
  camera: BcfCamera | null;
  components: BcfComponents | null;
  clippingPlanes: BcfClippingPlane[];
  lines: BcfLine[];
  bitmaps: BcfBitmap[];
};

function readVisualizationInfo(
  xml: string,
  path: string,
  version: BcfVersion,
): VisualizationInfo {
  const root = parseXml(xml, path).documentElement;

  return {
    guid: root.getAttribute("Guid") ?? undefined,
    camera: readCamera(root),
    components: readComponents(root, version),
    clippingPlanes: Array.from(root.getElementsByTagName("ClippingPlane")).map(
      (element) => ({
        location: vector(child(element, "Location")) ?? [0, 0, 0],
        direction: vector(child(element, "Direction")) ?? [0, 0, 1],
      }),
    ),
    lines: Array.from(root.getElementsByTagName("Line")).map((element) => ({
      start: vector(child(element, "StartPoint")) ?? [0, 0, 0],
      end: vector(child(element, "EndPoint")) ?? [0, 0, 0],
    })),
    bitmaps: Array.from(root.getElementsByTagName("Bitmap"))
      // 2.1 names the format element `<Bitmap>` *inside* `<Bitmap>`, so the
      // inner one would otherwise be read as a bitmap of its own.
      .filter((element) => element.parentElement?.localName !== "Bitmap")
      .map((element) => ({
        guid: element.getAttribute("Guid") ?? undefined,
        format:
          text(child(element, "Format")) ?? text(child(element, "Bitmap")) ?? "png",
        reference: text(child(element, "Reference")) ?? "",
        location: vector(child(element, "Location")) ?? [0, 0, 0],
        normal: vector(child(element, "Normal")) ?? [0, 0, 1],
        up: vector(child(element, "Up")) ?? [0, 0, 1],
        height: number(text(child(element, "Height"))) ?? 1,
      })),
  };
}

function readCamera(root: Element): BcfCamera | null {
  const perspective = root.getElementsByTagName("PerspectiveCamera")[0];
  if (perspective) {
    return {
      kind: "perspective",
      viewPoint: vector(child(perspective, "CameraViewPoint")) ?? [0, 0, 0],
      direction: vector(child(perspective, "CameraDirection")) ?? [0, 1, 0],
      upVector: vector(child(perspective, "CameraUpVector")) ?? [0, 0, 1],
      fieldOfView: number(text(child(perspective, "FieldOfView"))) ?? 60,
      aspectRatio: number(text(child(perspective, "AspectRatio"))),
    };
  }

  const orthogonal = root.getElementsByTagName("OrthogonalCamera")[0];
  if (orthogonal) {
    return {
      kind: "orthogonal",
      viewPoint: vector(child(orthogonal, "CameraViewPoint")) ?? [0, 0, 0],
      direction: vector(child(orthogonal, "CameraDirection")) ?? [0, 1, 0],
      upVector: vector(child(orthogonal, "CameraUpVector")) ?? [0, 0, 1],
      viewToWorldScale: number(text(child(orthogonal, "ViewToWorldScale"))) ?? 1,
      aspectRatio: number(text(child(orthogonal, "AspectRatio"))),
    };
  }

  return null;
}

function readComponents(root: Element, version: BcfVersion): BcfComponents | null {
  const element = root.getElementsByTagName("Components")[0];
  if (!element) return null;

  const hints = element.getElementsByTagName("ViewSetupHints")[0];
  const visibility = element.getElementsByTagName("Visibility")[0];

  const coloring: BcfColoring[] = Array.from(
    element.getElementsByTagName("Color"),
  ).map((node) => ({
    colour: normalizeColour(node.getAttribute("Color") ?? "", version),
    components: componentsIn(node),
  }));

  return {
    viewSetupHints: hints
      ? {
          spacesVisible: boolean_(hints.getAttribute("SpacesVisible"), false),
          spaceBoundariesVisible: boolean_(
            hints.getAttribute("SpaceBoundariesVisible"),
            false,
          ),
          openingsVisible: boolean_(hints.getAttribute("OpeningsVisible"), false),
        }
      : undefined,
    selection: componentsIn(element.getElementsByTagName("Selection")[0]),
    defaultVisibility: boolean_(
      visibility?.getAttribute("DefaultVisibility") ?? null,
      true,
    ),
    exceptions: componentsIn(
      visibility?.getElementsByTagName("Exceptions")[0] ?? undefined,
    ),
    coloring,
  };
}

function componentsIn(container: Element | undefined): BcfComponent[] {
  if (!container) return [];

  return Array.from(container.getElementsByTagName("Component")).map((element) => ({
    // 2.1 carried the id as an `IfcGuid` attribute; both versions agree here,
    // but some writers emit it as a child element instead.
    ifcGuid:
      element.getAttribute("IfcGuid") ??
      text(child(element, "IfcGuid")) ??
      undefined,
    originatingSystem:
      element.getAttribute("OriginatingSystem") ??
      text(child(element, "OriginatingSystem")),
    authoringToolId:
      element.getAttribute("AuthoringToolId") ??
      text(child(element, "AuthoringToolId")),
  }));
}

/**
 * Put a colour into BCF 3.0's RGB/RGBA byte order.
 *
 * 2.1 documented eight hex digits as **ARGB**; 3.0's schema annotates the same
 * attribute with `FF00FF99`, i.e. **RGBA**. Both are just "8 hex digits" to a
 * validator, so nothing catches the difference — an upgraded 2.1 file would
 * simply come out the wrong colour. Six-digit values mean the same thing in
 * both versions and pass through untouched.
 */
function normalizeColour(raw: string, version: BcfVersion): string {
  const hex = raw.trim().replace(/^#/, "");
  if (version !== "2.1" || hex.length !== 8) return hex;

  return `${hex.slice(2)}${hex.slice(0, 2)}`;
}

function attachBitmapBytes(
  bitmaps: BcfBitmap[],
  zip: Archive,
  folder: string,
): BcfBitmap[] {
  return bitmaps.map((bitmap) => ({
    ...bitmap,
    bytes: bitmap.reference ? zip.bytes(`${folder}/${bitmap.reference}`) : undefined,
  }));
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Values the topics actually use, whether or not the extensions declared them. */
function collectVocabulary(topics: BcfTopic[]): BcfExtensions {
  const types = new Set<string>();
  const statuses = new Set<string>();
  const priorities = new Set<string>();
  const labels = new Set<string>();
  const users = new Set<string>();
  const snippetTypes = new Set<string>();
  const stages = new Set<string>();

  for (const topic of topics) {
    if (topic.topicType) types.add(topic.topicType);
    if (topic.topicStatus) statuses.add(topic.topicStatus);
    if (topic.priority) priorities.add(topic.priority);
    if (topic.stage) stages.add(topic.stage);
    if (topic.assignedTo) users.add(topic.assignedTo);
    if (topic.bimSnippet?.snippetType) snippetTypes.add(topic.bimSnippet.snippetType);
    if (topic.creationAuthor) users.add(topic.creationAuthor);
    for (const label of topic.labels) labels.add(label);
    for (const comment of topic.comments) {
      if (comment.author) users.add(comment.author);
    }
  }

  return {
    topicTypes: [...types],
    topicStatuses: [...statuses],
    priorities: [...priorities],
    topicLabels: [...labels],
    users: [...users],
    snippetTypes: [...snippetTypes],
    stages: [...stages],
  };
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function parseXml(xml: string, path: string): Document {
  const document_ = new DOMParser().parseFromString(xml, "application/xml");

  // DOMParser reports failure as a <parsererror> element rather than throwing.
  const failure = document_.querySelector("parsererror");
  if (failure) {
    throw new BcfParseError(
      `${path} is not well-formed XML: ${failure.textContent?.trim().split("\n")[0] ?? "unknown error"}`,
    );
  }
  return document_;
}

/** The first *direct* child with this name. */
function child(parent: Element | undefined, name: string): Element | undefined {
  if (!parent) return undefined;
  for (const node of Array.from(parent.children)) {
    if (node.localName === name) return node;
  }
  return undefined;
}

function text(element: Element | undefined): string | undefined {
  const value = element?.textContent?.trim();
  return value ? value : undefined;
}

function number(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boolean_(value: string | null | undefined, fallback: boolean): boolean {
  if (value === null || value === undefined || value === "") return fallback;
  return value.trim().toLowerCase() === "true" || value.trim() === "1";
}

function vector(element: Element | undefined): Vec3 | undefined {
  if (!element) return undefined;

  const axis = (name: string) => number(text(child(element, name))) ?? 0;
  return [axis("X"), axis("Y"), axis("Z")];
}
