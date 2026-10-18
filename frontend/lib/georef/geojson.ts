"use client";

/**
 * GeoJSON as surrounding context.
 *
 * The format most municipalities actually publish: plot boundaries, building
 * footprints, road centrelines, tree positions. Unlike CityJSON it is flat —
 * so the useful thing this does is **extrude** footprints that carry a height,
 * turning a cadastral layer into the massing around the model.
 *
 * Read in the tab like every other file here, and never uploaded.
 *
 * ## The parts of the format that matter
 *
 * - **Coordinates are longitude, latitude — in that order.** RFC 7946 §3.1.1.
 *   Reversing them is the classic GeoJSON bug and it is silent: the geometry
 *   renders, in the sea off Somalia.
 * - **CRS84 always.** RFC 7946 removed the `crs` member; coordinates are WGS84
 *   longitude/latitude. Files predating that sometimes carry a `crs` claiming
 *   otherwise, which this refuses rather than silently misplacing by hundreds
 *   of metres.
 * - **A polygon's first ring is the exterior**, the rest are holes. Holes are
 *   triangulated together, preserving courtyard holes.
 */

import { wgs84ToMap, type WgsPoint } from "./transform";
import {
  openRing,
  GeometryBuilder,
  contextFeatureName,
  type ContextFeature,
  type ContextGeometry,
} from "./context-geometry";
import { polygonTriangles } from "./polygon-triangulation";

export class GeoJsonError extends Error {}

type Position = [number, number, number?];

type Geometry = {
  type?: string;
  coordinates?: unknown;
  geometries?: Geometry[];
};

type Feature = {
  id?: string | number;
  type?: string;
  geometry?: Geometry | null;
  properties?: Record<string, unknown> | null;
};

type Document = {
  type?: string;
  features?: Feature[];
  geometry?: Geometry | null;
  properties?: Record<string, unknown> | null;
  coordinates?: unknown;
  geometries?: Geometry[];
  crs?: { properties?: { name?: string } };
};

/** Muted, so context never competes with the model being checked. */
const COLOURS: Record<string, [number, number, number]> = {
  building: [0.62, 0.64, 0.68],
  road: [0.42, 0.42, 0.45],
  water: [0.35, 0.48, 0.62],
  vegetation: [0.44, 0.56, 0.42],
  parcel: [0.5, 0.5, 0.46],
};
const DEFAULT_COLOUR: [number, number, number] = [0.55, 0.56, 0.6];

/** How wide a line is drawn, in metres. Roads and boundaries have no width. */
const LINE_WIDTH = 1.5;
/** How large a point marker is drawn, in metres. */
const POINT_SIZE = 1.5;

/**
 * Height to extrude a footprint by, from whatever the publisher called it.
 *
 * There is no standard property, so the common ones are tried in order of how
 * unambiguous they are. `building:levels` is last and multiplied by a storey
 * height, because it is a count rather than a measurement — an approximation,
 * and flagged as one in the returned type list.
 */
function heightOf(properties: Record<string, unknown> | null | undefined): number {
  if (!properties) return 0;

  for (const key of ["height", "Height", "HEIGHT", "altura", "hoehe"]) {
    const value = Number(properties[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }

  for (const key of ["building:levels", "levels", "pisos", "num_floors"]) {
    const value = Number(properties[key]);
    // 3 m per storey: the figure used for massing when nothing better exists.
    if (Number.isFinite(value) && value > 0) return value * 3;
  }

  return 0;
}

/** A coarse kind, from whatever the publisher tagged it with. */
function kindOf(properties: Record<string, unknown> | null | undefined): string {
  if (!properties) return "feature";

  const text = Object.entries(properties)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ")
    .toLowerCase();

  if (/building|edific|predio|casa/.test(text)) return "building";
  if (/highway|road|street|rua|estrada|via/.test(text)) return "road";
  if (/water|river|lake|rio|agua/.test(text)) return "water";
  if (/park|tree|forest|garden|verde|arvore/.test(text)) return "vegetation";
  if (/parcel|cadastr|lot|parcela|terreno/.test(text)) return "parcel";
  return "feature";
}

function isPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  );
}

/**
 * Read a GeoJSON file into context geometry.
 *
 * `epsg` is the projected CRS to work in — the model's own, so the result lands
 * in the same frame as everything else. GeoJSON is always WGS84, so this
 * projects rather than assumes.
 */
export function parseGeoJson(text: string, epsg: number): ContextGeometry {
  let data: Document;
  try {
    data = JSON.parse(text) as Document;
  } catch {
    throw new GeoJsonError("That file is not valid JSON.");
  }

  const named = data.crs?.properties?.name;
  if (named && !/CRS84|4326/i.test(named)) {
    // Better to refuse than to place someone's city hundreds of metres out.
    throw new GeoJsonError(
      `This file declares the coordinate system “${named}”. GeoJSON coordinates must be WGS84 longitude/latitude (RFC 7946), and this reader will not guess a reprojection.`,
    );
  }

  const features = collectFeatures(data);
  if (features.length === 0) {
    throw new GeoJsonError("This GeoJSON file has no features.");
  }

  /*
    Two passes.

    The first projects every coordinate and finds the extent, because the local
    origin has to be known before any vertex can be written relative to it —
    and projected coordinates are millions of metres, which float32 cannot hold
    without the geometry visibly jittering.
  */
  type Ready = {
    feature: ContextFeature;
    kind: string;
    height: number;
    geometry: Geometry;
    projected: Map<Position, [number, number]>;
  };

  const ready: Ready[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  const project = (position: Position, into: Map<Position, [number, number]>) => {
    const point: WgsPoint = { longitude: position[0], latitude: position[1] };
    const { easting, northing } = wgs84ToMap(point, epsg);
    into.set(position, [easting, northing]);
    if (easting < minX) minX = easting;
    if (easting > maxX) maxX = easting;
    if (northing < minY) minY = northing;
    if (northing > maxY) maxY = northing;
  };

  for (const [index, feature] of features.entries()) {
    if (!feature.geometry) continue;
    const projected = new Map<Position, [number, number]>();
    for (const position of positionsOf(feature.geometry)) project(position, projected);
    if (projected.size === 0) continue;

    const properties = feature.properties ?? {};
    ready.push({
      feature: { id: String(feature.id ?? index + 1), name: contextFeatureName(properties),
        type: feature.geometry.type ?? "Feature", source: "GeoJSON", properties },
      kind: kindOf(feature.properties),
      height: heightOf(feature.properties),
      geometry: feature.geometry,
      projected,
    });
  }

  if (ready.length === 0) {
    throw new GeoJsonError(
      "This GeoJSON file has no geometry that could be drawn — its features may all be null-geometry records.",
    );
  }

  const origin = {
    easting: (minX + maxX) / 2,
    northing: (minY + maxY) / 2,
    // Flat data sits on the model's own ground; the panel places it there.
    height: 0,
  };

  const builder = new GeometryBuilder();
  const counts = new Map<string, number>();
  let objectCount = 0;

  for (const entry of ready) {
    const colour = COLOURS[entry.kind] ?? DEFAULT_COLOUR;
    const before = builder.triangleCount;

    build(entry.geometry, entry.projected, entry.height, colour, builder, origin, entry.feature);
    if (builder.triangleCount > before) {
      objectCount += 1;
      counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
    }
  }

  if (builder.triangleCount === 0) {
    throw new GeoJsonError(
      "Nothing in this GeoJSON file could be drawn — it may contain only unsupported geometry types.",
    );
  }

  return {
    ...builder.finish(),
    origin,
    epsg,
    objectCount,
    types: [...counts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    sizeMetres: Math.max(maxX - minX, maxY - minY),
  };
}

/** Flatten a document to its features, whatever shape it came in. */
function collectFeatures(data: Document): Feature[] {
  if (data.type === "FeatureCollection") return data.features ?? [];
  if (data.type === "Feature") return [data as Feature];
  // A bare geometry is legal GeoJSON too.
  if (data.type) return [{ type: "Feature", geometry: data as Geometry, properties: null }];
  return [];
}

/** Every coordinate in a geometry, whatever its nesting depth. */
function* positionsOf(geometry: Geometry): Generator<Position> {
  if (geometry.type === "GeometryCollection") {
    for (const child of geometry.geometries ?? []) yield* positionsOf(child);
    return;
  }
  yield* walk(geometry.coordinates);
}

function* walk(node: unknown): Generator<Position> {
  if (isPosition(node)) {
    yield node;
    return;
  }
  if (Array.isArray(node)) for (const child of node) yield* walk(child);
}

function build(
  geometry: Geometry,
  projected: Map<Position, [number, number]>,
  height: number,
  colour: readonly [number, number, number],
  builder: GeometryBuilder,
  origin: { easting: number; northing: number; height: number },
  feature: ContextFeature,
) {
  if (geometry.type === "GeometryCollection") {
    for (const child of geometry.geometries ?? []) build(child, projected, height, colour, builder, origin, feature);
    return;
  }
  const firstTriangle = builder.triangleCount;
  const at = (position: Position, z: number): [number, number, number] => {
    const point = projected.get(position)!;
    return [point[0], point[1], (position[2] ?? 0) + z];
  };

  const polygon = (rings: Position[][]) => {
    const ring = rings[0];
    if (!ring || ring.length < 3) return;

    for (const [a, b, c] of polygonTriangles(rings.map((ring) => ring.map((p) => at(p, 0))))) {
      builder.triangle(a, b, c, colour, origin);
    }

    if (height <= 0) return;

    // Roof, and a wall per edge. Turning a footprint into massing is the whole
    // reason to read a flat format into a 3D scene.
    for (const [a, b, c] of polygonTriangles(rings.map((ring) => ring.map((p) => at(p, height))))) {
      builder.triangle(a, b, c, colour, origin);
    }
    for (const closed of rings) {
      const boundary = openRing(closed);
      for (let i = 0; i < boundary.length; i += 1) {
      const a = boundary[i];
      const b = boundary[(i + 1) % boundary.length];
      builder.triangle(at(a, 0), at(b, 0), at(b, height), colour, origin);
      builder.triangle(at(a, 0), at(b, height), at(a, height), colour, origin);
      }
    }
  };

  const line = (points: Position[]) => {
    // A ribbon, because a line has no width and this scene is made of
    // triangles. Half-width either side of the centreline.
    for (let i = 0; i + 1 < points.length; i += 1) {
      const [ax, ay] = projected.get(points[i])!;
      const [bx, by] = projected.get(points[i + 1])!;
      const dx = bx - ax;
      const dy = by - ay;
      const length = Math.hypot(dx, dy);
      if (length === 0) continue;

      const nx = (-dy / length) * (LINE_WIDTH / 2);
      const ny = (dx / length) * (LINE_WIDTH / 2);

      const az = points[i][2] ?? 0, bz = points[i + 1][2] ?? 0;
      const p1: [number, number, number] = [ax + nx, ay + ny, az];
      const p2: [number, number, number] = [ax - nx, ay - ny, az];
      const p3: [number, number, number] = [bx - nx, by - ny, bz];
      const p4: [number, number, number] = [bx + nx, by + ny, bz];

      builder.triangle(p1, p2, p3, colour, origin);
      builder.triangle(p1, p3, p4, colour, origin);
    }
  };

  const point = (position: Position) => {
    const [x, y] = projected.get(position)!;
    const z = position[2] ?? 0;
    const half = POINT_SIZE / 2;
    const a: [number, number, number] = [x - half, y - half, z];
    const b: [number, number, number] = [x + half, y - half, z];
    const c: [number, number, number] = [x + half, y + half, z];
    const d: [number, number, number] = [x - half, y + half, z];
    builder.triangle(a, b, c, colour, origin);
    builder.triangle(a, c, d, colour, origin);
  };

  const coordinates = geometry.coordinates;

  switch (geometry.type) {
    case "Polygon":
      polygon(coordinates as Position[][]);
      break;
    case "MultiPolygon":
      for (const part of (coordinates as Position[][][]) ?? []) polygon(part);
      break;
    case "LineString":
      line(coordinates as Position[]);
      break;
    case "MultiLineString":
      for (const part of (coordinates as Position[][]) ?? []) line(part);
      break;
    case "Point":
      if (isPosition(coordinates)) point(coordinates);
      break;
    case "MultiPoint":
      for (const part of (coordinates as Position[]) ?? []) point(part);
      break;
    default:
      break;
  }
  builder.addFeature(feature, firstTriangle, geometry.type === "Polygon" || geometry.type === "MultiPolygon");
}
