/**
 * Grading a model against the LoGeoRef levels.
 *
 * LoGeoRef ("Level of Georeferencing", Clemen & Görne) is the usual shorthand
 * for *how well* an IFC file says where it is. The levels are cumulative in
 * intent but not strictly nested in practice — a file can carry an
 * `IfcMapConversion` (50) and no `IfcSite` latitude (20) — so this grades each
 * level independently and reports the **highest level fully satisfied**, plus
 * everything that is present but incomplete.
 *
 * | Level | What it means |
 * |---|---|
 * | 0  | Nothing at all |
 * | 20 | `IfcSite` latitude/longitude — a postal-accuracy position |
 * | 30 | `IfcSite.ObjectPlacement` offset — the model is placed relative to the site |
 * | 40 | `IfcGeometricRepresentationContext.TrueNorth` — orientation is known |
 * | 50 | `IfcMapConversion` + `IfcProjectedCRS` — a full, unambiguous CRS mapping |
 *
 * Only 50 lets a coordinator federate two models from different authors and
 * trust the result, which is why `/viewer` treats anything less as
 * "approximate" or "unaligned".
 *
 * Pure and engine-free: it takes the adapter's `GeoreferenceView` and returns a
 * report. That keeps the rules testable against hand-written cases rather than
 * only against whatever fixtures happen to exist.
 */

import { resolveCrsByName } from "@/config/epsg";
import { isSupportedCrs, mapToWgs84 } from "./transform";
import type { GeoreferenceView, MapConversionView } from "@/lib/ifc/types";

export const LOGEOREF_LEVELS = [0, 20, 30, 40, 50] as const;
export type LoGeoRefLevel = (typeof LOGEOREF_LEVELS)[number];

export type CheckStatus = "pass" | "fail" | "warn";

export type GeorefCheck = {
  id: string;
  /** The level this check contributes to. */
  level: LoGeoRefLevel;
  label: string;
  status: CheckStatus;
  /** What was found, in the user's terms. */
  detail: string;
  /** What to do about it, when it is not a pass. */
  remedy?: string;
  /**
   * Which situation this is, and the numbers in it, so the page can word it in
   * the user's language (`viewer.georefPanel.reportPanel.checks.<key>`).
   * `detail` and `remedy` stay as the English sentences — what tests and logs
   * read, and what the page falls back to for a situation without a key.
   */
  key?: string;
  params?: Record<string, string | number>;
};

export type GeorefReport = {
  /** Highest level whose checks all pass. */
  level: LoGeoRefLevel;
  checks: GeorefCheck[];
  /** True when the model can be federated and mapped without guessing. */
  isMappable: boolean;
  /** Levels that have some evidence but did not fully pass. */
  partial: LoGeoRefLevel[];
};

/** Latitude/longitude that are exactly zero are almost always a placeholder. */
const NULL_ISLAND_TOLERANCE = 1e-9;

export function gradeGeoreferencing(view: GeoreferenceView): GeorefReport {
  const checks: GeorefCheck[] = [
    ...checkSiteLocation(view),
    ...checkSitePlacement(view),
    ...checkTrueNorth(view),
    ...checkMapConversion(view),
  ];

  const byLevel = new Map<LoGeoRefLevel, GeorefCheck[]>();
  for (const check of checks) {
    byLevel.set(check.level, [...(byLevel.get(check.level) ?? []), check]);
  }

  const satisfied = (level: LoGeoRefLevel) => {
    const group = byLevel.get(level);
    // A level with no checks is not satisfied — absence of evidence is not
    // evidence of georeferencing.
    return group !== undefined && group.length > 0 && group.every((c) => c.status === "pass");
  };

  let level: LoGeoRefLevel = 0;
  for (const candidate of [20, 30, 40, 50] as const) {
    if (satisfied(candidate)) level = candidate;
  }

  const partial = ([20, 30, 40, 50] as const).filter(
    (candidate) =>
      !satisfied(candidate) &&
      (byLevel.get(candidate) ?? []).some((c) => c.status !== "fail"),
  );

  return {
    level,
    checks,
    // Mapping needs a projected CRS and a map conversion; nothing below 50 is
    // enough to place a footprint on a basemap without the user supplying a CRS.
    isMappable: satisfied(50),
    partial: [...partial],
  };
}

// ---------------------------------------------------------------------------
// Level 20 — IfcSite latitude / longitude
// ---------------------------------------------------------------------------

function checkSiteLocation(view: GeoreferenceView): GeorefCheck[] {
  const site = view.site;
  const hasLatLon =
    site?.latitude !== undefined && site?.longitude !== undefined;

  if (!hasLatLon) {
    return [
      {
        id: "site-latlong",
        level: 20,
        label: "IfcSite RefLatitude / RefLongitude",
        status: "fail",
        key: "siteLatLongMissing",
        detail: "The site declares no latitude or longitude.",
        remedy:
          "Set the site's reference latitude and longitude, or georeference the model fully with an IfcMapConversion.",
      },
    ];
  }

  const { latitude, longitude } = site!;
  const atNullIsland =
    Math.abs(latitude!) < NULL_ISLAND_TOLERANCE &&
    Math.abs(longitude!) < NULL_ISLAND_TOLERANCE;

  if (atNullIsland) {
    return [
      {
        id: "site-latlong",
        level: 20,
        label: "IfcSite RefLatitude / RefLongitude",
        status: "warn",
        key: "siteLatLongZero",
        // 0°N 0°E is in the Gulf of Guinea. It is a default, not a location.
        detail: "Latitude and longitude are both exactly 0°, which is a placeholder rather than a location.",
        remedy: "Set the real site coordinates.",
      },
    ];
  }

  if (
    Math.abs(latitude!) > 90 ||
    Math.abs(longitude!) > 180
  ) {
    return [
      {
        id: "site-latlong",
        level: 20,
        label: "IfcSite RefLatitude / RefLongitude",
        status: "fail",
        key: "siteLatLongRange",
        params: { latitude: latitude!.toFixed(4), longitude: longitude!.toFixed(4) },
        detail: `Coordinates are out of range (${latitude!.toFixed(4)}°, ${longitude!.toFixed(4)}°).`,
        remedy: "Check that the compound-degree values are correct.",
      },
    ];
  }

  return [
    {
      id: "site-latlong",
      level: 20,
      label: "IfcSite RefLatitude / RefLongitude",
      status: "pass",
      detail: `${formatLatitude(latitude!)}, ${formatLongitude(longitude!)}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Level 30 — site placement / world coordinate system
// ---------------------------------------------------------------------------

function checkSitePlacement(view: GeoreferenceView): GeorefCheck[] {
  const wcs = view.context?.worldCoordinateSystem;
  const elevation = view.site?.elevation;

  const checks: GeorefCheck[] = [];

  checks.push(
    elevation === undefined
      ? {
          id: "site-elevation",
          level: 30,
          label: "IfcSite RefElevation",
          status: "warn",
          key: "elevationMissing",
          detail: "No reference elevation, so heights are relative to the model origin only.",
          remedy: "Set the site's reference elevation above the vertical datum.",
        }
      : {
          id: "site-elevation",
          level: 30,
          label: "IfcSite RefElevation",
          status: "pass",
          key: "elevationValue",
          params: { value: elevation.toFixed(3) },
          detail: `${elevation.toFixed(3)} (project units)`,
        },
  );

  checks.push(
    wcs === undefined
      ? {
          id: "world-coordinate-system",
          level: 30,
          label: "WorldCoordinateSystem",
          status: "warn",
          key: "worldCoordinateSystemMissing",
          detail: "The Model context declares no world coordinate system.",
          remedy: "Not required, but an explicit identity placement documents the intent.",
        }
      : {
          id: "world-coordinate-system",
          level: 30,
          label: "WorldCoordinateSystem",
          status: "pass",
          key: wcs[0] === 0 && wcs[1] === 0 && wcs[2] === 0 ? "worldCoordinateSystemIdentity" : "worldCoordinateSystemOffset",
          params: { offset: wcs.map((v) => v.toFixed(3)).join(", ") },
          detail:
            wcs[0] === 0 && wcs[1] === 0 && wcs[2] === 0
              ? "Identity — the model origin is the context origin."
              : `Offset by (${wcs.map((v) => v.toFixed(3)).join(", ")}).`,
        },
  );

  return checks;
}

// ---------------------------------------------------------------------------
// Level 40 — true north
// ---------------------------------------------------------------------------

function checkTrueNorth(view: GeoreferenceView): GeorefCheck[] {
  const context = view.context;

  if (!context?.trueNorth) {
    return [
      {
        id: "true-north",
        level: 40,
        label: "TrueNorth",
        status: "fail",
        key: "trueNorthMissing",
        detail: "The Model context declares no true north, so the model's orientation is unknown.",
        remedy:
          "Set TrueNorth on the Model representation context, or supply an IfcMapConversion, whose grid rotation supersedes it.",
      },
    ];
  }

  const [x, y] = context.trueNorth;
  if (x === 0 && y === 0) {
    return [
      {
        id: "true-north",
        level: 40,
        label: "TrueNorth",
        status: "fail",
        key: "trueNorthZero",
        detail: "TrueNorth is a zero-length direction, which carries no orientation.",
        remedy: "Set a non-zero direction, e.g. (0, 1) when project north is true north.",
      },
    ];
  }

  return [
    {
      id: "true-north",
      level: 40,
      label: "TrueNorth",
      status: "pass",
      key: context.trueNorthDegrees === undefined ? "trueNorthDirection" : "trueNorthDegrees",
      params: { x, y, degrees: context.trueNorthDegrees?.toFixed(3) ?? "" },
      detail:
        context.trueNorthDegrees === undefined
          ? `Direction (${x}, ${y}).`
          : `${context.trueNorthDegrees.toFixed(3)}° from project north.`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Level 50 — map conversion + projected CRS
// ---------------------------------------------------------------------------

/**
 * A `MapConversion` whose Eastings and Northings are both exactly 0.
 *
 * No real projected CRS has its false origin under an actual building, so
 * this is the on-disk signature of a tool that wrote the entity without the
 * user ever setting a real project location — Revit does this by default
 * when its "Survey Point" hasn't been configured, even though
 * `IfcProjectedCRS` is fully populated alongside it. Taking the zeros
 * literally lands the model near the CRS's false origin, which can be
 * hundreds of kilometres from the real site: exactly the kind of wrong that
 * looks like a working georeference (both entities present, level 50's
 * other checks pass) rather than a missing one.
 */
export function isTrivialMapConversion(conversion: MapConversionView): boolean {
  return conversion.eastings === 0 && conversion.northings === 0;
}

function checkMapConversion(view: GeoreferenceView): GeorefCheck[] {
  const checks: GeorefCheck[] = [];
  const conversion = view.mapConversion;
  const crs = view.projectedCRS;

  if (!conversion) {
    checks.push({
      id: "map-conversion",
      level: 50,
      label: "IfcMapConversion",
      status: "fail",
      key: "mapConversionMissing",
      detail: "No map conversion, so the model cannot be placed in a projected CRS.",
      remedy: "Add an IfcMapConversion with the eastings, northings and height of the model origin.",
    });
  } else {
    const { eastings, northings, orthogonalHeight, scale } = conversion;
    const atOrigin = isTrivialMapConversion(conversion);

    checks.push({
      id: "map-conversion",
      level: 50,
      label: "IfcMapConversion",
      status: atOrigin ? "warn" : "pass",
      key: atOrigin ? "mapConversionPlaceholder" : undefined,
      detail: atOrigin
        ? "Eastings and northings are both 0, which is a placeholder in every real projected CRS."
        : `E ${eastings.toFixed(3)}, N ${northings.toFixed(3)}, H ${orthogonalHeight.toFixed(3)}`,
      remedy: atOrigin ? "Set the real map coordinates of the model origin." : undefined,
    });

    if (scale !== undefined && scale !== 1) {
      checks.push({
        id: "map-conversion-scale",
        level: 50,
        label: "IfcMapConversion Scale",
        // A scale other than 1 is legal but almost always a unit mistake rather
        // than a deliberate grid scale factor.
        status: "warn",
        key: "mapConversionScale",
        params: { scale },
        detail: `Scale is ${scale}, not 1.`,
        remedy:
          "Confirm this is a deliberate grid scale factor and not a unit conversion that belongs in the project units.",
      });
    }
  }

  if (!crs) {
    checks.push({
      id: "projected-crs",
      level: 50,
      label: "IfcProjectedCRS",
      status: "fail",
      key: "projectedCrsMissing",
      detail: "No projected CRS, so the map coordinates have no stated meaning.",
      remedy: "Add an IfcProjectedCRS naming the EPSG code, e.g. EPSG:3763.",
    });
  } else {
    const epsg = resolveEpsgCode(crs.name);
    checks.push({
      id: "projected-crs",
      level: 50,
      label: "IfcProjectedCRS",
      status: epsg === null ? "warn" : "pass",
      key: epsg === null ? "projectedCrsUnrecognised" : undefined,
      params: { name: crs.name ?? "" },
      detail:
        epsg === null
          ? `Name is "${crs.name}", which is not a recognisable EPSG code or a known CRS name.`
          : `EPSG:${epsg}${crs.description ? ` — ${crs.description}` : ""}`,
      remedy:
        epsg === null
          ? "Name the CRS as an EPSG code so any tool can resolve it unambiguously."
          : undefined,
    });
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A disagreement smaller than this is ordinary: the site point is not the IFC origin. */
export const SITE_DISAGREEMENT_METRES = 50;

export type SiteDisagreement = {
  /** Ground distance between the two positions. */
  metres: number;
  /** Compass bearing from the `IfcMapConversion` position to the `IfcSite` one, 0–360° clockwise from north. */
  bearingDegrees: number;
};

/**
 * Do `IfcSite` latitude/longitude and `IfcMapConversion` put the model in the
 * same place?
 *
 * A file can carry both and have them disagree — nothing in IFC forces them
 * to agree — and then each tool shows the building where it reads it: one at
 * the map conversion, another at the site's coordinates. Returns null when
 * either is missing, the CRS cannot be projected, or they agree within
 * `SITE_DISAGREEMENT_METRES`. Measured from the IFC origin, which is where
 * the map conversion anchors; a site point offset a few tens of metres from it
 * is normal, hence the margin.
 */
export function siteDisagreement(view: GeoreferenceView): SiteDisagreement | null {
  const conversion = view.mapConversion;
  const site = view.site;
  const epsg = resolveEpsgCode(view.projectedCRS?.name);
  if (
    !conversion ||
    !epsg ||
    !isSupportedCrs(epsg) ||
    site?.latitude === undefined ||
    site?.longitude === undefined
  ) {
    return null;
  }

  let origin;
  try {
    origin = mapToWgs84({ easting: conversion.eastings, northing: conversion.northings }, epsg);
  } catch {
    return null;
  }

  const rad = Math.PI / 180;
  const dLat = (site.latitude - origin.latitude) * rad;
  const dLon = (site.longitude - origin.longitude) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(origin.latitude * rad) * Math.cos(site.latitude * rad) * Math.sin(dLon / 2) ** 2;
  const metres = 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
  if (metres <= SITE_DISAGREEMENT_METRES) return null;

  const y = Math.sin(dLon) * Math.cos(site.latitude * rad);
  const x =
    Math.cos(origin.latitude * rad) * Math.sin(site.latitude * rad) -
    Math.sin(origin.latitude * rad) * Math.cos(site.latitude * rad) * Math.cos(dLon);
  const bearingDegrees = (Math.atan2(y, x) / rad + 360) % 360;

  return { metres, bearingDegrees };
}

/**
 * Pull an EPSG code out of `IfcProjectedCRS.Name`.
 *
 * The field is free text and authors write it every way imaginable:
 * `EPSG:3763`, `urn:ogc:def:crs:EPSG::3763`, `3763`, `EPSG 3763`. Anything that
 * does not yield a code is reported rather than guessed at.
 */
export function parseEpsgCode(name: string | undefined): number | null {
  if (!name) return null;

  const match = /(?:^|[^0-9])(\d{4,6})\s*$/.exec(name.trim());
  if (match) return Number(match[1]);

  const urn = /EPSG:*:?(\d{4,6})/i.exec(name);
  return urn ? Number(urn[1]) : null;
}

/**
 * `parseEpsgCode`, then — only if that finds no number — a match against the
 * registry's own names, labels and aliases (`resolveCrsByName`). A name like
 * `ETRS89 / Portugal TM06` (the exact label IFC authoring tools write,
 * carrying no digits at all) resolves through this path; `parseEpsgCode`
 * alone deliberately returns null for it rather than guess.
 *
 * This is what both the LoGeoRef report and the globe's placement use, so
 * they can never resolve the same `IfcProjectedCRS.Name` two different ways.
 */
export function resolveEpsgCode(name: string | undefined): number | null {
  return parseEpsgCode(name) ?? resolveCrsByName(name);
}

export function formatLatitude(degrees: number): string {
  return `${formatDms(Math.abs(degrees))} ${degrees >= 0 ? "N" : "S"}`;
}

export function formatLongitude(degrees: number): string {
  return `${formatDms(Math.abs(degrees))} ${degrees >= 0 ? "E" : "W"}`;
}

function formatDms(absolute: number): string {
  const d = Math.floor(absolute);
  const minutesFloat = (absolute - d) * 60;
  const m = Math.floor(minutesFloat);
  const s = (minutesFloat - m) * 60;
  return `${d}° ${String(m).padStart(2, "0")}′ ${s.toFixed(2).padStart(5, "0")}″`;
}

/** One-line summary for the level, for badges and headings. */
export function describeLevel(level: LoGeoRefLevel): string {
  switch (level) {
    case 50:
      return "Fully georeferenced — map conversion and projected CRS";
    case 40:
      return "Oriented — true north is known, but there is no map conversion";
    case 30:
      return "Placed — site elevation and placement, but no orientation";
    case 20:
      return "Located — approximate latitude and longitude only";
    default:
      return "Not georeferenced";
  }
}
