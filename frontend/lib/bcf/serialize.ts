/**
 * BCF 3.0 writer.
 *
 * Strict on the way out: the output is validated against the vendored
 * buildingSMART XSDs by `lib/bcf/__tests__/schema.test.ts`, so this file has to
 * respect things the domain model treats as optional but the schema does not.
 * Three of those are easy to get wrong and impossible to notice without a
 * validator:
 *
 * - **`TopicType` and `TopicStatus` are required attributes**, as are `Title`,
 *   `CreationDate` and `CreationAuthor`.
 * - **Every viewpoint must have a camera, and every camera an `AspectRatio`
 *   greater than zero.** The `xs:choice` between the two camera types has no
 *   `minOccurs="0"`.
 * - **`NonEmptyOrBlankString` rejects empty elements**, so an empty value must
 *   be omitted rather than written as `<Description/>`.
 *
 * Anything this has to invent to satisfy the schema is reported as a
 * `WriteNote` rather than applied silently — the same contract as the reader.
 */

import { zipSync } from "fflate";

import type { Vec3 } from "@/lib/ifc/types";
import {
  bcfNow,
  newGuid,
  type BcfCamera,
  type BcfComponent,
  type BcfComponents,
  type BcfFile,
  type BcfTopic,
  type BcfViewpoint,
  type Guid,
} from "./types";

export const BCF_VERSION_ID = "3.0";

/** Something invented or dropped to make the output schema-valid. */
export type WriteNote = {
  path: string;
  message: string;
};

export type SerializeResult = {
  bytes: Uint8Array;
  notes: WriteNote[];
};

export type SerializeOptions = {
  /** Written into `project.bcfp`. A project id is required if one is written. */
  projectId?: string;
};

/**
 * Write a complete `.bcf` archive.
 *
 * Snapshots and documents are copied through byte-for-byte, so a file that was
 * imported and exported without edits keeps its images exactly as they were.
 */
export function serializeBcf(
  file: BcfFile,
  options: SerializeOptions = {},
): SerializeResult {
  const notes: WriteNote[] = [];
  const guids = new GuidMap(file, notes);
  const entries: Record<string, Uint8Array> = {};

  const encoder = new TextEncoder();
  const put = (path: string, contents: string | Uint8Array) => {
    entries[path] = typeof contents === "string" ? encoder.encode(contents) : contents;
  };

  put("bcf.version", versionFile());

  const projectId = options.projectId ?? file.project.projectId;
  if (projectId || file.project.name) {
    put("project.bcfp", projectFile(projectId ?? newGuid(), file.project.name));
  }

  put("extensions.xml", extensionsFile(file));

  if (file.documents.length > 0) {
    put("documents.xml", documentsFile(file, guids));
    for (const document_ of file.documents) {
      // The schema's own note: "Guid of the document. Must match the filename
      // in the BCF" — the stored entry is named by GUID, not by `Filename`.
      put(`Documents/${guids.of(document_.guid)}`, document_.bytes);
    }
  }

  for (const topic of file.topics) {
    const folder = guids.of(topic.guid);
    put(`${folder}/markup.bcf`, markupFile(topic, guids, notes));

    for (const viewpoint of topic.viewpoints) {
      put(
        `${folder}/${viewpoint.fileName}`,
        visualizationInfoFile(viewpoint, guids, notes, `${folder}/${viewpoint.fileName}`),
      );

      if (viewpoint.snapshot) {
        put(`${folder}/${viewpoint.snapshot.fileName}`, viewpoint.snapshot.bytes);
      }
      for (const bitmap of viewpoint.bitmaps) {
        if (bitmap.bytes && bitmap.reference) {
          put(`${folder}/${bitmap.reference}`, bitmap.bytes);
        }
      }
    }
  }

  return { bytes: zipSync(entries), notes };
}

/** `Structural Handover.bcf` for a project named "Structural Handover". */
export function bcfFileName(file: BcfFile): string {
  const base = (file.project.name ?? file.name.replace(/\.bcfzip?$/i, "") ?? "issues")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${base || "issues"}.bcf`;
}

// ---------------------------------------------------------------------------
// GUID normalisation
// ---------------------------------------------------------------------------

/**
 * BCF 3.0's `Guid` type is `[a-f0-9]{8}-…` — **lowercase** hex, and nothing
 * else. Files in the wild routinely carry uppercase GUIDs, and the reader falls
 * back to a folder name when a topic has no GUID at all; both are invalid here.
 *
 * Substituting a value in one place and not another would silently break
 * `RelatedTopic`, a comment's viewpoint link, or a document reference. So every
 * substitution goes through one map, and every read of a GUID goes through
 * `of()`.
 */
class GuidMap {
  private readonly map = new Map<string, Guid>();

  constructor(file: BcfFile, notes: WriteNote[]) {
    const claim = (guid: string, path: string, what: string) => {
      if (this.map.has(guid)) return;

      if (UUID.test(guid)) {
        this.map.set(guid, guid);
        return;
      }

      const lowered = guid.toLowerCase();
      if (UUID.test(lowered)) {
        // Purely a case fix; nothing is lost and nobody needs telling.
        this.map.set(guid, lowered);
        return;
      }

      const replacement = newGuid();
      this.map.set(guid, replacement);
      notes.push({
        path,
        message: `${what} identifier "${guid}" is not a valid BCF GUID; it was replaced with ${replacement}.`,
      });
    };

    for (const document_ of file.documents) {
      claim(document_.guid, "documents.xml", "Document");
    }

    for (const topic of file.topics) {
      claim(topic.guid, `${topic.guid}/markup.bcf`, "Topic");
      const path = `${topic.guid}/markup.bcf`;

      for (const comment of topic.comments) claim(comment.guid, path, "Comment");
      for (const viewpoint of topic.viewpoints) claim(viewpoint.guid, path, "Viewpoint");
      for (const reference of topic.documentReferences) {
        claim(reference.guid, path, "Document reference");
      }
    }
  }

  /**
   * The valid GUID for an identifier. Unknown ones — a `RelatedTopic` pointing
   * outside this file is legal — are normalised in place rather than replaced,
   * because inventing a new GUID would break a link that may resolve elsewhere.
   */
  of(guid: string): Guid {
    const known = this.map.get(guid);
    if (known) return known;

    const lowered = guid.toLowerCase();
    return UUID.test(lowered) ? lowered : guid;
  }

  /** Whether a GUID can legally be written at all. */
  valid(guid: string): boolean {
    return UUID.test(this.of(guid));
  }
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

// ---------------------------------------------------------------------------
// Top-level files
// ---------------------------------------------------------------------------

function versionFile(): string {
  // Built by joining rather than by concatenating template literals — see the
  // note in lib/ids/serialize.ts about the minifier folding a `+` chain and
  // dropping attributes from the production bundle only.
  const attributes = [`VersionId="${BCF_VERSION_ID}"`].join(" ");

  return [DECLARATION, `<Version ${attributes}/>`, ""].join("\n");
}

function projectFile(projectId: string, name: string | undefined): string {
  const lines = [DECLARATION, "<ProjectInfo>", `  <Project ProjectId="${escapeAttr(projectId)}">`];
  push(lines, 2, "Name", name);
  lines.push("  </Project>", "</ProjectInfo>", "");
  return lines.join("\n");
}

function extensionsFile(file: BcfFile): string {
  const lines = [DECLARATION, "<Extensions>"];
  const { extensions } = file;

  // Schema order, which is not the order they are declared in the type.
  const groups: Array<[string, string, string[]]> = [
    ["TopicTypes", "TopicType", extensions.topicTypes],
    ["TopicStatuses", "TopicStatus", extensions.topicStatuses],
    ["Priorities", "Priority", extensions.priorities],
    ["TopicLabels", "TopicLabel", extensions.topicLabels],
    ["Users", "User", extensions.users],
    ["SnippetTypes", "SnippetType", extensions.snippetTypes],
    ["Stages", "Stage", extensions.stages],
  ];

  for (const [container, item, values] of groups) {
    const present = values.filter((value) => value.trim() !== "");
    if (present.length === 0) continue;

    lines.push(`  <${container}>`);
    for (const value of present) push(lines, 2, item, value);
    lines.push(`  </${container}>`);
  }

  lines.push("</Extensions>", "");
  return lines.join("\n");
}

function documentsFile(file: BcfFile, guids: GuidMap): string {
  const lines = [DECLARATION, "<DocumentInfo>", "  <Documents>"];

  for (const document_ of file.documents) {
    lines.push(`    <Document Guid="${escapeAttr(guids.of(document_.guid))}">`);
    push(lines, 3, "Filename", document_.filename);
    push(lines, 3, "Description", document_.description);
    lines.push("    </Document>");
  }

  lines.push("  </Documents>", "</DocumentInfo>", "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// markup.bcf
// ---------------------------------------------------------------------------

function markupFile(topic: BcfTopic, guids: GuidMap, notes: WriteNote[]): string {
  const path = `${guids.of(topic.guid)}/markup.bcf`;
  const lines = [DECLARATION, "<Markup>"];

  if (topic.headerFiles.length > 0) {
    lines.push("  <Header>", "    <Files>");
    for (const file of topic.headerFiles) {
      const attributes = [
        // IfcProject/IfcSpatialStructureElement are `IfcGuid`, i.e. exactly 22
        // characters. A malformed one fails validation, so it is dropped.
        ifcGuidAttribute("IfcProject", file.ifcProject),
        ifcGuidAttribute("IfcSpatialStructureElement", file.ifcSpatialStructureElement),
        ` IsExternal="${file.isExternal}"`,
      ].join("");

      lines.push(`      <File${attributes}>`);
      push(lines, 4, "Filename", file.filename);
      push(lines, 4, "Date", file.date);
      push(lines, 4, "Reference", file.reference);
      lines.push("      </File>");
    }
    lines.push("    </Files>", "  </Header>");
  }

  // Required by the schema; a topic that lost them on the way in still has to
  // produce a valid file, so a documented default beats an invalid export.
  const topicType = fallback(topic.topicType, "Issue", path, "TopicType", notes);
  const topicStatus = fallback(topic.topicStatus, "Open", path, "TopicStatus", notes);
  const creationDate = fallback(topic.creationDate, bcfNow(), path, "CreationDate", notes);
  const creationAuthor = fallback(
    topic.creationAuthor,
    "unknown",
    path,
    "CreationAuthor",
    notes,
  );

  const topicAttributes = [
    `Guid="${escapeAttr(guids.of(topic.guid))}"`,
    topic.serverAssignedId
      ? `ServerAssignedId="${escapeAttr(topic.serverAssignedId)}"`
      : null,
    `TopicType="${escapeAttr(topicType)}"`,
    `TopicStatus="${escapeAttr(topicStatus)}"`,
  ]
    .filter(Boolean)
    .join(" ");

  lines.push(`  <Topic ${topicAttributes}>`);

  list(lines, 2, "ReferenceLinks", "ReferenceLink", topic.referenceLinks);
  push(lines, 2, "Title", fallback(topic.title, "(untitled)", path, "Title", notes));
  push(lines, 2, "Priority", topic.priority);
  if (topic.index !== undefined) push(lines, 2, "Index", String(topic.index));
  list(lines, 2, "Labels", "Label", topic.labels);
  push(lines, 2, "CreationDate", creationDate);
  push(lines, 2, "CreationAuthor", creationAuthor);
  push(lines, 2, "ModifiedDate", topic.modifiedDate);
  push(lines, 2, "ModifiedAuthor", topic.modifiedAuthor);
  push(lines, 2, "DueDate", topic.dueDate);
  push(lines, 2, "AssignedTo", topic.assignedTo);
  push(lines, 2, "Stage", topic.stage);
  push(lines, 2, "Description", topic.description);

  if (topic.bimSnippet && topic.bimSnippet.reference) {
    const snippet = topic.bimSnippet;
    const attributes = [
      `SnippetType="${escapeAttr(snippet.snippetType || "unknown")}"`,
      `IsExternal="${snippet.isExternal}"`,
    ].join(" ");

    lines.push(`    <BimSnippet ${attributes}>`);
    push(lines, 3, "Reference", snippet.reference);
    push(lines, 3, "ReferenceSchema", snippet.referenceSchema || "unknown");
    lines.push("    </BimSnippet>");
  }

  if (topic.documentReferences.length > 0) {
    lines.push("    <DocumentReferences>");
    for (const reference of topic.documentReferences) {
      lines.push(
        `      <DocumentReference Guid="${escapeAttr(guids.of(reference.guid))}">`,
      );
      // The schema makes these an xs:choice: at most one of the two.
      if (reference.documentGuid) {
        push(lines, 4, "DocumentGuid", guids.of(reference.documentGuid));
      } else if (reference.url) {
        push(lines, 4, "Url", reference.url);
      }
      push(lines, 4, "Description", reference.description);
      lines.push("      </DocumentReference>");
    }
    lines.push("    </DocumentReferences>");
  }

  const related = topic.relatedTopics.filter((guid) => guids.valid(guid));
  if (related.length !== topic.relatedTopics.length) {
    notes.push({
      path,
      message: "A related-topic link had an unusable GUID and was dropped.",
    });
  }
  if (related.length > 0) {
    lines.push("    <RelatedTopics>");
    for (const guid of related) {
      lines.push(`      <RelatedTopic Guid="${escapeAttr(guids.of(guid))}"/>`);
    }
    lines.push("    </RelatedTopics>");
  }

  if (topic.comments.length > 0) {
    lines.push("    <Comments>");
    for (const comment of topic.comments) {
      lines.push(`      <Comment Guid="${escapeAttr(guids.of(comment.guid))}">`);
      push(lines, 4, "Date", comment.date || bcfNow());
      push(lines, 4, "Author", comment.author || "unknown");
      push(lines, 4, "Comment", comment.comment);
      if (comment.viewpointGuid && guids.valid(comment.viewpointGuid)) {
        lines.push(
          `        <Viewpoint Guid="${escapeAttr(guids.of(comment.viewpointGuid))}"/>`,
        );
      }
      push(lines, 4, "ModifiedDate", comment.modifiedDate);
      push(lines, 4, "ModifiedAuthor", comment.modifiedAuthor);
      lines.push("      </Comment>");
    }
    lines.push("    </Comments>");
  }

  if (topic.viewpoints.length > 0) {
    lines.push("    <Viewpoints>");
    for (const viewpoint of topic.viewpoints) {
      lines.push(`      <ViewPoint Guid="${escapeAttr(guids.of(viewpoint.guid))}">`);
      push(lines, 4, "Viewpoint", viewpoint.fileName);
      push(lines, 4, "Snapshot", viewpoint.snapshot?.fileName);
      if (viewpoint.index !== undefined) {
        push(lines, 4, "Index", String(viewpoint.index));
      }
      lines.push("      </ViewPoint>");
    }
    lines.push("    </Viewpoints>");
  }

  lines.push("  </Topic>", "</Markup>", "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// .bcfv
// ---------------------------------------------------------------------------

function visualizationInfoFile(
  viewpoint: BcfViewpoint,
  guids: GuidMap,
  notes: WriteNote[],
  path: string,
): string {
  const lines = [
    DECLARATION,
    `<VisualizationInfo Guid="${escapeAttr(guids.of(viewpoint.guid))}">`,
  ];

  if (viewpoint.components) {
    lines.push(...componentsElement(viewpoint.components, 1));
  }

  // Required by the schema — there is no valid camera-less viewpoint. A 2.1
  // file that had none would otherwise make the whole export invalid, and
  // dropping the viewpoint would lose its components too.
  let camera = viewpoint.camera;
  if (!camera) {
    camera = {
      kind: "perspective",
      viewPoint: [0, 0, 0],
      direction: [0, 1, 0],
      upVector: [0, 0, 1],
      fieldOfView: 60,
    };
    notes.push({
      path,
      message:
        "This viewpoint had no camera, which BCF 3.0 requires; a default was written.",
    });
  }
  lines.push(...cameraElement(camera, 1));

  if (viewpoint.lines.length > 0) {
    lines.push("  <Lines>");
    for (const line of viewpoint.lines) {
      lines.push("    <Line>");
      lines.push(...pointElement("StartPoint", line.start, 3));
      lines.push(...pointElement("EndPoint", line.end, 3));
      lines.push("    </Line>");
    }
    lines.push("  </Lines>");
  }

  if (viewpoint.clippingPlanes.length > 0) {
    lines.push("  <ClippingPlanes>");
    for (const plane of viewpoint.clippingPlanes) {
      lines.push("    <ClippingPlane>");
      lines.push(...pointElement("Location", plane.location, 3));
      lines.push(...pointElement("Direction", plane.direction, 3));
      lines.push("    </ClippingPlane>");
    }
    lines.push("  </ClippingPlanes>");
  }

  const bitmaps = viewpoint.bitmaps.filter((bitmap) => bitmap.reference);
  if (bitmaps.length > 0) {
    lines.push("  <Bitmaps>");
    for (const bitmap of bitmaps) {
      lines.push("    <Bitmap>");
      // The schema allows exactly `png` or `jpg`.
      const format = bitmap.format.trim().toLowerCase();
      push(lines, 3, "Format", format === "jpg" || format === "jpeg" ? "jpg" : "png");
      push(lines, 3, "Reference", bitmap.reference);
      lines.push(...pointElement("Location", bitmap.location, 3));
      lines.push(...pointElement("Normal", bitmap.normal, 3));
      lines.push(...pointElement("Up", bitmap.up, 3));
      push(lines, 3, "Height", number(bitmap.height));
      lines.push("    </Bitmap>");
    }
    lines.push("  </Bitmaps>");
  }

  lines.push("</VisualizationInfo>", "");
  return lines.join("\n");
}

/** Schema order: Selection, then Visibility, then Coloring. */
function componentsElement(components: BcfComponents, depth: number): string[] {
  const lines: string[] = [`${indent(depth)}<Components>`];
  const inner = depth + 1;

  if (components.selection.length > 0) {
    lines.push(`${indent(inner)}<Selection>`);
    for (const component of components.selection) {
      lines.push(...componentElement(component, inner + 1));
    }
    lines.push(`${indent(inner)}</Selection>`);
  }

  const hints = components.viewSetupHints;
  const hasVisibility =
    hints !== undefined ||
    components.exceptions.length > 0 ||
    components.defaultVisibility === false;

  if (hasVisibility) {
    lines.push(
      `${indent(inner)}<Visibility DefaultVisibility="${components.defaultVisibility}">`,
    );
    if (hints) {
      // Inside <Visibility>, not next to it — a natural mistake, and one the
      // validator catches.
      const attributes = [
        `SpacesVisible="${hints.spacesVisible}"`,
        `SpaceBoundariesVisible="${hints.spaceBoundariesVisible}"`,
        `OpeningsVisible="${hints.openingsVisible}"`,
      ].join(" ");
      lines.push(`${indent(inner + 1)}<ViewSetupHints ${attributes}/>`);
    }
    if (components.exceptions.length > 0) {
      lines.push(`${indent(inner + 1)}<Exceptions>`);
      for (const component of components.exceptions) {
        lines.push(...componentElement(component, inner + 2));
      }
      lines.push(`${indent(inner + 1)}</Exceptions>`);
    }
    lines.push(`${indent(inner)}</Visibility>`);
  }

  // A <Color> with no components is invalid: the inner <Components> is required
  // and needs at least one child.
  const coloring = components.coloring.filter(
    (entry) => entry.components.length > 0 && COLOUR.test(entry.colour),
  );
  if (coloring.length > 0) {
    lines.push(`${indent(inner)}<Coloring>`);
    for (const entry of coloring) {
      lines.push(`${indent(inner + 1)}<Color Color="${escapeAttr(entry.colour)}">`);
      lines.push(`${indent(inner + 2)}<Components>`);
      for (const component of entry.components) {
        lines.push(...componentElement(component, inner + 3));
      }
      lines.push(`${indent(inner + 2)}</Components>`);
      lines.push(`${indent(inner + 1)}</Color>`);
    }
    lines.push(`${indent(inner)}</Coloring>`);
  }

  lines.push(`${indent(depth)}</Components>`);
  return lines;
}

const COLOUR = /^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;

function componentElement(component: BcfComponent, depth: number): string[] {
  const attributes = ifcGuidAttribute("IfcGuid", component.ifcGuid);

  const children: string[] = [];
  push(children, depth + 1, "OriginatingSystem", component.originatingSystem);
  push(children, depth + 1, "AuthoringToolId", component.authoringToolId);

  if (children.length === 0) return [`${indent(depth)}<Component${attributes}/>`];

  return [
    `${indent(depth)}<Component${attributes}>`,
    ...children,
    `${indent(depth)}</Component>`,
  ];
}

function cameraElement(camera: BcfCamera, depth: number): string[] {
  const tag =
    camera.kind === "perspective" ? "PerspectiveCamera" : "OrthogonalCamera";
  const lines = [`${indent(depth)}<${tag}>`];
  const inner = depth + 1;

  lines.push(...pointElement("CameraViewPoint", camera.viewPoint, inner));
  lines.push(...pointElement("CameraDirection", camera.direction, inner));
  lines.push(...pointElement("CameraUpVector", camera.upVector, inner));

  if (camera.kind === "perspective") {
    // FieldOfView is constrained to 0 < x < 180 exclusive.
    const fov = Math.min(179.9, Math.max(0.1, camera.fieldOfView));
    push(lines, inner, "FieldOfView", number(fov));
  } else {
    push(lines, inner, "ViewToWorldScale", number(camera.viewToWorldScale || 1));
  }

  // Required, and typed PositiveDouble — zero or a missing value fails.
  const aspect = camera.aspectRatio && camera.aspectRatio > 0 ? camera.aspectRatio : 1;
  push(lines, inner, "AspectRatio", number(aspect));

  lines.push(`${indent(depth)}</${tag}>`);
  return lines;
}

function pointElement(tag: string, value: Vec3, depth: number): string[] {
  return [
    `${indent(depth)}<${tag}>`,
    `${indent(depth + 1)}<X>${number(value[0])}</X>`,
    `${indent(depth + 1)}<Y>${number(value[1])}</Y>`,
    `${indent(depth + 1)}<Z>${number(value[2])}</Z>`,
    `${indent(depth)}</${tag}>`,
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

function indent(depth: number): string {
  return "  ".repeat(depth);
}

/** Writes `<tag>value</tag>`, or nothing at all when the value is empty. */
function push(lines: string[], depth: number, tag: string, value?: string) {
  const trimmed = value?.trim();
  if (!trimmed) return;
  lines.push(`${indent(depth)}<${tag}>${escapeText(trimmed)}</${tag}>`);
}

function list(
  lines: string[],
  depth: number,
  container: string,
  item: string,
  values: string[],
) {
  const present = values.filter((value) => value.trim() !== "");
  if (present.length === 0) return;

  lines.push(`${indent(depth)}<${container}>`);
  for (const value of present) push(lines, depth + 1, item, value);
  lines.push(`${indent(depth)}</${container}>`);
}

/** An `IfcGuid` is exactly 22 characters from a restricted alphabet. */
function ifcGuidAttribute(name: string, value: string | undefined): string {
  if (!value || !/^[0-9A-Za-z_$]{22}$/.test(value)) return "";
  return ` ${name}="${escapeAttr(value)}"`;
}

function fallback(
  value: string | undefined,
  replacement: string,
  path: string,
  what: string,
  notes: WriteNote[],
): string {
  const trimmed = value?.trim();
  if (trimmed) return trimmed;

  notes.push({
    path,
    message: `${what} is required by BCF 3.0 but was empty; "${replacement}" was written.`,
  });
  return replacement;
}

/**
 * `-0` serialises as `-0`, which is valid but reads as a bug in a diff and
 * round-trips into the viewer as a negative zero. Same treatment as
 * `normalizeZeros` in lib/viewer/federation.ts.
 */
function number(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Object.is(value, -0) ? "0" : String(value);
}

// Local rather than shared with lib/ids/serialize.ts: six lines of duplication
// is cheaper than coupling the two module writers together.
export function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}
