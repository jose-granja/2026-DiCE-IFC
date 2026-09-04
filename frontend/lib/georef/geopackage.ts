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

import { mapToWgs84, wgs84ToMap } from "./transform";
import {
  fanTriangles,
  GeometryBuilder,
  type ContextGeometry,
} from "./context-geometry";
import { parseWkb, unwrapGeoPackageBlob, type WkbPoint } from "./wkb";

export class GeoPackageError extends Error {}

const COLOURS: Record<string, [number, number, number]> = {
  building: [0.62, 0.64, 0.68],
  road: [0.42, 0.42, 0.45],
  water: [0.35, 0.48, 0.62],
  vegetation: [0.44, 0.56, 0.42],
  parcel: [0.5, 0.5, 0.46],
};
const DEFAULT_COLOUR: [number, number, number] = [0.55, 0.56, 0.6];

const LINE_WIDTH = 1.5;
const POINT_SIZE = 1.5;

/** Guess a kind from the table's name, for colour only. */
function kindOf(table: string): string {
  const name = table.toLowerCase();
  if (/build|edific|predio/.test(name)) return "building";
  if (/road|street|rua|estrada|via|high/.test(name)) return "road";
  if (/water|rio|agua|lake/.test(name)) return "water";
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
  })();

  return sqlitePromise;
}

/** Open a GeoPackage's bytes as an in-memory database. */
async function open(bytes: Uint8Array): Promise<{ db: SqliteDb; close: () => void }> {
  const engine = await sqlite();

  if (bytes.length < 16 || new TextDecoder().decode(bytes.subarray(0, 15)) !== "SQLite format 3") {
    throw new GeoPackageError(
      "That file is not a GeoPackage — a GeoPackage is a SQLite database, and this does not start like one.",
    );
  }

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
    throw new GeoPackageError("SQLite could not open that file.");
  }

  return { db, close: () => db.close() };
}

function rows(db: SqliteDb, sql: string): Record<string, unknown>[] {
  return db.exec({ sql, rowMode: "object", returnValue: "resultRows" }) as unknown as Record<
    string,
    unknown
  >[];
}

export async function parseGeoPackage(
  bytes: Uint8Array,
  targetEpsg: number,
): Promise<ContextGeometry> {
  const { db, close } = await open(bytes);

  try {
    // The schema says where the data is. Joined so a table with no declared
    // geometry column is skipped rather than guessed at.
    const layers = rows(
      db,
      `SELECT c.table_name AS name, g.column_name AS geom, g.srs_id AS srs
         FROM gpkg_contents c
         JOIN gpkg_geometry_columns g ON g.table_name = c.table_name
        WHERE c.data_type = 'features'`,
    );

    if (layers.length === 0) {
      throw new GeoPackageError(
        "This GeoPackage has no feature tables — it may hold only tiles or attributes.",
      );
    }

    type Ready = { kind: string; polygons: WkbPoint[][][]; lines: WkbPoint[][]; points: WkbPoint[] };
    const ready: Ready[] = [];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (const layer of layers) {
      const table = String(layer.name);
      const column = String(layer.geom);
      const srsId = Number(layer.srs);

      const reproject =
        !Number.isFinite(srsId) || srsId === targetEpsg || srsId === 0
          ? null
          : (point: WkbPoint): WkbPoint => {
              const wgs = mapToWgs84(
                { easting: point[0], northing: point[1], height: point[2] },
                srsId,
              );
              const map = wgs84ToMap(wgs, targetEpsg);
              return [map.easting, map.northing, point[2]];
            };

      // Quoted: table and column names in the wild contain spaces and hyphens.
      const features = rows(
        db,
        `SELECT "${column.replace(/"/g, '""')}" AS g FROM "${table.replace(/"/g, '""')}"`,
      );

      for (const feature of features) {
        const blob = feature.g;
        if (!(blob instanceof Uint8Array)) continue;

        let geometry;
        try {
          const { wkb } = unwrapGeoPackageBlob(blob);
          geometry = parseWkb(wkb);
        } catch {
          // One unreadable row must not lose the layer.
          continue;
        }

        const fix = (points: WkbPoint[]) =>
          reproject ? points.map(reproject) : points;

        const entry: Ready = {
          kind: kindOf(table),
          polygons: geometry.polygons.map((rings) => rings.map(fix)),
          lines: geometry.lines.map(fix),
          points: fix(geometry.points),
        };

        for (const group of [
          ...entry.polygons.flat(),
          ...entry.lines,
          [...entry.points],
        ]) {
          for (const [x, y, z] of group) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
          }
        }

        ready.push(entry);
      }
    }

    if (ready.length === 0) {
      throw new GeoPackageError(
        "No geometry could be read from this GeoPackage's feature tables.",
      );
    }

    const origin = {
      easting: (minX + maxX) / 2,
      northing: (minY + maxY) / 2,
      height: Number.isFinite(minZ) ? minZ : 0,
    };

    const builder = new GeometryBuilder();
    const counts = new Map<string, number>();
    let objectCount = 0;

    for (const entry of ready) {
      const colour = COLOURS[entry.kind] ?? DEFAULT_COLOUR;
      const before = builder.triangleCount;

      for (const rings of entry.polygons) {
        // Exterior only; holes are dropped rather than fanned.
        const ring = rings[0];
        if (!ring || ring.length < 3) continue;
        for (const [a, b, c] of fanTriangles(ring)) {
          builder.triangle(a, b, c, colour, origin);
        }
      }

      for (const line of entry.lines) {
        for (let i = 0; i + 1 < line.length; i += 1) {
          const [ax, ay, az] = line[i];
          const [bx, by] = line[i + 1];
          const dx = bx - ax;
          const dy = by - ay;
          const length = Math.hypot(dx, dy);
          if (length === 0) continue;
          const nx = (-dy / length) * (LINE_WIDTH / 2);
          const ny = (dx / length) * (LINE_WIDTH / 2);
          builder.triangle(
            [ax + nx, ay + ny, az],
            [ax - nx, ay - ny, az],
            [bx - nx, by - ny, az],
            colour,
            origin,
          );
          builder.triangle(
            [ax + nx, ay + ny, az],
            [bx - nx, by - ny, az],
            [bx + nx, by + ny, az],
            colour,
            origin,
          );
        }
      }

      for (const [x, y, z] of entry.points) {
        const half = POINT_SIZE / 2;
        builder.triangle([x - half, y - half, z], [x + half, y - half, z], [x + half, y + half, z], colour, origin);
        builder.triangle([x - half, y - half, z], [x + half, y + half, z], [x - half, y + half, z], colour, origin);
      }

      if (builder.triangleCount > before) {
        objectCount += 1;
        counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
      }
    }

    if (builder.triangleCount === 0) {
      throw new GeoPackageError("Nothing in this GeoPackage could be drawn.");
    }

    const { positions, colours } = builder.finish();

    return {
      positions,
      colours,
      origin,
      epsg: targetEpsg,
      objectCount,
      types: [...counts.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count),
      sizeMetres: Math.max(maxX - minX, maxY - minY),
    };
  } finally {
    close();
  }
}
