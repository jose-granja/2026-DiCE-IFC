/**
 * Federation: putting several independently-authored models in one coordinate
 * frame.
 *
 * This is pure arithmetic, deliberately separated from the store and the
 * renderer, because misalignment is the failure mode that is hardest to debug
 * by looking at it — two models 40 km apart look identical to two models
 * perfectly aligned when you are zoomed out far enough to see both.
 *
 * ## Frames
 *
 * Three coordinate frames are in play. Confusing them is the whole problem.
 *
 * 1. **Map frame** — a projected CRS, e.g. ETRS89/PT-TM06 (EPSG:3763).
 *    Eastings, northings, orthogonal height, in metres. This is the only frame
 *    two models from different authors can be assumed to share.
 *
 * 2. **IFC frame** — the file's own coordinates, Z-up. `IfcMapConversion` maps
 *    this to the map frame: a rotation about Z, a uniform scale, and a
 *    translation to (Eastings, Northings, OrthogonalHeight).
 *
 * 3. **Render frame** — what the engine emits, **Y-up metres**, with a
 *    per-model RTC shift already applied so building-scale coordinates stay
 *    inside float32 precision.
 *
 * The IFC→render axis mapping was determined empirically against
 * `@ifc-lite/geometry` (see `federation.test.ts`), not assumed:
 *
 * ```
 * render.x =  ifc.x
 * render.y =  ifc.z
 * render.z = -ifc.y
 * ```
 *
 * ## The alignment problem
 *
 * Each model's meshes are already near its own origin. To federate, every model
 * needs a translation into one shared frame. When a model is georeferenced, its
 * true position is known in the map frame and alignment is exact. When it is
 * not, the best available anchor is its own bounds, and the result is a guess —
 * which the UI must say out loud rather than quietly presenting as correct.
 */

import type { CoordinateInfo, GeoreferenceView, Vec3 } from "@/lib/ifc/types";

// ---------------------------------------------------------------------------
// Axis conversion
// ---------------------------------------------------------------------------

/** IFC (Z-up) → render (Y-up). */
export function ifcToRender(v: Vec3): Vec3 {
  return [v[0], v[2], -v[1]];
}

/** Render (Y-up) → IFC (Z-up). The inverse of {@link ifcToRender}. */
export function renderToIfc(v: Vec3): Vec3 {
  return [v[0], -v[2], v[1]];
}

export function addVec(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function subVec(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export const ZERO: Vec3 = [0, 0, 0];

/**
 * Collapse `-0` to `0`.
 *
 * Negating a zero component (map northing → render z) produces `-0`, which
 * compares equal to `0` but serialises as `-0` in a saved workspace and renders
 * as "-0.00 m" in the offset inspector. Neither is wrong, both look like a bug.
 */
export function normalizeZeros(v: Vec3): Vec3 {
  return [v[0] === 0 ? 0 : v[0], v[1] === 0 ? 0 : v[1], v[2] === 0 ? 0 : v[2]];
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type FederationModelInput = {
  id: string;
  name: string;
  coordinates: CoordinateInfo;
  georeference: GeoreferenceView;
  /** Manual override, in render-frame metres, applied on top of everything. */
  manualOffset?: Vec3;
};

export type WorldOriginSource =
  /** Derived from a model's `IfcMapConversion`. Exact, and shareable. */
  | "mapConversion"
  /** Derived from `IfcSite` latitude/longitude. Coarse, but real-world. */
  | "siteLocation"
  /** No georeferencing anywhere — the first model's own frame is the origin. */
  | "firstModel"
  /** The user pinned it. */
  | "manual";

export type WorldOrigin = {
  source: WorldOriginSource;
  /**
   * Position of the federated world origin in the **map frame**
   * (eastings, northings, height), when one is known. Absent for `firstModel`.
   */
  mapPosition?: Vec3;
  /** EPSG name from `IfcProjectedCRS`, when known. */
  crs?: string;
  /** The model the origin was derived from. */
  derivedFrom?: string;
};

export type ModelPlacement = {
  modelId: string;
  /** Translation to apply to the whole model, in render-frame metres. */
  offset: Vec3;
  /** Rotation about the render-frame Y axis, radians. */
  rotationY: number;
  /**
   * How trustworthy this placement is. `exact` means both this model and the
   * world origin came from an `IfcMapConversion` in the same CRS. Anything less
   * must be surfaced in the UI — see `ModelPlacement.reason`.
   */
  confidence: "exact" | "approximate" | "unaligned";
  reason: string;
};

// ---------------------------------------------------------------------------
// Map-frame position of a model
// ---------------------------------------------------------------------------

/**
 * The map-frame position of a model's **render-frame origin**.
 *
 * `IfcMapConversion` places the IFC origin at (Eastings, Northings,
 * OrthogonalHeight). The render frame is additionally shifted by the engine's
 * RTC `originShift`, so the render origin sits at the map position of the IFC
 * point that the shift moved to zero.
 *
 * Returns null when the model carries no map conversion.
 */
export function mapPositionOfRenderOrigin(
  model: FederationModelInput,
): Vec3 | null {
  const conversion = model.georeference.mapConversion;
  if (!conversion) return null;

  const { eastings, northings, orthogonalHeight } = conversion;

  // The RTC shift is reported in the render frame; convert it back to IFC to
  // combine it with the map conversion, which is defined on IFC axes.
  const shiftIfc = renderToIfc(model.coordinates.originShift);

  const scale = conversion.scale ?? 1;
  const { cos, sin } = gridRotation(conversion);

  // IfcMapConversion: E = Eastings + scale * (x·XAxisAbscissa − y·XAxisOrdinate)
  //                   N = Northings + scale * (x·XAxisOrdinate + y·XAxisAbscissa)
  const x = shiftIfc[0];
  const y = shiftIfc[1];

  return [
    eastings + scale * (x * cos - y * sin),
    northings + scale * (x * sin + y * cos),
    orthogonalHeight + scale * shiftIfc[2],
  ];
}

function gridRotation(conversion: {
  xAxisAbscissa?: number;
  xAxisOrdinate?: number;
}): { cos: number; sin: number } {
  const abscissa = conversion.xAxisAbscissa ?? 1;
  const ordinate = conversion.xAxisOrdinate ?? 0;

  // The pair is a direction, not necessarily a unit one — normalise so a file
  // that writes (2, 0) does not double every coordinate.
  const magnitude = Math.hypot(abscissa, ordinate);
  if (magnitude === 0) return { cos: 1, sin: 0 };
  return { cos: abscissa / magnitude, sin: ordinate / magnitude };
}

/** Counter-clockwise angle from map north to the model's grid, radians. */
export function gridRotationAngle(model: FederationModelInput): number {
  const conversion = model.georeference.mapConversion;
  if (!conversion) return 0;
  const { cos, sin } = gridRotation(conversion);
  return Math.atan2(sin, cos);
}

// ---------------------------------------------------------------------------
// World origin
// ---------------------------------------------------------------------------

/**
 * Choose the shared world origin for a federation.
 *
 * Order of preference, as specified in the build brief:
 *   1. the first model with an `IfcMapConversion`;
 *   2. otherwise the first model with an `IfcSite` location;
 *   3. otherwise the first model's own frame.
 *
 * "First" means first in the given order, which is load order — stable and
 * explainable, unlike "largest" or "most central".
 */
export function deriveWorldOrigin(
  models: FederationModelInput[],
  manual?: { mapPosition: Vec3; crs?: string },
): WorldOrigin {
  if (manual) {
    return { source: "manual", mapPosition: manual.mapPosition, crs: manual.crs };
  }

  const georeferenced = models.find((m) => m.georeference.mapConversion);
  if (georeferenced) {
    return {
      source: "mapConversion",
      mapPosition: mapPositionOfRenderOrigin(georeferenced)!,
      crs: georeferenced.georeference.projectedCRS?.name,
      derivedFrom: georeferenced.id,
    };
  }

  const sited = models.find(
    (m) =>
      m.georeference.site?.latitude !== undefined &&
      m.georeference.site?.longitude !== undefined,
  );
  if (sited) {
    // Latitude/longitude alone cannot be turned into a projected position
    // without choosing a CRS, which is `/georef`'s job, not the viewer's. Record
    // the provenance and place models by their own frames — honest, and it
    // keeps this module free of a projection dependency.
    return { source: "siteLocation", derivedFrom: sited.id };
  }

  return { source: "firstModel", derivedFrom: models[0]?.id };
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/**
 * Where to put each model, given a shared origin.
 *
 * A model with a map conversion is placed exactly. A model without one is left
 * in its own frame and reported as `unaligned`: the alternative — guessing from
 * bounding boxes — produces confident-looking nonsense, and a coordinator
 * needs to know which models are actually positioned and which are merely
 * present.
 */
export function computePlacements(
  models: FederationModelInput[],
  origin: WorldOrigin,
): ModelPlacement[] {
  return models.map((model) => {
    const manual = model.manualOffset;

    const withManual = (placement: Omit<ModelPlacement, "modelId">): ModelPlacement => ({
      modelId: model.id,
      ...placement,
      offset: normalizeZeros(
        manual ? addVec(placement.offset, manual) : placement.offset,
      ),
      reason: manual
        ? `${placement.reason} Manual offset applied.`
        : placement.reason,
    });

    const mapPosition = mapPositionOfRenderOrigin(model);

    if (origin.mapPosition && mapPosition) {
      const modelCrs = model.georeference.projectedCRS?.name;
      const crsMatches = !origin.crs || !modelCrs || origin.crs === modelCrs;

      // Difference in the map frame (E, N, H) → render frame (x, y, z).
      const deltaMap = subVec(mapPosition, origin.mapPosition);
      const offset: Vec3 = [deltaMap[0], deltaMap[2], -deltaMap[1]];

      return withManual({
        offset,
        rotationY: -gridRotationAngle(model),
        confidence: crsMatches ? "exact" : "approximate",
        reason: crsMatches
          ? `Positioned from IfcMapConversion${origin.crs ? ` in ${origin.crs}` : ""}.`
          : `Positioned from IfcMapConversion, but this model declares ${modelCrs} while the federation origin is ${origin.crs}. Coordinates were not reprojected.`,
      });
    }

    if (model.id === origin.derivedFrom) {
      return withManual({
        offset: ZERO,
        rotationY: 0,
        confidence: origin.source === "mapConversion" ? "exact" : "approximate",
        reason: "This model defines the federation origin.",
      });
    }

    return withManual({
      offset: ZERO,
      rotationY: 0,
      confidence: "unaligned",
      reason:
        "No IfcMapConversion, so this model is shown in its own coordinates and may not line up. Georeference it, or set a manual offset.",
    });
  });
}

/**
 * Bounds of the whole federation in render space, for framing the camera.
 * Returns null when nothing has geometry yet.
 */
export function federatedBounds(
  entries: Array<{ bounds: CoordinateInfo["shiftedBounds"]; offset: Vec3 }>,
): { min: Vec3; max: Vec3 } | null {
  if (entries.length === 0) return null;

  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];

  for (const { bounds, offset } of entries) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], bounds.min[axis] + offset[axis]);
      max[axis] = Math.max(max[axis], bounds.max[axis] + offset[axis]);
    }
  }

  if (!Number.isFinite(min[0])) return null;
  return { min, max };
}
