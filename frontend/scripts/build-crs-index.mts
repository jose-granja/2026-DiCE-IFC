/**
 * Regenerate `public/crs-index.json` from the `epsg-index` package.
 *
 *   npm run build:crs
 *
 * Every projected EPSG CRS that has a usable proj4 definition and is not
 * deprecated, in one static file the Geo panel fetches (same-origin) the first
 * time someone searches beyond the curated list in `config/epsg.ts`. Bundled
 * rather than looked up from epsg.io: a lookup per CRS would say roughly where
 * the project is, which the privacy line forbids.
 *
 * Row layout (kept in step with `lib/georef/crs-index.ts`):
 *   rows:     [code, name, proj4, south, west, north, east, area, accuracy]
 *             accuracy indexes `ACCURACY_CODES` in `config/crs-overrides.ts`;
 *             datum shifts are corrected there (see the note at its head)
 *   vertical: [code, name, area]   vertical systems, for the
 *             `IfcProjectedCRS.VerticalDatum` field
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { ACCURACY_CODES, applyDatumOverride, classifyAccuracy } from "../config/crs-overrides";

type Source = {
  code: string;
  kind: string;
  name: string;
  proj4?: string;
  deprecated?: boolean;
  bbox?: [number, number, number, number];
  area?: string;
};

const require = createRequire(import.meta.url);
const all: Record<string, Source> = JSON.parse(
  await readFile(require.resolve("epsg-index/all.json"), "utf8"),
);
const version: string = JSON.parse(
  await readFile(require.resolve("epsg-index/package.json"), "utf8"),
).version;

const round = (value: number) => Math.round(value * 100) / 100;

const rows = Object.values(all)
  .filter((crs) => crs.kind === "CRS-PROJCRS" && crs.proj4 && !crs.deprecated)
  .sort((a, b) => Number(a.code) - Number(b.code))
  .map((crs) => {
    const code = Number(crs.code);
    const proj4 = applyDatumOverride(code, crs.proj4!.replace(/\s*\+type=crs/, ""));
    return { crs, code, proj4 };
  })
  .map(({ crs, code, proj4 }) => [
    code,
    crs.name,
    proj4,
    // epsg-index lists the area as [north, west, south, east]; the row wants
    // south, west, north, east.
    ...(crs.bbox
      ? [crs.bbox[2], crs.bbox[1], crs.bbox[0], crs.bbox[3]].map(round)
      : [null, null, null, null]),
    (crs.area ?? "").replace(/\.$/, ""),
    ACCURACY_CODES.indexOf(classifyAccuracy(proj4)),
  ]);

const vertical = Object.values(all)
  .filter((crs) => crs.kind === "CRS-VERTCRS" && !crs.deprecated)
  .sort((a, b) => Number(a.code) - Number(b.code))
  .map((crs) => [
    Number(crs.code),
    crs.name,
    (crs.area ?? "").replace(/\.$/, ""),
  ]);

const target = path.resolve(import.meta.dirname, "../public/crs-index.json");
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, JSON.stringify({ source: `epsg-index@${version}`, rows, vertical }));

console.log(`Wrote ${rows.length} projected and ${vertical.length} vertical CRS definitions to ${path.relative(process.cwd(), target)}`);
