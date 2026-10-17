"use client";

/**
 * CityGML (and plain GML) as surrounding context.
 *
 * What national and municipal mapping agencies publish when they publish 3D:
 * LoD1 building blocks, LoD2 roofs, terrain, city furniture. Unlike GeoJSON it
 * is already three-dimensional and already in a projected CRS, so the work here
 * is reading it rather than inventing height.
 *
 * Parsed in the tab with `DOMParser`, like the BCF and IDS readers, and never
 * uploaded.
 *
 * ## The parts of the format that matter
 *
 * - **Namespaces vary and versions differ.** CityGML 1.0, 2.0 and 3.0 use
 *   different namespace URIs, and the GML core moved too. Matching on the
 *   *local* name rather than the namespace is what makes one reader work across
 *   all of them; matching on a namespace makes a reader that fails on half the
 *   files in the wild for no useful reason.
 * - **Geometry lives in `gml:posList` and `gml:pos`**, on a `gml:LinearRing`
 *   inside a `gml:Polygon`. A `posList` is a flat run of numbers whose tuple
 *   size is `srsDimension` — 3 normally, 2 for a flat footprint.
 * - **Coordinates are already projected**, and `srsName` says into what. It is
 *   usually on the root envelope rather than on each geometry.
 * - **A polygon's `exterior` is the shape; `interior` rings are holes.** They
 *   are triangulated together on the surface's plane, including vertical walls.
 */

import { mapToWgs84, wgs84ToMap } from "./transform";
import {
  GeometryBuilder,
  type ContextGeometry,
  type ContextFeature,
} from "./context-geometry";

import { gmlFeatureElement, readGmlFeature } from "./gml-metadata";
import { polygonTriangles } from "./polygon-triangulation";
import { contextTriangles } from "./vector-context";

export class CityGmlError extends Error {}

type Point = [number, number, number];

/**
 * Muted, by what CityGML calls the object.
 *
 * Keyed on the local element name, so `bldg:Building` and `Building` are the
 * same thing whatever prefix a file happens to use.
 */
const COLOURS: Record<string, [number, number, number]> = {
  Building: [0.62, 0.64, 0.68],
  BuildingPart: [0.62, 0.64, 0.68],
  Road: [0.42, 0.42, 0.45],
  TrafficArea: [0.42, 0.42, 0.45],
  WaterBody: [0.35, 0.48, 0.62],
  PlantCover: [0.44, 0.56, 0.42],
  SolitaryVegetationObject: [0.44, 0.56, 0.42],
  ReliefFeature: [0.45, 0.52, 0.42],
  TINRelief: [0.45, 0.52, 0.42],
  LandUse: [0.5, 0.5, 0.46],
  Bridge: [0.58, 0.55, 0.5],
  CityFurniture: [0.55, 0.55, 0.58],
};
const DEFAULT_COLOUR: [number, number, number] = [0.55, 0.56, 0.6];

/** `urn:ogc:def:crs:EPSG::3763`, `EPSG:3763`, `…/epsg/0/3763` → 3763. */
export function epsgFromSrsName(srsName: string | null | undefined): number | null {
  if (!srsName) return null;
  const match = /EPSG.*?(\d{4,6})\s*$/i.exec(srsName.trim());
  return match ? Number(match[1]) : null;
}

/** Elements by local name, whatever namespace or prefix they carry. */
function byLocalName(root: ParentNode, name: string): Element[] {
  return [...root.querySelectorAll("*")].filter(
    (element) => element.localName === name,
  );
}

function localChild(element: Element, name: string): Element | null {
  for (const child of element.children) {
    if (child.localName === name) return child;
  }
  return null;
}

function coordinateDimension(element: Element, fallback: number): number {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const dimension = Number(node.getAttribute("srsDimension"));
    if (dimension === 2 || dimension === 3) return dimension;
  }
  return fallback;
}

/**
 * The coordinates of one ring.
 *
 * Handles both spellings: a single `posList` of run-together numbers, and a
 * sequence of `pos` elements holding one point each. Older exporters use the
 * second, newer ones the first, and files in the wild use both in one document.
 */
function ringPoints(ring: Element, defaultDimension: number): Point[] {
  const points: Point[] = [];

  const posList = byLocalName(ring, "posList")[0];
  if (posList) {
    const dimension = coordinateDimension(posList, defaultDimension);
    const numbers = (posList.textContent ?? "")
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((value) => Number.isFinite(value));

    for (let i = 0; i + dimension - 1 < numbers.length; i += dimension) {
      points.push([
        numbers[i],
        numbers[i + 1],
        dimension >= 3 ? numbers[i + 2] : 0,
      ]);
    }
    return points;
  }

  for (const pos of byLocalName(ring, "pos")) {
    const numbers = (pos.textContent ?? "")
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((value) => Number.isFinite(value));
    if (numbers.length >= 2) {
      points.push([numbers[0], numbers[1], numbers[2] ?? 0]);
    }
  }
  if (points.length > 0) return points;

  /*
    GML 2 and a large amount of cadastral data still use `coordinates`:

      <gml:coordinates cs="," ts=" ">100,200,3 110,200,3 …</gml:coordinates>

    `cs` separates ordinates and `ts` separates coordinate tuples. They are
    attributes rather than fixed punctuation, although comma/whitespace is by
    far the most common spelling.
  */
  const coordinates = byLocalName(ring, "coordinates")[0];
  if (coordinates) {
    const coordinateSeparator = coordinates.getAttribute("cs") ?? ",";
    const tupleSeparator = coordinates.getAttribute("ts") ?? " ";
    const decimal = coordinates.getAttribute("decimal") ?? ".";
    const content = (coordinates.textContent ?? "").trim();
    const tuples = tupleSeparator.trim()
      ? content.split(tupleSeparator)
      : content.split(/\s+/);

    for (const tuple of tuples) {
      const values = tuple
        .trim()
        .split(coordinateSeparator)
        .map((value) => Number(decimal === "." ? value : value.replace(decimal, ".")));
      if (values.length >= 2 && values.every(Number.isFinite)) {
        points.push([values[0], values[1], values[2] ?? 0]);
      }
    }
    if (points.length > 0) return points;
  }

  // The other legacy GML 2 spelling is one `coord` element per point with
  // child X/Y/Z values. It remains common in land-registry exports.
  for (const coordinate of byLocalName(ring, "coord")) {
    const x = Number(localChild(coordinate, "X")?.textContent);
    const y = Number(localChild(coordinate, "Y")?.textContent);
    const zText = localChild(coordinate, "Z")?.textContent;
    const z = zText === null || zText === undefined ? 0 : Number(zText);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      points.push([x, y, z]);
    }
  }
  return points;
}

export function parseCityGml(
  text: string,
  targetEpsg: number | null = null,
  options: { sourceCrs?: string; geographicAxis?: "xy" | "yx" } = {},
): ContextGeometry {
  const document_ = new DOMParser().parseFromString(text, "application/xml");
  if (document_.querySelector("parsererror")) {
    throw new CityGmlError("That file is not well-formed XML.");
  }

  const root = document_.documentElement;
  if (!root) throw new CityGmlError("That file has no XML content.");

  // `srsName` is normally on the root envelope rather than on each geometry.
  const srsName =
    root.getAttribute("srsName") ??
    byLocalName(root, "Envelope")[0]?.getAttribute("srsName") ??
    [...root.querySelectorAll("*")]
      .map((element) => element.getAttribute("srsName"))
      .find(Boolean) ??
    options.sourceCrs ?? null;

  const sourceEpsg = /CRS:?84$/i.test(srsName ?? "") ? 4326 : epsgFromSrsName(srsName);
  if (sourceEpsg === null) {
    throw new CityGmlError(
      "This file does not say which coordinate system it is in (no srsName), so its coordinates cannot be placed.",
    );
  }
  const outputEpsg = targetEpsg ?? sourceEpsg;

  const wfs = root.localName === "FeatureCollection";
  const swap = sourceEpsg === 4326 && (options.geographicAxis === "yx" || (!options.geographicAxis && wfs && /urn:|\/def\/crs\//i.test(srsName ?? "") && !/CRS:?84$/i.test(srsName ?? "")));
  const defaultDimension =
    Number(
      root.getAttribute("srsDimension") ??
        byLocalName(root, "Envelope")[0]?.getAttribute("srsDimension"),
    ) || (wfs ? 2 : 3);

  const polygons = [
    ...byLocalName(root, "Polygon"),
    ...byLocalName(root, "PolygonPatch"),
    ...byLocalName(root, "Triangle"),
    ...["Point", "LineString", "LineStringSegment"].flatMap((name) => byLocalName(root, name)).filter((node) => {
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (/^(Polygon|PolygonPatch|Triangle|LinearRing|Envelope)$/.test(parent.localName)) return false;
      }
      return true;
    }),
  ];
  if (polygons.length === 0) {
    throw new CityGmlError(
      "This file has no gml:Polygon geometry — it may hold only metadata, or geometry in a form this reader does not cover.",
    );
  }

  /*
    Reproject only when the file disagrees with the model.

    Going through WGS84 is a round trip and costs precision, so it is skipped
    entirely in the common case where a municipality publishes in the same
    national grid the model is placed in.
  */
  const reproject =
    sourceEpsg === outputEpsg && !swap
      ? null
      : (point: Point): Point => {
          const wgs = mapToWgs84(
            { easting: point[swap ? 1 : 0], northing: point[swap ? 0 : 1], height: point[2] },
            sourceEpsg,
          );
          const map = wgs84ToMap(wgs, outputEpsg);
          return [map.easting, map.northing, point[2]];
        };

  type Ready = { name: string; feature: ContextFeature; rings: Point[][]; kind: "polygon" | "line" | "point" };
  const metadata = new Map<Element, ContextFeature>();
  const ready: Ready[] = [];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const polygon of polygons) {
    const kind = polygon.localName === "Point" ? "point" : /LineString/.test(polygon.localName) ? "line" : "polygon";
    const exterior = localChild(polygon, "exterior") ?? localChild(polygon, "outerBoundaryIs");
    const ringElement = kind !== "polygon" ? polygon : exterior
      ? byLocalName(exterior, "LinearRing")[0]
      : byLocalName(polygon, "LinearRing")[0];
    if (!ringElement) continue;

    const interiors = [...polygon.children]
      .filter((child) => child.localName === "interior" || child.localName === "innerBoundaryIs")
      .flatMap((child) => byLocalName(child, "LinearRing"));
    const rings = [ringElement, ...interiors].map((ring) => {
      const points = ringPoints(ring, defaultDimension);
      return reproject ? points.map(reproject) : points;
    });
    const points = rings[0];
    if (points.length < (kind === "point" ? 1 : kind === "line" ? 2 : 3)) continue;

    for (const [x, y, z] of points) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }

    const owner = gmlFeatureElement(polygon);
    let feature = metadata.get(owner);
    if (!feature) { feature = readGmlFeature(owner, String(metadata.size + 1)); metadata.set(owner, feature); }
    if (wfs) feature.source = "WFS / GML";
    ready.push({ name: feature.type, feature, rings, kind });
  }

  if (ready.length === 0) {
    throw new CityGmlError(
      "No polygon in this file had enough coordinates to draw.",
    );
  }

  const origin = {
    easting: (minX + maxX) / 2,
    northing: (minY + maxY) / 2,
    height: Number.isFinite(minZ) ? minZ : 0,
  };

  const builder = new GeometryBuilder();
  const counts = new Map<string, number>();

  for (const entry of ready) {
    const firstTriangle = builder.triangleCount;
    const colour = COLOURS[entry.name] ?? DEFAULT_COLOUR;
    const triangles = entry.kind === "polygon" ? polygonTriangles(entry.rings) : contextTriangles({
      polygons: [], lines: entry.kind === "line" ? entry.rings : [], points: entry.kind === "point" ? entry.rings[0] : [],
    }, (point) => point);
    for (const [a, b, c] of triangles) {
      builder.triangle(a, b, c, colour, origin);
    }
    builder.addFeature(entry.feature, firstTriangle);
    counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  }

  return {
    ...builder.finish(),
    origin,
    epsg: outputEpsg,
    // Surfaces, not buildings: a CityGML building is many polygons, and
    // counting them as objects would overstate what was read.
    objectCount: ready.length,
    types: [...counts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    sizeMetres: Math.max(maxX - minX, maxY - minY),
  };
}
