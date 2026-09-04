/**
 * BCF domain model, normalised on **BCF 3.0**.
 *
 * A 2.1 file is upgraded on import (see `parse.ts`) so nothing downstream has
 * to branch on version: the list, the editor, the merge and the writer all see
 * one shape. The version a file arrived as is kept on `BcfFile.sourceVersion`
 * for the UI to report, not for logic to switch on.
 *
 * Naming follows the BCF schema closely — `topicStatus`, `viewToWorldScale`,
 * `ifcGuid` — because the reference when something looks wrong is the
 * buildingSMART XSD, and a renamed field makes that lookup harder for no gain.
 * The exception is casing: the schema is PascalCase, this is camelCase.
 *
 * @see https://github.com/buildingSMART/BCF-XML/tree/release_3_0/Documentation
 */

import type { Vec3 } from "@/lib/ifc/types";

export type BcfVersion = "2.1" | "3.0";

/** BCF 2.1 and 3.0 both identify things with UUIDs, not IFC GUIDs. */
export type Guid = string;

// ---------------------------------------------------------------------------
// Project and extensions
// ---------------------------------------------------------------------------

export type BcfProject = {
  projectId?: string;
  name?: string;
};

/**
 * The project's controlled vocabularies (`extensions.xml` in 3.0, an
 * `extensions.xsd` in 2.1).
 *
 * These are per-project, not fixed by the standard — a topic status of
 * "Aguarda Aprovação" is as valid as "Open". The editor offers these as
 * options but never rejects a value outside them, because a file authored
 * elsewhere routinely carries one.
 */
export type BcfExtensions = {
  topicTypes: string[];
  topicStatuses: string[];
  priorities: string[];
  topicLabels: string[];
  users: string[];
  snippetTypes: string[];
  stages: string[];
};

/**
 * What the schema's own documentation uses as examples, applied only when a
 * file carries no extensions at all. Not a validation list.
 */
export const DEFAULT_EXTENSIONS: BcfExtensions = {
  topicTypes: ["Issue", "Clash", "Error", "Warning", "Info", "Request", "Remark"],
  topicStatuses: ["Open", "In Progress", "Resolved", "Closed", "ReOpened"],
  priorities: ["Low", "Normal", "High", "Critical"],
  topicLabels: [],
  users: [],
  snippetTypes: [],
  stages: [],
};

// ---------------------------------------------------------------------------
// Topic
// ---------------------------------------------------------------------------

/** The IFC file a topic was raised against. 2.1 allows one; 3.0 allows many. */
export type BcfHeaderFile = {
  ifcProject?: string;
  ifcSpatialStructureElement?: string;
  isExternal: boolean;
  filename?: string;
  date?: string;
  reference?: string;
};

export type BcfBimSnippet = {
  snippetType: string;
  isExternal: boolean;
  reference: string;
  referenceSchema: string;
};

/**
 * A document attached to a topic.
 *
 * 2.1 pointed at a file or a URL directly. 3.0 added a project-level document
 * library (`documents.xml`) and made this either a `documentGuid` into that
 * library or an external `url` — exactly one of the two.
 */
export type BcfDocumentReference = {
  guid: Guid;
  documentGuid?: Guid;
  url?: string;
  description?: string;
};

/** An entry in the 3.0 project document library. */
export type BcfDocument = {
  guid: Guid;
  filename: string;
  description?: string;
  /** The file itself, as stored in the zip's `Documents/` folder. */
  bytes: Uint8Array;
};

export type BcfComment = {
  guid: Guid;
  date: string;
  author: string;
  comment: string;
  /** A comment may point at one of its topic's viewpoints. */
  viewpointGuid?: Guid;
  modifiedDate?: string;
  modifiedAuthor?: string;
};

// ---------------------------------------------------------------------------
// Viewpoint
// ---------------------------------------------------------------------------

/**
 * A reference to an element, by IFC GlobalId.
 *
 * Not by express id: those are only unique within one file and change whenever
 * the model is re-exported, so a viewpoint keyed by them would break on the
 * next revision. Resolving a GlobalId back to something the viewer can select
 * is `viewpoint.ts`'s job.
 */
export type BcfComponent = {
  ifcGuid?: string;
  originatingSystem?: string;
  authoringToolId?: string;
};

export type BcfViewSetupHints = {
  spacesVisible: boolean;
  spaceBoundariesVisible: boolean;
  openingsVisible: boolean;
};

/**
 * `colour` is hex without a leading `#`, normalised to BCF 3.0's **RGB or
 * RGBA** form on import.
 *
 * The normalisation matters: 2.1 documented this as **ARGB**, and 3.0's schema
 * gives `FF00FF99` as an RGBA example. Reading a 2.1 file's `FFFF0000`
 * (opaque red) as RGBA would yield opaque *white-ish red* — a silent colour
 * shift on every upgraded file. `parse.ts` reorders it against the source
 * version so everything downstream can assume RGBA.
 */
export type BcfColoring = {
  colour: string;
  components: BcfComponent[];
};

export type BcfComponents = {
  viewSetupHints?: BcfViewSetupHints;
  selection: BcfComponent[];
  /**
   * Whether elements are visible unless listed in `exceptions`. Inverted
   * meaning is the usual source of bugs here: `false` means *hide everything
   * except the exceptions*, which is how "isolate these elements" is encoded.
   */
  defaultVisibility: boolean;
  exceptions: BcfComponent[];
  coloring: BcfColoring[];
};

/**
 * Cameras. Coordinates are **IFC world coordinates** — Z-up, in project units,
 * unshifted. Converting to the viewer's Y-up render space is `viewpoint.ts`.
 */
export type BcfOrthogonalCamera = {
  kind: "orthogonal";
  viewPoint: Vec3;
  direction: Vec3;
  upVector: Vec3;
  viewToWorldScale: number;
  aspectRatio?: number;
};

export type BcfPerspectiveCamera = {
  kind: "perspective";
  viewPoint: Vec3;
  direction: Vec3;
  upVector: Vec3;
  fieldOfView: number;
  aspectRatio?: number;
};

export type BcfCamera = BcfOrthogonalCamera | BcfPerspectiveCamera;

export type BcfClippingPlane = { location: Vec3; direction: Vec3 };

export type BcfLine = { start: Vec3; end: Vec3 };

export type BcfBitmap = {
  guid?: Guid;
  format: string;
  reference: string;
  location: Vec3;
  normal: Vec3;
  up: Vec3;
  height: number;
  bytes?: Uint8Array;
};

/** A PNG kept as bytes so it can be re-zipped byte-identical on export. */
export type BcfSnapshot = {
  fileName: string;
  bytes: Uint8Array;
};

export type BcfViewpoint = {
  guid: Guid;
  /** File name inside the topic folder, e.g. `viewpoint.bcfv`. */
  fileName: string;
  index?: number;
  camera: BcfCamera | null;
  components: BcfComponents | null;
  clippingPlanes: BcfClippingPlane[];
  lines: BcfLine[];
  bitmaps: BcfBitmap[];
  snapshot?: BcfSnapshot;
};

export type BcfTopic = {
  guid: Guid;
  serverAssignedId?: string;
  topicType?: string;
  topicStatus?: string;
  title: string;
  priority?: string;
  index?: number;
  labels: string[];
  creationDate: string;
  creationAuthor: string;
  modifiedDate?: string;
  modifiedAuthor?: string;
  dueDate?: string;
  assignedTo?: string;
  stage?: string;
  description?: string;
  referenceLinks: string[];
  bimSnippet?: BcfBimSnippet;
  documentReferences: BcfDocumentReference[];
  relatedTopics: Guid[];
  comments: BcfComment[];
  viewpoints: BcfViewpoint[];
  headerFiles: BcfHeaderFile[];
};

// ---------------------------------------------------------------------------
// File
// ---------------------------------------------------------------------------

export type BcfFile = {
  /** What the file said it was. Everything here is normalised to 3.0 anyway. */
  sourceVersion: BcfVersion;
  /** Original file name, for the export default and for merge provenance. */
  name: string;
  project: BcfProject;
  extensions: BcfExtensions;
  topics: BcfTopic[];
  documents: BcfDocument[];
};

export function mergeExtensions(
  base: BcfExtensions,
  extra: BcfExtensions,
): BcfExtensions {
  const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];

  return {
    topicTypes: union(base.topicTypes, extra.topicTypes),
    topicStatuses: union(base.topicStatuses, extra.topicStatuses),
    priorities: union(base.priorities, extra.priorities),
    topicLabels: union(base.topicLabels, extra.topicLabels),
    users: union(base.users, extra.users),
    snippetTypes: union(base.snippetTypes, extra.snippetTypes),
    stages: union(base.stages, extra.stages),
  };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function newGuid(): Guid {
  return crypto.randomUUID();
}

/** BCF dates are xs:dateTime; the schema examples are all UTC. */
export function bcfNow(): string {
  return new Date().toISOString();
}

export function emptyBcfFile(name = "issues.bcf"): BcfFile {
  return {
    sourceVersion: "3.0",
    name,
    project: {},
    extensions: { ...DEFAULT_EXTENSIONS },
    topics: [],
    documents: [],
  };
}

export function createTopic(options: {
  title: string;
  author: string;
  topicType?: string;
  topicStatus?: string;
  priority?: string;
  description?: string;
  assignedTo?: string;
  dueDate?: string;
  labels?: string[];
  stage?: string;
}): BcfTopic {
  const now = bcfNow();
  return {
    guid: newGuid(),
    title: options.title,
    topicType: options.topicType,
    topicStatus: options.topicStatus,
    priority: options.priority,
    description: options.description,
    assignedTo: options.assignedTo,
    dueDate: options.dueDate,
    stage: options.stage,
    labels: options.labels ?? [],
    creationDate: now,
    creationAuthor: options.author,
    referenceLinks: [],
    documentReferences: [],
    relatedTopics: [],
    comments: [],
    viewpoints: [],
    headerFiles: [],
  };
}

export function createComment(options: {
  author: string;
  comment: string;
  viewpointGuid?: Guid;
}): BcfComment {
  return {
    guid: newGuid(),
    date: bcfNow(),
    author: options.author,
    comment: options.comment,
    viewpointGuid: options.viewpointGuid,
  };
}
