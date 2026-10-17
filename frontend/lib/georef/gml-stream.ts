/**
 * Incremental GML reader for files too large to turn into one JavaScript string.
 *
 * National CityGML deliveries can be several gigabytes. `File.text()` and one
 * `DOMParser` document make three or more full-size copies and exceed the
 * browser's string/heap limits before geometry parsing starts. This scanner
 * keeps one chunk plus an unfinished `posList`, clips in the source CRS, and
 * only projects/builds the small area around the IFC model.
 */

import { GmlMetadataStream } from "./gml-metadata";
import { GeometryBuilder, type ContextFeature, type ContextGeometry } from "./context-geometry";
import { polygonTriangles } from "./polygon-triangulation";
import { epsgFromSrsName } from "./citygml";
import { mapToWgs84, wgs84ToMap, type WgsPoint } from "./transform";

type Point = [number, number, number];

export type LargeGmlClipOptions = {
  targetEpsg: number;
  reference: WgsPoint;
  radiusMetres: number;
  onProgress?: (percent: number) => void;
};

const CHUNK_BYTES = 4 * 1024 * 1024;
const BUILDING_COLOUR: [number, number, number] = [0.62, 0.64, 0.68];

function distanceSquaredDegrees(
  reference: WgsPoint,
  longitude: number,
  latitude: number,
) {
  const longitudeScale = Math.cos((reference.latitude * Math.PI) / 180);
  const dx = (longitude - reference.longitude) * longitudeScale;
  const dy = latitude - reference.latitude;
  return dx * dx + dy * dy;
}

function detectAxisOrder(
  first: number,
  second: number,
  reference: WgsPoint,
): "longitude-latitude" | "latitude-longitude" {
  const normal = distanceSquaredDegrees(reference, first, second);
  const swapped = distanceSquaredDegrees(reference, second, first);
  return swapped < normal ? "latitude-longitude" : "longitude-latitude";
}

function numbersIn(content: string): number[] {
  return content
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter(Number.isFinite);
}

function intersectsClip(
  points: Point[],
  sourceEpsg: number,
  axisOrder: "longitude-latitude" | "latitude-longitude",
  reference: WgsPoint,
  radiusMetres: number,
  referenceInTarget: { easting: number; northing: number },
  targetEpsg: number,
): boolean {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of points) {
    const x = point[0];
    const y = point[1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  if (sourceEpsg === 4326) {
    const minLon = axisOrder === "latitude-longitude" ? minY : minX;
    const maxLon = axisOrder === "latitude-longitude" ? maxY : maxX;
    const minLat = axisOrder === "latitude-longitude" ? minX : minY;
    const maxLat = axisOrder === "latitude-longitude" ? maxX : maxY;
    const latitudeRadius = radiusMetres / 111_320;
    const longitudeRadius = radiusMetres /
      Math.max(1, 111_320 * Math.cos((reference.latitude * Math.PI) / 180));
    return !(
      maxLon < reference.longitude - longitudeRadius ||
      minLon > reference.longitude + longitudeRadius ||
      maxLat < reference.latitude - latitudeRadius ||
      minLat > reference.latitude + latitudeRadius
    );
  }

  if (sourceEpsg === targetEpsg) {
    return !(
      maxX < referenceInTarget.easting - radiusMetres ||
      minX > referenceInTarget.easting + radiusMetres ||
      maxY < referenceInTarget.northing - radiusMetres ||
      minY > referenceInTarget.northing + radiusMetres
    );
  }

  // One transform per distant polygon, rather than one per vertex. Polygons
  // close enough to retain are fully transformed below.
  const centre = mapToWgs84(
    { easting: (minX + maxX) / 2, northing: (minY + maxY) / 2 },
    sourceEpsg,
  );
  const latitudeRadius = radiusMetres / 111_320;
  const longitudeRadius = radiusMetres /
    Math.max(1, 111_320 * Math.cos((reference.latitude * Math.PI) / 180));
  return (
    Math.abs(centre.longitude - reference.longitude) <= longitudeRadius * 2 &&
    Math.abs(centre.latitude - reference.latitude) <= latitudeRadius * 2
  );
}

function projectRing(
  points: Point[],
  sourceEpsg: number,
  targetEpsg: number,
  axisOrder: "longitude-latitude" | "latitude-longitude",
): Point[] {
  if (sourceEpsg === targetEpsg && sourceEpsg !== 4326) return points;
  return points.map(([x, y, z]) => {
    const wgs = sourceEpsg === 4326
      ? {
          longitude: axisOrder === "latitude-longitude" ? y : x,
          latitude: axisOrder === "latitude-longitude" ? x : y,
          height: z,
        }
      : mapToWgs84({ easting: x, northing: y, height: z }, sourceEpsg);
    const map = wgs84ToMap(wgs, targetEpsg);
    return [map.easting, map.northing, z];
  });
}

export async function parseLargeGml(
  blob: Blob,
  options: LargeGmlClipOptions,
): Promise<ContextGeometry> {
  if (!Number.isFinite(options.radiusMetres) || options.radiusMetres <= 0) {
    throw new Error("The GML clip radius must be greater than zero.");
  }

  const header = await blob.slice(0, Math.min(blob.size, 256 * 1024)).text();
  if (!header.trimStart().startsWith("<")) {
    throw new Error("That .gml file does not begin with XML content.");
  }
  const srsName = /\bsrsName\s*=\s*["']([^"']+)["']/i.exec(header)?.[1];
  const sourceEpsg = epsgFromSrsName(srsName);
  if (sourceEpsg === null) {
    throw new Error("This GML file has no supported EPSG code in srsName.");
  }
  const globalDimension = Number(
    /\bsrsDimension\s*=\s*["'](\d+)["']/i.exec(header)?.[1],
  ) || 3;
  const referenceInTarget = wgs84ToMap(options.reference, options.targetEpsg);

  type Surface = { exterior: Point[]; holes: Point[][]; feature: ContextFeature };
  const retained: Surface[] = [];
  let current: (Surface & { polygon: object }) | undefined;
  const metadata = new GmlMetadataStream();
  let axisOrder: "longitude-latitude" | "latitude-longitude" | null = null;
  let pending = "";
  let offset = 0;
  let seenPosLists = 0;
  const decoder = new TextDecoder();

  const finishSurface = () => {
    if (!current) return;
    const { exterior, holes, feature } = current;
    const order = axisOrder ?? "longitude-latitude";
    // Clip the surface as a whole. Testing holes separately can either fill a
    // courtyard or lose its boundary when only the exterior intersects the clip.
    if (exterior.length >= 3 && intersectsClip(
      exterior, sourceEpsg, order, options.reference, options.radiusMetres,
      referenceInTarget, options.targetEpsg,
    )) {
      retained.push({
        exterior: projectRing(exterior, sourceEpsg, options.targetEpsg, order),
        holes: holes.map((ring) => projectRing(ring, sourceEpsg, options.targetEpsg, order)),
        feature,
      });
    }
    current = undefined;
  };

  while (offset < blob.size) {
    const end = Math.min(blob.size, offset + CHUNK_BYTES);
    pending += decoder.decode(await blob.slice(offset, end).arrayBuffer(), {
      stream: end < blob.size,
    });
    offset = end;

    let consumed = 0;
    const opening = /<(?:[\w.-]+:)?posList\b([^>]*)>/gi;
    opening.lastIndex = 0;
    while (true) {
      const match = opening.exec(pending);
      if (!match) {
        const lastOpening = pending.lastIndexOf("<");
        const end = lastOpening >= consumed && !pending.slice(lastOpening).includes(">") ? lastOpening : pending.length;
        metadata.feed(pending.slice(consumed, end));
        consumed = end;
        break;
      }
      const contentStart = opening.lastIndex;
      const closing = /<\/(?:[\w.-]+:)?posList\s*>/gi;
      closing.lastIndex = contentStart;
      const close = closing.exec(pending);
      if (!close) {
        metadata.feed(pending.slice(consumed, match.index));
        consumed = match.index;
        break;
      }

      metadata.feed(pending.slice(consumed, contentStart));
      const polygon = metadata.polygon;
      if (polygon !== current?.polygon) finishSurface();
      const dimension = metadata.dimension ?? globalDimension;
      const values = numbersIn(pending.slice(contentStart, close.index));
      const points: Point[] = [];
      for (let i = 0; i + dimension - 1 < values.length; i += dimension) {
        points.push([values[i], values[i + 1], dimension >= 3 ? values[i + 2] : 0]);
      }
      seenPosLists += 1;
      if (points.length >= 3 && polygon) {
        if (sourceEpsg === 4326 && axisOrder === null) {
          axisOrder = detectAxisOrder(points[0][0], points[0][1], options.reference);
        }
        current ??= { polygon, exterior: [], holes: [],
          feature: metadata.feature ?? { id: String(seenPosLists), type: "GML surface", source: "CityGML / GML", properties: {} } };
        if (metadata.interior) current.holes.push(points);
        else current.exterior = points;
      }

      metadata.feed(pending.slice(close.index, closing.lastIndex));
      consumed = closing.lastIndex;
      opening.lastIndex = consumed;
    }

    pending = pending.slice(consumed);

    options.onProgress?.(Math.round((offset / blob.size) * 100));
    // Give the worker event loop a chance to deliver progress and cancellation.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  finishSurface();

  if (seenPosLists === 0) {
    throw new Error("This GML file contains no gml:posList geometry.");
  }
  if (retained.length === 0) {
    throw new Error(
      `No GML geometry was found within ${Math.round(options.radiusMetres)} m of the model.`,
    );
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  for (const { exterior } of retained) {
    for (const [x, y, z] of exterior) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
    }
  }
  const origin = {
    easting: (minX + maxX) / 2,
    northing: (minY + maxY) / 2,
    height: Number.isFinite(minZ) ? minZ : 0,
  };
  const builder = new GeometryBuilder();
  for (const { exterior, holes, feature } of retained) {
    const firstTriangle = builder.triangleCount;
    for (const [a, b, c] of polygonTriangles([exterior, ...holes])) {
      builder.triangle(a, b, c, BUILDING_COLOUR, origin);
    }
    builder.addFeature(feature, firstTriangle);
  }

  return {
    ...builder.finish(),
    origin,
    epsg: options.targetEpsg,
    objectCount: retained.length,
    types: [{ type: "GML surface", count: retained.length }],
    sizeMetres: Math.max(maxX - minX, maxY - minY),
  };
}
