/**
 * BCF viewpoints ↔ viewer state.
 *
 * This is the payoff for Phase 2 and Phase 7 sharing one viewer: opening a
 * topic puts the camera where the author had it, hides what they had hidden,
 * and colours what they had coloured.
 *
 * Pure arithmetic and pure data — no store, no renderer, no engine. The React
 * side lives in `app/(home)/bcf/_components/`, and resolving IFC GlobalIds to
 * loaded entities is `resolver.ts`. Keeping this layer free of all three is
 * what makes the frame conversions testable, and the frame conversions are the
 * part that is easy to get quietly wrong.
 *
 * ## Frames
 *
 * BCF cameras are in **IFC world coordinates: Z-up, metres, unshifted**. The
 * viewer renders in the **render frame: Y-up metres, with the engine's RTC
 * `originShift` already applied, plus a federation placement offset**. So:
 *
 * ```
 * render = ifcToRender(bcf) − originShift + placement.offset
 * bcf    = renderToIfc(render + originShift − placement.offset)
 * ```
 *
 * The `originShift` sign follows `lib/georef/footprint.ts`, which converts the
 * same way in the other direction. Getting it backwards puts the camera twice
 * the shift away from the model — which, for a model with large coordinates,
 * means staring at empty space with the building behind you.
 */

import type { Vec3 } from "@/lib/ifc/types";
import {
  addVec,
  ifcToRender,
  renderToIfc,
  subVec,
  normalizeZeros,
} from "@/lib/viewer/federation";
import type { SectionAxis, SectionPlane } from "@/lib/viewer/tools";
import type {
  BcfCamera,
  BcfClippingPlane,
  BcfComponents,
  BcfViewpoint,
} from "./types";

/** What a model contributes to the conversion. */
export type ViewpointFrame = {
  /** The engine's RTC shift, render frame. */
  originShift: Vec3;
  /** The model's federation placement, render frame. */
  placementOffset: Vec3;
};

export const IDENTITY_FRAME: ViewpointFrame = {
  originShift: [0, 0, 0],
  placementOffset: [0, 0, 0],
};

export function bcfPointToRender(point: Vec3, frame: ViewpointFrame): Vec3 {
  return normalizeZeros(
    addVec(subVec(ifcToRender(point), frame.originShift), frame.placementOffset),
  );
}

export function renderPointToBcf(point: Vec3, frame: ViewpointFrame): Vec3 {
  return normalizeZeros(
    renderToIfc(addVec(subVec(point, frame.placementOffset), frame.originShift)),
  );
}

/** Directions are rotations only — no translation, so no shift or offset. */
export function bcfDirectionToRender(direction: Vec3): Vec3 {
  return normalizeZeros(ifcToRender(direction));
}

export function renderDirectionToBcf(direction: Vec3): Vec3 {
  return normalizeZeros(renderToIfc(direction));
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

/** What `ViewerRenderer.setCameraState` accepts. */
export type CameraState = {
  position: Vec3;
  target: Vec3;
  fov?: number;
};

/**
 * Turn a BCF camera into a viewer camera.
 *
 * BCF describes a camera as position + direction; the viewer's orbit controls
 * need a **target** to pivot around. The direction alone does not give one, so
 * a distance has to come from somewhere: `targetDistance` — the size of what is
 * being looked at — is the least surprising choice. Too small and orbiting
 * spins on the spot in front of the model; too large and it barely moves.
 */
export function cameraToViewer(
  camera: BcfCamera,
  frame: ViewpointFrame,
  targetDistance = 10,
): CameraState {
  const position = bcfPointToRender(camera.viewPoint, frame);
  const direction = normalize(bcfDirectionToRender(camera.direction));

  const distance =
    camera.kind === "orthogonal"
      ? // An orthogonal camera has no position in depth that means anything to
        // a perspective one, so its framed height is the only scale available.
        Math.max(camera.viewToWorldScale, 1)
      : targetDistance;

  return {
    position,
    target: normalizeZeros(addVec(position, scale(direction, distance))),
    // BCF's FieldOfView is the vertical angle in degrees, which is exactly what
    // a three.js PerspectiveCamera means by `fov` — no conversion.
    fov: camera.kind === "perspective" ? camera.fieldOfView : undefined,
  };
}

/**
 * Turn the viewer's camera into a BCF perspective camera.
 *
 * Always perspective: the viewer has no orthogonal mode, and writing an
 * `OrthogonalCamera` with a made-up `ViewToWorldScale` would be a lie that
 * another tool would faithfully restore.
 */
export function cameraFromViewer(
  state: CameraState,
  frame: ViewpointFrame,
  aspectRatio: number,
): BcfCamera {
  const direction = normalize(subVec(state.target, state.position));

  return {
    kind: "perspective",
    viewPoint: renderPointToBcf(state.position, frame),
    direction: renderDirectionToBcf(direction),
    // Z-up in the IFC frame. The viewer's own up is the render frame's Y.
    upVector: renderDirectionToBcf(upFor(direction)),
    fieldOfView: state.fov ?? 60,
    aspectRatio: aspectRatio > 0 ? aspectRatio : 1,
  };
}

/**
 * A camera up vector perpendicular to the view direction.
 *
 * Writing a constant world up is wrong when looking straight down — up and
 * direction become parallel, which some viewers resolve as a 90° roll. This
 * projects world up onto the view plane, and falls back to the render frame's
 * −Z (IFC north) when looking exactly along the axis.
 */
function upFor(direction: Vec3): Vec3 {
  const worldUp: Vec3 = [0, 1, 0];
  const alignment = dot(direction, worldUp);

  if (Math.abs(alignment) > 0.9999) return [0, 0, -1];

  return normalize(subVec(worldUp, scale(direction, alignment)));
}

// ---------------------------------------------------------------------------
// Clipping planes
// ---------------------------------------------------------------------------

/**
 * BCF clipping planes → the viewer's section planes.
 *
 * The viewer only has axis-aligned sections, while BCF allows any plane. An
 * oblique plane is therefore **reported, not approximated**: snapping it to the
 * nearest axis would silently show the wrong part of the model, which is worse
 * than saying it could not be applied.
 */
export type ClippingConversion = {
  planes: SectionPlane[];
  /** Planes that could not be represented, for the UI to mention. */
  skipped: number;
};

export function clippingPlanesToSections(
  planes: BcfClippingPlane[],
  frame: ViewpointFrame,
): ClippingConversion {
  const sections: SectionPlane[] = [];
  let skipped = 0;

  planes.forEach((plane, index) => {
    const normal = normalize(bcfDirectionToRender(plane.direction));
    const axis = axisOf(normal);

    if (!axis) {
      skipped += 1;
      return;
    }

    const location = bcfPointToRender(plane.location, frame);
    const component = AXIS_INDEX[axis];

    sections.push({
      id: `bcf-${index}`,
      axis,
      position: location[component],
      // The viewer keeps the side *below* the plane unless flipped; BCF keeps
      // the side the normal points away from.
      flipped: normal[component] > 0,
      enabled: true,
    });
  });

  return { planes: sections, skipped };
}

export function sectionsToClippingPlanes(
  sections: SectionPlane[],
  frame: ViewpointFrame,
): BcfClippingPlane[] {
  return sections
    .filter((section) => section.enabled)
    .map((section) => {
      const component = AXIS_INDEX[section.axis];

      const location: Vec3 = [0, 0, 0];
      location[component] = section.position;

      const direction: Vec3 = [0, 0, 0];
      direction[component] = section.flipped ? 1 : -1;

      return {
        location: renderPointToBcf(location, frame),
        direction: renderDirectionToBcf(direction),
      };
    });
}

const AXIS_INDEX: Record<SectionAxis, number> = { x: 0, y: 1, z: 2 };

/** The axis a normal lies on, or null when it is oblique. */
function axisOf(normal: Vec3): SectionAxis | null {
  const tolerance = 1e-3;

  for (const [axis, index] of Object.entries(AXIS_INDEX) as Array<
    [SectionAxis, number]
  >) {
    if (Math.abs(Math.abs(normal[index]) - 1) < tolerance) {
      const others = [0, 1, 2].filter((i) => i !== index);
      if (others.every((i) => Math.abs(normal[i]) < tolerance)) return axis;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/**
 * What a viewpoint's components ask the viewer to do, as GlobalIds.
 *
 * Still vendor-neutral: turning these into `EntityRef`s needs the loaded
 * models, which is `resolver.ts`'s job.
 */
export type ComponentPlan = {
  select: string[];
  /** Non-null means "show only these". */
  isolate: string[] | null;
  hide: string[];
  colouring: Array<{ ifcGuid: string; colour: string }>;
};

/**
 * Read a viewpoint's visibility instructions.
 *
 * `DefaultVisibility` inverts everything and is the single most common thing
 * to get backwards:
 *
 * - `true` (the default) — everything is visible **except** the exceptions,
 *   i.e. the exceptions are a hide list.
 * - `false` — everything is hidden **except** the exceptions, i.e. the
 *   exceptions are an isolate list. This is how every "show me just this wall"
 *   viewpoint in the official test suite is written.
 */
export function componentPlan(components: BcfComponents | null): ComponentPlan {
  if (!components) {
    return { select: [], isolate: null, hide: [], colouring: [] };
  }

  const exceptions = guidsOf(components.exceptions);

  return {
    select: guidsOf(components.selection),
    isolate: components.defaultVisibility ? null : exceptions,
    hide: components.defaultVisibility ? exceptions : [],
    colouring: components.coloring.flatMap((entry) =>
      guidsOf(entry.components).map((ifcGuid) => ({
        ifcGuid,
        colour: cssColour(entry.colour),
      })),
    ),
  };
}

function guidsOf(components: Array<{ ifcGuid?: string }>): string[] {
  return components
    .map((component) => component.ifcGuid)
    .filter((guid): guid is string => Boolean(guid));
}

/**
 * BCF's hex to a CSS colour.
 *
 * Values are RGB or RGBA by the time they get here — `parse.ts` reorders 2.1's
 * ARGB on import — so the alpha, if any, is last. CSS `#rrggbbaa` means the
 * same thing, so this is a `#` and a length check.
 */
export function cssColour(hex: string): string {
  const clean = hex.trim().replace(/^#/, "");
  if (!/^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(clean)) return "#ff00ff";
  return `#${clean.toLowerCase()}`;
}

/** The inverse, for viewpoints created in the viewer. */
export function bcfColour(css: string): string {
  const clean = css.trim().replace(/^#/, "");
  if (/^[0-9A-Fa-f]{3}$/.test(clean)) {
    // Expand #abc, which BCF has no short form for.
    return [...clean].map((character) => character + character).join("").toUpperCase();
  }
  return /^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(clean)
    ? clean.toUpperCase()
    : "FF00FF";
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

/** A one-line description of what opening a viewpoint will do. */
export function describeViewpoint(viewpoint: BcfViewpoint): string {
  const parts: string[] = [];
  const plan = componentPlan(viewpoint.components);

  if (viewpoint.camera) {
    parts.push(
      viewpoint.camera.kind === "perspective"
        ? "perspective camera"
        : "orthogonal camera",
    );
  }
  if (plan.select.length > 0) parts.push(`${plan.select.length} selected`);
  if (plan.isolate) parts.push(`${plan.isolate.length} isolated`);
  if (plan.hide.length > 0) parts.push(`${plan.hide.length} hidden`);
  if (plan.colouring.length > 0) parts.push(`${plan.colouring.length} coloured`);
  if (viewpoint.clippingPlanes.length > 0) {
    parts.push(
      `${viewpoint.clippingPlanes.length} clipping plane${viewpoint.clippingPlanes.length === 1 ? "" : "s"}`,
    );
  }

  return parts.length > 0 ? parts.join(", ") : "no camera or components";
}

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (length === 0) return [0, 0, -1];
  return [v[0] / length, v[1] / length, v[2] / length];
}

function scale(v: Vec3, factor: number): Vec3 {
  return [v[0] * factor, v[1] * factor, v[2] * factor];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
