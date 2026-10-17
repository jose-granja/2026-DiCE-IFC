/**
 * `project.json`: everything about a viewer session that is not a file.
 *
 * A project folder is the files the user opened — models, point clouds, the
 * context model, IDS and BCF — plus the quantity list and the clash matrix as
 * Excel workbooks, next to this one JSON document. It points to each of those
 * files and says how the rest was set up: colours and offsets, the camera,
 * filters, section planes and measurements.
 *
 * ## Read as untrusted input
 *
 * A folder can come from anyone, so this is parsed, never trusted: every field
 * goes through a schema, and a malformed one is refused with a message naming
 * it rather than surfacing later as a crash deep in a matcher or the renderer.
 * Paths in it are only ever looked up among the files in the folder the user
 * picked — nothing here is fetched.
 *
 * ## Elements are named by model index, not model id
 *
 * Model ids are minted per load, so a saved id means nothing after a reload.
 * An element is `{ model, expressId }` where `model` indexes `models`: the
 * folder carries the exact bytes, so the parser assigns the same express ids
 * again.
 */

import { z } from "zod";

import { HATCH_PATTERNS } from "@/lib/viewer/section-cap";
import { lensListSchema } from "@/lib/lens/schema";
import { TYPE_VISIBILITY_CATEGORIES } from "@/lib/viewer/type-visibility";
import { GLOBE_LAYERS } from "@/lib/viewer/globe-layers";

export const PROJECT_FORMAT = "dice-ifc-project";
export const PROJECT_VERSION = 1;
export const PROJECT_FILE = "project.json";

const finite = z.number().finite();
const vec3 = z.tuple([finite, finite, finite]);
const text = z.string().max(10_000);
const path = z.string().min(1).max(1_000);

/** An element of a saved model: `model` indexes `ProjectManifest.models`. */
const elementRef = z.object({
  model: z.number().int().nonnegative(),
  expressId: z.number().int().nonnegative(),
});
export type ProjectElementRef = z.infer<typeof elementRef>;

const textList = z.array(text).max(10_000);

// ---------------------------------------------------------------------------
// Viewer state
// ---------------------------------------------------------------------------

const camera = z.object({
  position: vec3,
  target: vec3,
  projection: z.enum(["perspective", "orthographic"]).optional(),
  fov: finite.optional(),
  viewHeight: finite.optional(),
});

const sectionPlane = z.object({
  id: text,
  axis: z.enum(["x", "y", "z"]),
  position: finite,
  rotation: finite,
  flipped: z.boolean(),
  enabled: z.boolean(),
});

const colour = z.string().regex(/^#[0-9a-fA-F]{3,8}$/);

const sectionCapStyle = z.object({
  enabled: z.boolean(),
  pattern: z.enum(HATCH_PATTERNS),
  fillColour: colour,
  hatchColour: colour,
  hatchSpacing: finite,
  hatchWidth: finite,
  borderColour: colour,
  borderWidth: finite,
});

const triangle = z.tuple([vec3, vec3, vec3]);

const measurements = z.object({
  distances: z.array(z.object({ id: text, start: vec3, end: vec3 })).max(10_000),
  angles: z.array(z.object({ id: text, a: vec3, vertex: vec3, c: vec3 })).max(10_000),
  areas: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({ id: text, kind: z.literal("points"), points: z.array(vec3).min(3).max(10_000) }),
        z.object({
          id: text,
          kind: z.literal("face"),
          element: elementRef,
          triangles: z.array(triangle).max(1_000_000),
        }),
      ]),
    )
    .max(10_000),
  volumes: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({
          id: text,
          kind: z.literal("element"),
          element: elementRef,
          volume: finite,
          centroid: vec3,
        }),
        z.object({ id: text, kind: z.literal("box"), corner1: vec3, corner2: vec3 }),
      ]),
    )
    .max(10_000),
});

const typeVisibility = z.object(
  Object.fromEntries(TYPE_VISIBILITY_CATEGORIES.map((category) => [category, z.boolean()])) as Record<
    (typeof TYPE_VISIBILITY_CATEGORIES)[number],
    z.ZodBoolean
  >,
);

const facetDimension = textList.optional();

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export const projectManifestSchema = z.object({
  format: z.literal(PROJECT_FORMAT),
  version: z.number().int().positive(),
  savedAt: text,

  models: z
    .array(
      z.object({
        path,
        name: text,
        colour: colour.optional(),
        visible: z.boolean().default(true),
        manualOffset: vec3.optional(),
      }),
    )
    .max(1_000),
  pointClouds: z
    .array(
      z.object({
        path,
        name: text,
        frame: z.enum(["map", "model"]).optional(),
        mode: z.enum(["rgb", "intensity", "height", "flat"]).optional(),
        size: finite.optional(),
        visible: z.boolean().default(true),
      }),
    )
    .max(1_000)
    .default([]),
  context: z
    .object({
      path,
      name: text,
      visible: z.boolean().default(true),
      clipEnabled: z.boolean().default(true),
      clipRadius: text.default("100"),
      appearance: z.object({
        edgesOn: z.boolean().default(true),
        edgeWidth: finite.min(0.5).max(3).default(1),
        colouring: z.object({
          property: text,
          overrides: z.record(text, z.string().regex(/^#[\da-f]{6}$/i)).default({}),
        }).nullable().default(null),
      }).default({ edgesOn: true, edgeWidth: 1, colouring: null }),
    })
    .nullable()
    .default(null),
  ids: z
    .object({
      /** The IDS the validator is set to run. */
      validation: z
        .object({ path, title: text, source: z.enum(["file", "editor"]).default("file") })
        .nullable()
        .default(null),
      /** The IDS editor's working document. */
      editor: z.object({ path }).nullable().default(null),
    })
    .default({ validation: null, editor: null }),
  bcf: z
    .object({
      path,
      /** Whether the topics' 3D markers were shown in the viewport. */
      markersVisible: z.boolean().default(false),
    })
    .nullable()
    .default(null),

  /**
   * The quantity list and the clash matrix are Excel workbooks in the folder —
   * the same files the panels import and export, so either can be opened,
   * edited in Excel and loaded back. Null when the session had none.
   */
  quantities: z.object({ path }).nullable().default(null),
  clash: z.object({ path }).nullable().default(null),

  viewer: z
    .object({
      panel: text.optional(),
      camera: camera.nullable().default(null),
      display: z
        .object({
          lightIntensity: finite,
          exposure: finite,
          edgesOn: z.boolean(),
          edgeWidth: finite,
        })
        .optional(),
      typeVisibility: typeVisibility.optional(),
      sectionCapStyle: sectionCapStyle.optional(),
      snapTargets: z
        .object({ corner: z.boolean(), edgeMidpoint: z.boolean(), edge: z.boolean() })
        .optional(),
      areaMode: z.enum(["points", "face"]).optional(),
      volumeMode: z.enum(["element", "box"]).optional(),
      /** The point clouds' edge shading; absent in projects from before it existed (on). */
      pointCloudEdgeShading: z.boolean().optional(),
      /**
       * The 3D world context. Saved as it was; a restore asks before turning
       * it on, because it is the one request that leaves for a third party.
       */
      globe: z
        .object({
          on: z.boolean(),
          layer: z.enum(GLOBE_LAYERS),
          assetId: text.default(""),
          url: text.default(""),
        })
        .optional(),
      /**
       * Where the federation's world origin was, so a restore can tell when the
       * render frame did not come back the same and section planes and
       * measurements — which are stored in it — would be offset.
       */
      worldOrigin: z
        .object({ source: text, mapPosition: vec3.optional() })
        .nullable()
        .default(null),
    })
    .default({ camera: null, worldOrigin: null }),

  filters: z
    .object({
      /** IFC classes the class filter narrows to. */
      classes: textList.default([]),
      facets: z
        .object({
          hierarchy: facetDimension,
          classes: facetDimension,
          types: facetDimension,
          materials: facetDimension,
          groups: facetDimension,
        })
        .default({}),
      hidden: z.array(elementRef).max(10_000_000).default([]),
      isolated: z.array(elementRef).max(10_000_000).nullable().default(null),
      isolationFilterMode: z.enum(["replace", "intersect"]).nullable().default(null),
      selection: z.array(elementRef).max(10_000_000).default([]),
    })
    .default({}),

  /**
   * The user's lenses (`lib/lens/`) as a lens list in the folder — the same
   * file the Lens tab downloads and uploads — and which lens was on, which may
   * be a built-in. `path` is null when the session had no saved lenses.
   * `saved` is how the first projects carried them, inline; still read.
   */
  lenses: z
    .object({
      path: path.nullable().default(null),
      activeId: z.string().max(200).nullable().default(null),
      saved: lensListSchema.optional(),
    })
    .default({ path: null, activeId: null }),
  sectionPlanes: z.array(sectionPlane).max(100).default([]),
  measurements: measurements.default({ distances: [], angles: [], areas: [], volumes: [] }),
});

export type ProjectManifest = z.infer<typeof projectManifestSchema>;
export type ProjectManifestInput = z.input<typeof projectManifestSchema>;

export type ProjectFormatErrorCode = "notJson" | "notProject" | "newerVersion" | "invalid";

/**
 * Why a `project.json` was refused. `code` is for the UI to translate; the
 * message is the English fallback, and `detail` is what the schema said — a
 * path into the document and what was wrong there.
 */
export class ProjectFormatError extends Error {
  constructor(
    readonly code: ProjectFormatErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ProjectFormatError";
  }
}

/** Parse `project.json`. Throws `ProjectFormatError` naming the first problem. */
export function parseProjectManifest(textValue: string): ProjectManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(textValue);
  } catch {
    throw new ProjectFormatError("notJson", `${PROJECT_FILE} is not valid JSON.`);
  }
  if (!raw || typeof raw !== "object" || (raw as { format?: unknown }).format !== PROJECT_FORMAT) {
    throw new ProjectFormatError("notProject", `${PROJECT_FILE} is not a DiCE-IFC project.`);
  }
  const version = (raw as { version?: unknown }).version;
  if (typeof version === "number" && version > PROJECT_VERSION) {
    throw new ProjectFormatError(
      "newerVersion",
      `This project was saved by a newer version of DiCE-IFC (format ${version}); this one reads format ${PROJECT_VERSION}.`,
      String(version),
    );
  }
  const result = projectManifestSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    const detail = `${where}: ${issue.message}`;
    throw new ProjectFormatError("invalid", `${PROJECT_FILE}: ${detail}`, detail);
  }
  return result.data;
}
