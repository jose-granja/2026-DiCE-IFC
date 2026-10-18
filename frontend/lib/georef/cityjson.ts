"use client";

/**
 * CityJSON as surrounding context for a model.
 *
 * A basemap answers "is the building in the right place". It does not answer
 * "is it the right height next to its neighbours", or "does it sit correctly
 * against the terrain" — those need the neighbours, in 3D. Many municipalities
 * publish exactly that as CityJSON, so this reads a file the user already has
 * rather than requiring a 3D tile service.
 *
 * Parsed in the tab like everything else. A CityJSON file is somebody's city
 * model and is treated as model data: it is never uploaded.
 *
 * ## The parts of the format that matter here
 *
 * - **Vertices are integers.** CityJSON quantises coordinates and stores the
 *   scale and translation in `transform`. Reading `vertices` without applying
 *   `transform` gives numbers that look plausible and are wrong by kilometres,
 *   which is the mistake this format invites.
 * - **Boundaries are indices, nested by geometry type.** A `MultiSurface` is
 *   `[[[i, j, k]], …]` — surface, ring, vertex. A `Solid` adds a shell level on
 *   top. Assuming one depth renders the other as noise rather than failing.
 * - **`metadata.referenceSystem`** is an OGC URI such as
 *   `https://www.opengis.net/def/crs/EPSG/0/3763`, not a bare code.
 *
 * ## Reading only what is nearby
 *
 * A national or regional cadastre publishes one CityJSON for everything —
 * hundreds of thousands of buildings, hundreds of megabytes. `JSON.parse` on
 * the whole document builds a JS object for every one of them before a single
 * triangle is drawn, which is the thing that actually hangs the tab; the file
 * itself just sitting in memory as one string is comparatively cheap.
 * `parseCityJsonClipped` avoids that: it walks the top-level object as text
 * (`topLevelEntries`), parses `vertices` into flat typed arrays instead of an
 * array of arrays, and then `JSON.parse`s each `CityObjects` entry **one at a
 * time**, discarding it immediately if it is outside the radius. Only the kept
 * objects, and only the vertices they use, ever become real geometry — the
 * same triangulation `parseCityJson` uses, via {@link buildGeometry}.
 */

import { mapToWgs84, wgs84ToMap } from "./transform";

import { ContextFeatureIndex, contextFeatureName, type ContextGeometry } from "./context-geometry";
import { polygonTriangles } from "./polygon-triangulation";

export type CityJsonParseResult = ContextGeometry;

export class CityJsonError extends Error {}

type Geometry = { type?: string; lod?: string | number; boundaries?: unknown };
type CityObject = { type?: string; attributes?: Record<string, unknown>; geometry?: Geometry[] };

type CityJson = {
  type?: string;
  version?: string;
  transform?: { scale?: number[]; translate?: number[] };
  vertices?: number[][];
  CityObjects?: Record<string, CityObject>;
  metadata?: { referenceSystem?: string };
};

/**
 * Colours by CityObject type.
 *
 * Muted on purpose: this is context around the model being checked, and
 * context that competes with the model for attention defeats the point.
 */
const COLOURS: Record<string, [number, number, number]> = {
  Building: [0.62, 0.64, 0.68],
  BuildingPart: [0.62, 0.64, 0.68],
  Road: [0.42, 0.42, 0.45],
  TINRelief: [0.45, 0.52, 0.42],
  WaterBody: [0.35, 0.48, 0.62],
  PlantCover: [0.44, 0.56, 0.42],
  LandUse: [0.5, 0.5, 0.46],
  Bridge: [0.58, 0.55, 0.5],
  CityFurniture: [0.55, 0.55, 0.58],
};
const DEFAULT_COLOUR: [number, number, number] = [0.55, 0.56, 0.6];

/**
 * `https://www.opengis.net/def/crs/EPSG/0/3763` → 3763.
 *
 * The trailing digits, not the first ones after "EPSG": the OGC form puts a
 * version segment in between (`/EPSG/0/3763`), so anything that stops at the
 * first non-digit reads the version instead and returns nothing useful.
 * `EPSG:3763` and `EPSG::3763` both work too.
 */
export function epsgFromReferenceSystem(uri: string | undefined): number | null {
  if (!uri) return null;
  const match = /EPSG.*?(\d{4,5})\s*$/i.exec(uri.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Flatten a boundaries tree to its rings.
 *
 * Rather than switch on the declared geometry type and trust it, this descends
 * until it reaches an array of numbers. A `Solid`'s extra shell level and a
 * `MultiSurface`'s absence of one then need no special case, and a file whose
 * declared type disagrees with its actual nesting still reads correctly —
 * which happens, because exporters vary.
 */
function* rings(node: unknown): Generator<number[]> {
  if (!Array.isArray(node) || node.length === 0) return;
  if (typeof node[0] === "number") {
    yield node as number[];
    return;
  }
  for (const child of node) yield* rings(child);
}

/** Preserve each surface's exterior and holes while ignoring shell nesting. */
function* surfaces(node: unknown): Generator<number[][]> {
  if (!Array.isArray(node) || node.length === 0) return;
  if (typeof node[0] === "number") { yield [node as number[]]; return; }
  if (Array.isArray(node[0]) && typeof node[0][0] === "number") {
    yield node as number[][];
    return;
  }
  for (const child of node) yield* surfaces(child);
}

/**
 * Build the render output from resolved CityObjects and their vertex
 * coordinates, already in metres. Shared by the whole-file and clipped
 * readers so triangulation only exists once.
 */
function buildGeometry(
  cityObjects: Iterable<[string, CityObject]>,
  xs: Float64Array,
  ys: Float64Array,
  zs: Float64Array,
): CityJsonParseResult {
  const vertexCount = xs.length;

  // Local origin at the centre, so the geometry is small numbers near zero.
  // Projected coordinates are millions of metres and a GPU buffer is float32,
  // which cannot hold them without the geometry visibly jittering.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertexCount; i += 1) {
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
    if (zs[i] < minZ) minZ = zs[i];
    if (zs[i] > maxZ) maxZ = zs[i];
  }

  const origin = {
    easting: (minX + maxX) / 2,
    northing: (minY + maxY) / 2,
    height: minZ,
  };

  const positions: number[] = [];
  const colours: number[] = [];
  const featureIndex = new ContextFeatureIndex();
  const typeCounts = new Map<string, number>();
  let objectCount = 0;

  for (const [id, object] of cityObjects) {
    const firstTriangle = positions.length / 9;
    const type = object.type ?? "Unknown";
    const colour = COLOURS[type] ?? DEFAULT_COLOUR;
    let drewSomething = false;

    for (const geometry of object.geometry ?? []) {
      if (/Point|Line|Curve/.test(geometry.type ?? "")) continue;
      for (const surface of surfaces(geometry.boundaries)) {
        if (!surface.every((ring) => Array.isArray(ring) && ring.every((index) => Number.isInteger(index) && index >= 0 && index < vertexCount))) continue;
        const points = surface.map((ring) => ring.map((index): [number, number, number] => [xs[index], ys[index], zs[index]]));
        for (const triangle of polygonTriangles(points)) {
          // CityJSON is Z-up in a projected CRS; the renderer is Y-up with -Z
          // as north. Same convention as the rest of the georeferencing code.
          for (const [x, y, z] of triangle) {
            positions.push(
              x - origin.easting,
              z - origin.height,
              -(y - origin.northing),
            );
            colours.push(colour[0], colour[1], colour[2]);
          }
          drewSomething = true;
        }
      }
    }

    if (drewSomething) {
      const properties = object.attributes ?? {};
      featureIndex.add({ id, type, source: "CityJSON", properties,
        name: contextFeatureName(properties) }, firstTriangle, positions.length / 9);
      objectCount += 1;
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    }
  }

  if (positions.length === 0) {
    throw new CityJsonError(
      "This CityJSON file has no geometry that could be drawn — it may hold only metadata, or geometry types this reader does not cover.",
    );
  }

  return {
    features: featureIndex.features,
    featureRanges: featureIndex.featureRanges,
    positions: new Float32Array(positions),
    colours: new Float32Array(colours),
    origin,
    epsg: null, // set by the caller, which knows which CRS these metres are in
    objectCount,
    types: [...typeCounts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    sizeMetres: Math.max(maxX - minX, maxY - minY),
  };
}

export function parseCityJson(text: string): CityJsonParseResult {
  let data: CityJson;
  try {
    data = JSON.parse(text) as CityJson;
  } catch {
    throw new CityJsonError("That file is not valid JSON.");
  }

  if (data.type !== "CityJSON") {
    throw new CityJsonError(
      "That is not a CityJSON file — its top-level “type” is not “CityJSON”.",
    );
  }
  if (!Array.isArray(data.vertices) || data.vertices.length === 0) {
    throw new CityJsonError("This CityJSON file has no vertices.");
  }

  // Without the transform the coordinates are quantised integers, not metres.
  const scale = data.transform?.scale ?? [1, 1, 1];
  const translate = data.transform?.translate ?? [0, 0, 0];

  const vertexCount = data.vertices.length;
  const xs = new Float64Array(vertexCount);
  const ys = new Float64Array(vertexCount);
  const zs = new Float64Array(vertexCount);

  for (let i = 0; i < vertexCount; i += 1) {
    const v = data.vertices[i];
    xs[i] = v[0] * (scale[0] ?? 1) + (translate[0] ?? 0);
    ys[i] = v[1] * (scale[1] ?? 1) + (translate[1] ?? 0);
    zs[i] = v[2] * (scale[2] ?? 1) + (translate[2] ?? 0);
  }

  const result = buildGeometry(Object.entries(data.CityObjects ?? {}), xs, ys, zs);
  return { ...result, epsg: epsgFromReferenceSystem(data.metadata?.referenceSystem) };
}

// ---------------------------------------------------------------------------
// Reading only what is nearby
// ---------------------------------------------------------------------------

/**
 * Split a flat JSON object's text into its top-level `[key, valueText]`
 * entries, without parsing any value that is not asked for.
 *
 * String-aware bracket counting rather than a real parser: `text` is
 * `{"key1":value1,"key2":value2,…}` and every value here is either a small
 * scalar/object (`type`, `version`, `transform`, `metadata`) or one this
 * module deliberately parses piece by piece (`CityObjects`, one entry at a
 * time) — nothing here needs a validating parser, only correct depth
 * tracking through nested `{}`/`[]` and quoted strings.
 */
export function* topLevelEntries(text: string): Generator<[string, string]> {
  // The last "}" in the text, not the first depth-0 close: trailing
  // whitespace or a stray CRLF after the real close (both seen in the wild)
  // would otherwise make the scan stop one character short.
  const end = text.lastIndexOf("}");
  const start = text.indexOf("{") + 1;
  if (start === 0 || end < start) return;

  let i = start;
  while (i < end) {
    const keyStart = text.indexOf('"', i) + 1;
    if (keyStart === 0 || keyStart > end) return;
    let keyEnd = keyStart;
    for (; keyEnd < end; keyEnd++) {
      if (text[keyEnd] === "\\") keyEnd++;
      else if (text[keyEnd] === '"') break;
    }
    const key = text.slice(keyStart, keyEnd);
    const valueStart = text.indexOf(":", keyEnd) + 1;

    // Depth-tracked scan for the matching top-level separator. A value that
    // is itself an object or array returns depth to 0 when its own bracket
    // closes; a bare scalar (a quoted string, here — CityJSON has no bare
    // numbers or booleans at this level) never changes depth at all. Either
    // way the value ends at the next depth-0 "," — or, for the last entry,
    // wherever the loop bound stops the scan, which is `end` exactly.
    let depth = 0;
    let inString = false;
    let escaped = false;
    let k = valueStart;
    for (; k < end; k += 1) {
      const c = text[k];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === "{" || c === "[") {
        depth += 1;
        continue;
      }
      if (c === "}" || c === "]") {
        depth -= 1;
        continue;
      }
      if (depth === 0 && c === ",") break;
    }
    yield [key, text.slice(valueStart, k).trim()];
    i = text[k] === "," ? k + 1 : k;
  }
}

/** The first top-level value for `key`, or `undefined` if there is none. */
export function findTopLevelValue(text: string, key: string): string | undefined {
  for (const [entryKey, value] of topLevelEntries(text)) {
    if (entryKey === key) return value;
  }
  return undefined;
}

/**
 * Cheap `"type"` sniff for dispatching a `.json` file to the right reader.
 *
 * `JSON.parse`ing the whole file only to read one field is what this whole
 * module exists to avoid — including at the sniffing step, which is why
 * `ContextModel` calls this instead of `JSON.parse(text).type`.
 */
export function sniffJsonType(text: string): string | undefined {
  const value = findTopLevelValue(text, "type");
  return value ? (JSON.parse(value) as string) : undefined;
}

export type CityJsonClipOptions = {
  referenceLongitude: number;
  referenceLatitude: number;
  radiusMetres: number;
  /** The CRS to place the result in — normally the model's own. */
  targetEpsg: number;
};

/**
 * Read only the CityObjects within `radiusMetres` of a point, reprojected
 * into `targetEpsg`.
 *
 * Requires the file to declare a resolvable `metadata.referenceSystem`:
 * clipping needs to know where the coordinates actually are, and guessing
 * would silently keep or drop the wrong buildings. `EPSG:4326` vertices are
 * read as longitude/latitude; anything else is read as already-projected
 * metres in that CRS. Either way the *filter* runs in the source CRS (a
 * planar distance against a once-converted reference point, or a direct
 * degree comparison) — only the kept subset is ever reprojected to
 * `targetEpsg`, which is the expensive step and the one this whole function
 * exists to do as little of as possible.
 */
export function parseCityJsonClipped(
  text: string,
  clip: CityJsonClipOptions,
): CityJsonParseResult {
  const typeValue = findTopLevelValue(text, "type");
  if (typeValue !== '"CityJSON"') {
    throw new CityJsonError(
      "That is not a CityJSON file — its top-level “type” is not “CityJSON”.",
    );
  }

  const verticesText = findTopLevelValue(text, "vertices");
  if (!verticesText) throw new CityJsonError("This CityJSON file has no vertices.");

  const rawVertices = JSON.parse(verticesText) as number[][];
  if (rawVertices.length === 0) {
    throw new CityJsonError("This CityJSON file has no vertices.");
  }

  const transformText = findTopLevelValue(text, "transform");
  const transform = transformText
    ? (JSON.parse(transformText) as { scale?: number[]; translate?: number[] })
    : undefined;
  const scale = transform?.scale ?? [1, 1, 1];
  const translate = transform?.translate ?? [0, 0, 0];

  const metadataText = findTopLevelValue(text, "metadata");
  const metadata = metadataText
    ? (JSON.parse(metadataText) as { referenceSystem?: string })
    : undefined;
  const sourceEpsg = epsgFromReferenceSystem(metadata?.referenceSystem);
  if (sourceEpsg === null) {
    throw new CityJsonError(
      "This CityJSON file declares no usable reference system, so it cannot be matched to the model's location.",
    );
  }

  const vertexCount = rawVertices.length;
  const rawX = new Float64Array(vertexCount);
  const rawY = new Float64Array(vertexCount);
  const rawZ = new Float64Array(vertexCount);
  for (let i = 0; i < vertexCount; i += 1) {
    const v = rawVertices[i];
    rawX[i] = v[0] * (scale[0] ?? 1) + (translate[0] ?? 0);
    rawY[i] = v[1] * (scale[1] ?? 1) + (translate[1] ?? 0);
    rawZ[i] = v[2] * (scale[2] ?? 1) + (translate[2] ?? 0);
  }

  const geographic = sourceEpsg === 4326;
  const withinRadius = new Uint8Array(vertexCount);
  const radiusSquared = clip.radiusMetres * clip.radiusMetres;

  if (geographic) {
    // Degrees, so the filter is a local equirectangular approximation —
    // exact enough at the scale a "clip to N metres" radius operates at.
    const latRad = (clip.referenceLatitude * Math.PI) / 180;
    const metresPerDegreeLat = 111_132;
    const metresPerDegreeLon = metresPerDegreeLat * Math.cos(latRad);
    for (let i = 0; i < vertexCount; i += 1) {
      const dEast = (rawX[i] - clip.referenceLongitude) * metresPerDegreeLon;
      const dNorth = (rawY[i] - clip.referenceLatitude) * metresPerDegreeLat;
      withinRadius[i] = dEast * dEast + dNorth * dNorth <= radiusSquared ? 1 : 0;
    }
  } else {
    // Already a projected CRS: convert the reference point once, then
    // compare raw metres directly rather than reprojecting every vertex.
    const referenceMap = wgs84ToMap(
      { longitude: clip.referenceLongitude, latitude: clip.referenceLatitude },
      sourceEpsg,
    );
    for (let i = 0; i < vertexCount; i += 1) {
      const dEast = rawX[i] - referenceMap.easting;
      const dNorth = rawY[i] - referenceMap.northing;
      withinRadius[i] = dEast * dEast + dNorth * dNorth <= radiusSquared ? 1 : 0;
    }
  }

  const cityObjectsText = findTopLevelValue(text, "CityObjects");
  if (!cityObjectsText) throw new CityJsonError("This CityJSON file has no CityObjects.");

  const keptObjects: Array<[string, CityObject]> = [];
  const usedVertexIndices = new Set<number>();

  for (const [id, valueText] of topLevelEntries(cityObjectsText)) {
    let object: CityObject;
    try {
      object = JSON.parse(valueText) as CityObject;
    } catch {
      continue; // a malformed entry is skipped rather than failing the load
    }

    const objectIndices: number[] = [];
    let matches = false;
    for (const geometry of object.geometry ?? []) {
      for (const ring of rings(geometry.boundaries)) {
        for (const index of ring) {
          if (index >= vertexCount) continue;
          objectIndices.push(index);
          if (withinRadius[index]) matches = true;
        }
      }
    }

    if (matches) {
      keptObjects.push([JSON.parse(`"${id}"`) as string, object]);
      for (const index of objectIndices) usedVertexIndices.add(index);
    }
  }

  if (keptObjects.length === 0) {
    throw new CityJsonError(
      `No CityJSON objects fall within ${clip.radiusMetres} m of the model.`,
    );
  }

  // Re-index: only the vertices the kept objects use, reprojected into the
  // target CRS. `sourceEpsg === targetEpsg` (clipping a file already in the
  // model's own CRS, the common case) skips reprojection entirely.
  const oldToNew = new Map<number, number>();
  const newX = new Float64Array(usedVertexIndices.size);
  const newY = new Float64Array(usedVertexIndices.size);
  const newZ = new Float64Array(usedVertexIndices.size);
  let newIndex = 0;
  for (const oldIndex of usedVertexIndices) {
    if (geographic) {
      const map = wgs84ToMap(
        { longitude: rawX[oldIndex], latitude: rawY[oldIndex] },
        clip.targetEpsg,
      );
      newX[newIndex] = map.easting;
      newY[newIndex] = map.northing;
    } else if (sourceEpsg === clip.targetEpsg) {
      newX[newIndex] = rawX[oldIndex];
      newY[newIndex] = rawY[oldIndex];
    } else {
      const wgs = mapToWgs84({ easting: rawX[oldIndex], northing: rawY[oldIndex] }, sourceEpsg);
      const map = wgs84ToMap(wgs, clip.targetEpsg);
      newX[newIndex] = map.easting;
      newY[newIndex] = map.northing;
    }
    newZ[newIndex] = rawZ[oldIndex];
    oldToNew.set(oldIndex, newIndex);
    newIndex += 1;
  }

  function remapBoundaries(node: unknown): unknown {
    if (!Array.isArray(node)) return node;
    if (typeof node[0] === "number") {
      return (node as number[]).map((index) => oldToNew.get(index) ?? 0);
    }
    return node.map(remapBoundaries);
  }

  for (const [, object] of keptObjects) {
    for (const geometry of object.geometry ?? []) {
      geometry.boundaries = remapBoundaries(geometry.boundaries);
    }
  }

  const result = buildGeometry(keptObjects, newX, newY, newZ);
  return { ...result, epsg: clip.targetEpsg };
}
