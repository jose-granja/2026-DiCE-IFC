/**
 * Coordinate transforms: model → map → WGS84, and back.
 *
 * Three frames, and the whole module exists to keep them apart:
 *
 * 1. **Model (local)** — the IFC file's own coordinates, Z-up, in *project
 *    units* (often millimetres). Everything here takes and returns project
 *    units, converting internally, because that is what the file contains and
 *    what the write-back must produce.
 * 2. **Map (projected)** — eastings, northings, orthogonal height, in metres,
 *    in the CRS named by `IfcProjectedCRS`.
 * 3. **WGS84** — longitude, latitude, for the basemap.
 *
 * The model→map step is `IfcMapConversion`: a rotation about the vertical axis,
 * a uniform scale, and a translation. It is not a general affine transform, and
 * writing it as one would let a UI produce a conversion no IFC consumer can
 * represent.
 */

import proj4 from "proj4";

import { CRS_DEFINITIONS, WGS84, WGS84_PROJ4, findCrs } from "@/config/epsg";
import type { MapConversionView } from "@/lib/ifc/types";
import { effectiveScale } from "./scale";

// proj4 only ships WGS84 and a couple of others; anything else silently fails to
// transform unless it is defined. Registering the whole bundled registry once,
// at module load, means a lookup can never miss because of ordering.
let registered = false;

function ensureDefinitions() {
  if (registered) return;
  proj4.defs(WGS84, WGS84_PROJ4);
  for (const crs of CRS_DEFINITIONS) proj4.defs(crs.name, crs.proj4);
  registered = true;
}

/** CRSs from the full EPSG index are not defined up front; do it on first use. */
function defineOnDemand(crs: { name: string; proj4: string }) {
  if (!proj4.defs(crs.name)) proj4.defs(crs.name, crs.proj4);
}

export class UnknownCrsError extends Error {
  constructor(readonly code: number) {
    super(
      `EPSG:${code} is not in the bundled CRS registry (config/epsg.ts or public/crs-index.json).`,
    );
    this.name = "UnknownCrsError";
  }
}

export type LocalPoint = { x: number; y: number; z?: number };
export type MapPoint = { easting: number; northing: number; height?: number };
export type WgsPoint = { longitude: number; latitude: number; height?: number };

/**
 * Everything needed to place a model, in one object.
 *
 * `lengthUnitScale` converts project units to metres. It is required rather than
 * defaulted, because a silent default of 1 puts a millimetre model 1000× too far
 * from its true position — a failure that looks like bad data rather than a bug.
 */
export type Placement = {
  conversion: MapConversionView;
  epsg: number;
  lengthUnitScale: number;
};

// ---------------------------------------------------------------------------
// Model ↔ map
// ---------------------------------------------------------------------------

/** Rotation from `XAxisAbscissa`/`XAxisOrdinate`, normalised. */
export function gridRotation(conversion: MapConversionView): {
  cos: number;
  sin: number;
  degrees: number;
} {
  const abscissa = conversion.xAxisAbscissa ?? 1;
  const ordinate = conversion.xAxisOrdinate ?? 0;

  const magnitude = Math.hypot(abscissa, ordinate);
  // The pair is a direction, not necessarily a unit one; a file writing (2, 0)
  // means "along +x", not "twice as far".
  if (magnitude === 0) return { cos: 1, sin: 0, degrees: 0 };

  const cos = abscissa / magnitude;
  const sin = ordinate / magnitude;
  return { cos, sin, degrees: (Math.atan2(sin, cos) * 180) / Math.PI };
}

/**
 * Model coordinates (project units) → map coordinates (metres).
 *
 * IfcMapConversion:
 *   E = Eastings  + s · (x·cos − y·sin)
 *   N = Northings + s · (x·sin + y·cos)
 *   H = OrthogonalHeight + s · z
 *
 * where `s` is `Scale` and (cos, sin) come from the X-axis direction. The
 * translation is in map units; only the model coordinates need unit conversion.
 */
export function localToMap(point: LocalPoint, placement: Placement): MapPoint {
  const { conversion, lengthUnitScale } = placement;
  const { cos, sin } = gridRotation(conversion);
  const scale = effectiveScale(conversion.scale, lengthUnitScale);

  const x = point.x * lengthUnitScale;
  const y = point.y * lengthUnitScale;
  const z = (point.z ?? 0) * lengthUnitScale;

  return {
    easting: conversion.eastings + scale * (x * cos - y * sin),
    northing: conversion.northings + scale * (x * sin + y * cos),
    height: conversion.orthogonalHeight + scale * z,
  };
}

/** The inverse of {@link localToMap}. Returns project units. */
export function mapToLocal(point: MapPoint, placement: Placement): LocalPoint {
  const { conversion, lengthUnitScale } = placement;
  const { cos, sin } = gridRotation(conversion);
  const scale = effectiveScale(conversion.scale, lengthUnitScale);

  const de = (point.easting - conversion.eastings) / scale;
  const dn = (point.northing - conversion.northings) / scale;
  const dh = ((point.height ?? 0) - conversion.orthogonalHeight) / scale;

  // Inverse rotation is the transpose, not a sign flip on one term.
  return {
    x: (de * cos + dn * sin) / lengthUnitScale,
    y: (-de * sin + dn * cos) / lengthUnitScale,
    z: dh / lengthUnitScale,
  };
}

// ---------------------------------------------------------------------------
// Map ↔ WGS84
// ---------------------------------------------------------------------------

export function mapToWgs84(point: MapPoint, epsg: number): WgsPoint {
  ensureDefinitions();
  const crs = findCrs(epsg);
  if (!crs) throw new UnknownCrsError(epsg);
  defineOnDemand(crs);

  const [longitude, latitude] = proj4(crs.name, WGS84, [
    point.easting,
    point.northing,
  ]);
  return { longitude, latitude, height: point.height };
}

export function wgs84ToMap(point: WgsPoint, epsg: number): MapPoint {
  ensureDefinitions();
  const crs = findCrs(epsg);
  if (!crs) throw new UnknownCrsError(epsg);
  defineOnDemand(crs);

  const [easting, northing] = proj4(WGS84, crs.name, [
    point.longitude,
    point.latitude,
  ]);
  return { easting, northing, height: point.height };
}

/** Metres to step along the map's northing axis when probing convergence. */
const CONVERGENCE_STEP_METRES = 10;

/**
 * Grid convergence γ at a map point: the true-north bearing (radians,
 * clockwise from true north) that the CRS's own "north" — `+northing` —
 * actually points at there.
 *
 * A projected CRS's grid is only aligned with true north along its central
 * meridian; everywhere else the two differ by γ, the *grid convergence*.
 * `gridRotationAngle` (`lib/viewer/federation.ts`) rotates a model's render
 * geometry to align its local X axis with **grid** north; the globe's
 * ENU-anchored camera (`lib/viewer/globe.ts`) assumes that render axis is
 * **true** north. Left uncorrected, the model renders rotated by γ against
 * the globe — small near a CRS's central meridian, large for oblique
 * projections — which reads as "the horizontal position is slightly off"
 * even though every coordinate transform upstream was exact.
 *
 * Computed the same way a compass bearing is measured, rather than from a
 * closed-form convergence formula that would need reproducing per
 * projection: step a short distance along `+northing` in the map frame,
 * unproject both ends to WGS84, and read the true bearing of that step. The
 * bundled CRS registry has only projected (not oblique-Mercator or
 * Krovák-style skew) definitions today, so this stays exact rather than a
 * small-angle approximation.
 */
export function gridConvergence(point: MapPoint, epsg: number): number {
  const origin = mapToWgs84(point, epsg);
  const north = mapToWgs84(
    { easting: point.easting, northing: point.northing + CONVERGENCE_STEP_METRES },
    epsg,
  );

  // Equirectangular approximation — exact enough over ten metres.
  const latRad = (origin.latitude * Math.PI) / 180;
  const east = (north.longitude - origin.longitude) * Math.cos(latRad);
  const northward = north.latitude - origin.latitude;
  return Math.atan2(east, northward);
}

// ---------------------------------------------------------------------------
// Model ↔ WGS84
// ---------------------------------------------------------------------------

export function localToWgs84(point: LocalPoint, placement: Placement): WgsPoint {
  return mapToWgs84(localToMap(point, placement), placement.epsg);
}

export function wgs84ToLocal(point: WgsPoint, placement: Placement): LocalPoint {
  return mapToLocal(wgs84ToMap(point, placement.epsg), placement);
}

/** Is this EPSG code transformable with the bundled definitions? */
export function isSupportedCrs(epsg: number | null | undefined): boolean {
  return findCrs(epsg ?? null) !== null;
}

// ---------------------------------------------------------------------------
// Building a placement from a site location
// ---------------------------------------------------------------------------

/**
 * Derive a map conversion from an `IfcSite` latitude/longitude.
 *
 * This is the "the model has LoGeoRef 20 and nothing else" path: it puts the
 * model origin at the site's coordinates with no rotation and unit scale. That
 * is a **guess about orientation**, not a measurement, so the UI must present
 * the result as a starting point for the user to refine — never as the model's
 * georeferencing.
 */
export function placementFromSite(
  site: { latitude: number; longitude: number; elevation?: number },
  epsg: number,
  lengthUnitScale: number,
): Placement {
  const map = wgs84ToMap(
    { longitude: site.longitude, latitude: site.latitude },
    epsg,
  );

  return {
    epsg,
    lengthUnitScale,
    conversion: {
      eastings: map.easting,
      northings: map.northing,
      orthogonalHeight: (site.elevation ?? 0) * lengthUnitScale,
      xAxisAbscissa: 1,
      xAxisOrdinate: 0,
      scale: 1,
    },
  };
}

/** Build the rotation pair from a grid bearing in degrees. */
export function rotationFromDegrees(degrees: number): {
  xAxisAbscissa: number;
  xAxisOrdinate: number;
} {
  const radians = (degrees * Math.PI) / 180;
  return {
    // Rounded so a whole-degree rotation does not serialise as
    // 0.9999999999999999 into the exported IFC.
    xAxisAbscissa: round(Math.cos(radians)),
    xAxisOrdinate: round(Math.sin(radians)),
  };
}

function round(value: number): number {
  const rounded = Number(value.toFixed(12));
  return rounded === 0 ? 0 : rounded;
}
