"use client";

/**
 * GeoPackage as surrounding context.
 *
 * A GeoPackage is a SQLite database with an OGC-defined schema, which is why
 * this is the heaviest of the readers: it needs a real SQL engine in the
 * browser. `@sqlite.org/sqlite-wasm` is the official build, ~870 kB of
 * WebAssembly, loaded on demand so it costs nothing until someone opens a
 * `.gpkg`.
 *
 * Read in the tab like every other file here, and never uploaded.
 *
 * ## The parts of the format that matter
 *
 * - **The schema tells you where the data is.** `gpkg_contents` lists the
 *   tables, `gpkg_geometry_columns` says which column in each holds geometry,
 *   and `gpkg_spatial_ref_sys` says what CRS it is in. Guessing any of the
 *   three is how a reader ends up working on one file and not the next.
 * - **Geometry is a GeoPackage blob wrapping WKB**, not bare WKB — see
 *   `unwrapGeoPackageBlob`.
 * - **`srs_id` is per geometry column**, and need not match the model's.
 */

import proj4 from "proj4";
import { findCrs, WGS84_PROJ4 } from "@/config/epsg";
import type { WgsPoint } from "./transform";
import {
  GeometryBuilder,
  contextFeatureName,
  type ContextFeature,
  type ContextGeometry,
} from "./context-geometry";
import { parseWkb, unwrapGeoPackageBlob, type WkbPoint } from "./wkb";
import { contextTriangles, transformClipBox, type ClipBox, type ContextTriangle } from "./vector-context";

export type GeoPackageErrorCode = "invalidFile" | "openFailed" | "noFeatures" | "noGeometry" | "nothingNearby" | "unsupportedCrs";
export class GeoPackageError extends Error {
  constructor(readonly code: GeoPackageErrorCode) { super(code); }
}

export type GeoPackageOptions = {
  clip?: { reference: WgsPoint; radiusMetres: number };
  /** A CRS selected from the full registry in the host tab. */
  targetDefinition?: string;
  onProgress?: (percent: number) => void;
};

const COLOURS: Record<string, [number, number, number]> = {
  building: [0.62, 0.64, 0.68],
  road: [0.42, 0.42, 0.45],
  water: [0.35, 0.48, 0.62],
  vegetation: [0.44, 0.56, 0.42],
  parcel: [0.5, 0.5, 0.46],
};
const DEFAULT_COLOUR: [number, number, number] = [0.55, 0.56, 0.6];

/** Guess a kind from the table's name, for colour only. */
function kindOf(table: string): string {
  const name = table.toLowerCase();
  if (/build|edific|predio/.test(name)) return "building";
  if (/road|street|rua|estrada|via|high/.test(name)) return "road";
  if (/water|rio|agua|lake|sea|ocean|oceano|^mar$/.test(name)) return "water";
  if (/park|tree|veget|verde/.test(name)) return "vegetation";
  if (/parcel|cadastr|lot|terreno/.test(name)) return "parcel";
  return "feature";
}

type Sqlite = {
  oo1: { DB: new (...args: unknown[]) => SqliteDb };
  capi: Record<string, (...args: never[]) => unknown>;
  wasm: {
    allocFromTypedArray: (bytes: Uint8Array) => number;
    peekPtr?: unknown;
  };
};

type SqliteDb = {
  pointer: number;
  exec: (options: {
    sql: string;
    rowMode?: string;
    returnValue?: string;
    callback?: (row: Record<string, unknown>) => void;
  }) => unknown[];
  close: () => void;
};

let sqlitePromise: Promise<Sqlite> | null = null;

/**
 * Start SQLite, once per session.
 *
 * `locateFile` is not optional here: the package resolves its `.wasm` from
 * `import.meta.url`, which under a bundler is the chunk's URL rather than the
 * package's, so the file is looked for beside the chunk and is not there. The
 * copy script puts it at a known path.
 */
async function sqlite(): Promise<Sqlite> {
  sqlitePromise ??= (async () => {
    // Served, not bundled — see `scripts/copy-cesium-assets.mts`. A plain
    // string literal with the magic comment is the only form the bundler
    // leaves alone; a cast or a variable makes it emit a runtime resolver that
    // this application's CSP then blocks for using `eval`.
    //
    // @ts-expect-error — a served URL, not a module the compiler resolves.
    const loaded = await import(/* turbopackIgnore: true */ "/sqlite/index.mjs");
    const init = (loaded as { default: unknown }).default as (config: {
      print?: () => void;
      printErr?: () => void;
    }) => Promise<Sqlite>;

    return init({
      // SQLite prints its version banner on start; this is a file reader, not
      // a database console. Its `.wasm` is found relative to the served module.
      print: () => {},
      printErr: () => {},
    });
  })().catch((error) => {
    sqlitePromise = null;
    throw error;
  });

  return sqlitePromise;
}

/** Open a GeoPackage's bytes as an in-memory database. */
async function open(bytes: Uint8Array): Promise<{ db: SqliteDb; close: () => void }> {
  if (bytes.length < 16 || new TextDecoder().decode(bytes.subarray(0, 15)) !== "SQLite format 3") {
    throw new GeoPackageError("invalidFile");
  }
  const engine = await sqlite();

  const db = new engine.oo1.DB();
  const pointer = engine.wasm.allocFromTypedArray(bytes);

  // Hands the bytes to SQLite and lets it own them: FREEONCLOSE releases the
  // copy with the connection, RESIZEABLE lets SQLite work without a file.
  const capi = engine.capi as unknown as {
    sqlite3_deserialize: (...args: unknown[]) => number;
    SQLITE_DESERIALIZE_FREEONCLOSE: number;
    SQLITE_DESERIALIZE_RESIZEABLE: number;
  };

  const result = capi.sqlite3_deserialize(
    db.pointer,
    "main",
    pointer,
    bytes.length,
    bytes.length,
    capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE,
  );

  if (result !== 0) {
    db.close();
    throw new GeoPackageError("openFailed");
  }

  return { db, close: () => db.close() };
}

function rows(db: SqliteDb, sql: string): Record<string, unknown>[] {
  return db.exec({ sql, rowMode: "object", returnValue: "resultRows" }) as unknown as Record<
    string,
    unknown
  >[];
}

/** Database SRS IDs are local keys, not necessarily EPSG codes. */
function layerDefinition(layer: Record<string, unknown>): string {
  if (String(layer.authority).toUpperCase() === "EPSG") {
    const known = findCrs(Number(layer.code));
    if (known) return known.proj4;
  }
  const wkt = String(layer.definition ?? "");
  if (wkt && wkt !== "undefined") return wkt;
  throw new GeoPackageError("unsupportedCrs");
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

export async function parseGeoPackage(
  bytes: Uint8Array,
  targetEpsg: number | null,
  options: GeoPackageOptions = {},
): Promise<ContextGeometry> {
  const { db, close } = await open(bytes);
  try {
    const layers = rows(db, `
      SELECT c.table_name AS name, g.column_name AS geom, g.geometry_type_name AS geometryType,
             s.organization AS authority, s.organization_coordsys_id AS code,
             s.definition AS definition
        FROM gpkg_contents c
        JOIN gpkg_geometry_columns g ON g.table_name = c.table_name
        LEFT JOIN gpkg_spatial_ref_sys s ON s.srs_id = g.srs_id
       WHERE c.data_type = 'features'
    `);
    if (!layers.length) throw new GeoPackageError("noFeatures");

    // With no IFC placement, keep a declared projected CRS where possible.
    // Geographic data needs metre coordinates, so use Web Mercator for a local preview.
    if (targetEpsg === null) {
      targetEpsg = layers.flatMap((layer) => {
        const crs = String(layer.authority).toUpperCase() === "EPSG" ? findCrs(Number(layer.code)) : null;
        return crs && !/\+proj=(longlat|latlong)\b/.test(crs.proj4) ? [crs.code] : [];
      })[0] ?? 3857;
    }
    const target = options.targetDefinition ?? findCrs(targetEpsg)?.proj4;
    if (!target || /\+proj=(longlat|latlong)\b/.test(target)) throw new GeoPackageError("unsupportedCrs");

    let targetClip: ClipBox | undefined;
    if (options.clip) {
      const { reference, radiusMetres: radius } = options.clip;
      if (!Number.isFinite(radius) || radius <= 0) throw new GeoPackageError("nothingNearby");
      const [x, y] = proj4(WGS84_PROJ4, target, [reference.longitude, reference.latitude]);
      targetClip = { minX: x - radius, maxX: x + radius, minY: y - radius, maxY: y + radius };
    }

    // Coplanar map layers share one mesh: draw water first so land stays visible.
    layers.sort((a, b) => Number(kindOf(String(b.name)) === "water") - Number(kindOf(String(a.name)) === "water"));
    const total = layers.reduce((count, layer) => count + Number(rows(db, `SELECT count(*) AS n FROM ${quote(String(layer.name))}`)[0].n), 0);
    const ready: Array<{ kind: string; triangles: ContextTriangle[]; feature: ContextFeature }> = [];
    let skippedObjects = 0, visited = 0, lastProgress = -1;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity;
    options.onProgress?.(0);

    for (const layer of layers) {
      let converter: proj4.Converter;
      let sourceClip: ClipBox | undefined;
      try {
        converter = proj4(layerDefinition(layer), target);
        sourceClip = targetClip ? transformClipBox(targetClip, (p) => {
          const [x, y] = converter.inverse([p[0], p[1]]);
          return [x, y, p[2]];
        }) : undefined;
      } catch {
        throw new GeoPackageError("unsupportedCrs");
      }
      const project = (p: WkbPoint): WkbPoint => {
        const [x, y] = converter.forward([p[0], p[1]]);
        return [x, y, p[2]];
      };
      const primaryKey = rows(db, `PRAGMA table_info(${quote(String(layer.name))})`).find((column) => Number(column.pk) === 1)?.name;
      let rowNumber = 0;
      db.exec({
        sql: `SELECT * FROM ${quote(String(layer.name))}`,
        rowMode: "object",
        callback: (feature) => {
          rowNumber++;
          const blob = feature[String(layer.geom)];
          const progress = Math.floor(++visited / Math.max(1, total) * 100);
          if (progress !== lastProgress) options.onProgress?.(lastProgress = progress);
          if (blob === null) return;
          if (!(blob instanceof Uint8Array)) { skippedObjects++; return; }
          let triangles: ContextTriangle[];
          try {
            const { wkb } = unwrapGeoPackageBlob(blob);
            triangles = contextTriangles(parseWkb(wkb), project, sourceClip, targetClip);
          } catch {
            skippedObjects++;
            return;
          }
          if (!triangles.length) return;
          for (const triangle of triangles) for (const [x, y, z] of triangle) {
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            minZ = Math.min(minZ, z);
          }
          const properties = Object.fromEntries(Object.entries(feature)
            .filter(([key]) => key !== layer.geom)
            .map(([key, value]) => [key, typeof value === "bigint" ? String(value)
              : value instanceof Uint8Array ? { bytes: value.byteLength } : value]));
          ready.push({ kind: kindOf(String(layer.name)), triangles,
            feature: { id: String(primaryKey ? feature[String(primaryKey)] : rowNumber),
              type: String(layer.geometryType), source: "GeoPackage", layer: String(layer.name),
              name: contextFeatureName(properties), properties } });
        },
      });
    }
    if (!ready.length) throw new GeoPackageError(options.clip && skippedObjects === 0 ? "nothingNearby" : "noGeometry");
    const origin = { easting: (minX + maxX) / 2, northing: (minY + maxY) / 2, height: minZ };
    const builder = new GeometryBuilder();
    const counts = new Map<string, number>();
    for (const { kind, triangles, feature } of ready) {
      const firstTriangle = builder.triangleCount;
      for (const [a, b, c] of triangles) builder.triangle(a, b, c, COLOURS[kind] ?? DEFAULT_COLOUR, origin);
      builder.addFeature(feature, firstTriangle);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    options.onProgress?.(100);
    return {
      ...builder.finish(), origin, epsg: targetEpsg, objectCount: ready.length,
      types: [...counts].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
      sizeMetres: Math.max(maxX - minX, maxY - minY), skippedObjects,
    };
  } finally {
    close();
  }
}
