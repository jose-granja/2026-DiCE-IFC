"use client";

/**
 * The full EPSG registry, loaded on demand.
 *
 * `public/crs-index.json` is built from the `epsg-index` package by
 * `npm run build:crs` and served same-origin, so no CRS lookup ever leaves the
 * browser (nothing about where a project is — see AGENTS.md §1). It is ~1.8 MB
 * (~300 KB compressed), so it is fetched the first time something needs a CRS
 * the curated list in `config/epsg.ts` does not have, not at page load.
 */

import { useEffect, useState } from "react";

import { registerIndexedCrs, type CrsDefinition } from "@/config/epsg";
import { ACCURACY_CODES } from "@/config/crs-overrides";

export const CRS_INDEX_URL = "/crs-index.json";

/** `[code, name, proj4, south, west, north, east, area, accuracy]`, as written by the build script. */
type Row = [
  number,
  string,
  string,
  number | null,
  number | null,
  number | null,
  number | null,
  string,
  number,
];

/** A vertical CRS, as offered for `IfcProjectedCRS.VerticalDatum`. */
export type VerticalCrs = { code: number; name: string; area: string };

let vertical: VerticalCrs[] = [];
let verticalHaystack: string[] = [];

let loaded = false;
let pending: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

export function toDefinition([code, name, proj4, south, west, north, east, area, accuracy]: Row): CrsDefinition {
  return {
    code,
    name: `EPSG:${code}`,
    label: name,
    proj4,
    geodeticDatum: name.split(" / ")[0],
    region: "EPSG registry",
    bounds:
      south === null || west === null || north === null || east === null
        ? undefined
        : { west, south, east, north },
    aliases: area ? [area] : undefined,
    accuracy: ACCURACY_CODES[accuracy] === "grid" ? undefined : ACCURACY_CODES[accuracy] as CrsDefinition["accuracy"],
  };
}

/**
 * Register the index's projected rows. Systems that need a datum-shift grid
 * file are left out: proj4 cannot load one here and would return NaN.
 */
export function registerCrsRows(rows: Row[]) {
  registerIndexedCrs(rows.filter((row) => ACCURACY_CODES[row[8]] !== "grid").map(toDefinition));
}

export function isCrsIndexLoaded(): boolean {
  return loaded;
}

/** Resolves true once the index is registered, false if it could not be fetched. */
export function loadCrsIndex(): Promise<boolean> {
  if (loaded) return Promise.resolve(true);
  pending ??= (async () => {
    try {
      const response = await fetch(CRS_INDEX_URL);
      if (!response.ok) return false;
      const data = (await response.json()) as {
        rows: Row[];
        vertical?: Array<[number, string, string]>;
      };
      // Systems that need a datum-shift grid file cannot be transformed here
      // (proj4 would return NaN), so they are not offered at all.
      registerCrsRows(data.rows);
      vertical = (data.vertical ?? []).map(([code, name, area]) => ({ code, name, area }));
      verticalHaystack = vertical.map((crs) => `${crs.code} ${crs.name} ${crs.area}`.toLowerCase());
      loaded = true;
      for (const listener of listeners) listener();
      return true;
    } catch {
      return false;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

/** The vertical system an `EPSG:5780`-style identifier names, once the index is loaded. */
export function findVerticalCrs(identifier: string): VerticalCrs | null {
  const match = /^\s*EPSG:(\d{4,6})\s*$/i.exec(identifier);
  if (!match) return null;
  const code = Number(match[1]);
  return vertical.find((crs) => crs.code === code) ?? null;
}

/** Vertical systems matching every word of `query`, exact code and name-prefix first. */
export function searchVerticalCrs(query: string, limit = 60): VerticalCrs[] {
  const needle = query.trim().toLowerCase();
  const words = needle.split(/\s+/).filter(Boolean);
  const hits: Array<{ crs: VerticalCrs; rank: number }> = [];
  for (let index = 0; index < vertical.length; index += 1) {
    if (!words.every((word) => verticalHaystack[index].includes(word))) continue;
    const crs = vertical[index];
    hits.push({
      crs,
      rank: String(crs.code) === needle ? 0 : crs.name.toLowerCase().startsWith(needle) ? 1 : 2,
    });
  }
  hits.sort((a, b) => a.rank - b.rank || a.crs.name.localeCompare(b.crs.name));
  return hits.slice(0, limit).map((hit) => hit.crs);
}

/**
 * Starts loading the index when `enabled` and re-renders the caller once it is
 * there, so a picker can show the full list without owning the fetch.
 */
export function useCrsIndex(enabled = true): boolean {
  const [ready, setReady] = useState(loaded);

  useEffect(() => {
    const update = () => setReady(loaded);
    listeners.add(update);
    update();
    if (enabled) void loadCrsIndex();
    return () => {
      listeners.delete(update);
    };
  }, [enabled]);

  return ready;
}
