import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import pt from "@/messages/pt.json";
import type { GeoreferenceView } from "@/lib/ifc/types";
import { gradeGeoreferencing } from "../logeoref";

/**
 * The LoGeoRef report's sentences are built from keys, and a key with no words
 * in one language shows the English sentence under a Portuguese interface —
 * which is how this was found. So every situation the grader can produce is run
 * through it, and each key it emits must have words in both catalogues.
 */

const FULL: GeoreferenceView = {
  hasGeoreference: true,
  source: "mapConversion",
  site: { latitude: 41.5512, longitude: -8.4214, elevation: 190 },
  context: { expressId: 15, worldCoordinateSystem: [0, 0, 0], trueNorth: [0, 1], trueNorthDegrees: 0 },
  mapConversion: { eastings: -40000, northings: 180000, orthogonalHeight: 190, scale: 1 },
  projectedCRS: { name: "EPSG:3763", description: "ETRS89 / Portugal TM06" },
  lengthUnitScale: 1,
};

const CASES: Array<[string, Partial<GeoreferenceView>]> = [
  ["full", {}],
  ["nothing", { site: undefined, context: undefined, mapConversion: undefined, projectedCRS: undefined }],
  ["null island", { site: { latitude: 0, longitude: 0, elevation: 190 } }],
  ["out of range", { site: { latitude: 120, longitude: 400, elevation: 190 } }],
  ["no elevation", { site: { latitude: 41.5, longitude: -8.4 } }],
  ["offset wcs", { context: { expressId: 1, worldCoordinateSystem: [1, 2, 3], trueNorth: [0, 1] } }],
  ["no wcs", { context: { expressId: 1, trueNorth: [0, 1] } }],
  ["no true north", { context: { expressId: 1, worldCoordinateSystem: [0, 0, 0] } }],
  ["zero true north", { context: { expressId: 1, worldCoordinateSystem: [0, 0, 0], trueNorth: [0, 0] } }],
  ["true north without degrees", { context: { expressId: 1, worldCoordinateSystem: [0, 0, 0], trueNorth: [1, 1] } }],
  ["trivial conversion", { mapConversion: { eastings: 0, northings: 0, orthogonalHeight: 0 } }],
  ["scaled conversion", { mapConversion: { eastings: 1, northings: 2, orthogonalHeight: 0, scale: 2 } }],
  ["unrecognised crs", { projectedCRS: { name: "my own grid" } }],
];

const lookup = (catalogue: unknown, path: string) =>
  path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], catalogue);

describe("LoGeoRef sentences in both languages", () => {
  const checksFor = CASES.flatMap(([name, patch]) =>
    gradeGeoreferencing({ ...FULL, ...patch }).checks.map((check) => ({ name, check })),
  );

  it("exercises every situation the grader names", () => {
    const keys = new Set(checksFor.map(({ check }) => check.key).filter(Boolean));
    expect(keys.size).toBeGreaterThanOrEqual(16);
  });

  it.each([["en", en], ["pt", pt]] as const)("has words for each key in %s", (_, catalogue) => {
    const base = "viewer.georefPanel.reportPanel.checks";
    for (const { name, check } of checksFor) {
      if (!check.key) continue;
      expect(lookup(catalogue, `${base}.${check.key}.detail`), `${name}: ${check.key} detail`).toEqual(expect.any(String));
      if (check.remedy) {
        expect(lookup(catalogue, `${base}.${check.key}.remedy`), `${name}: ${check.key} remedy`).toEqual(expect.any(String));
      }
    }
  });

  it("names every level in both languages", () => {
    for (const catalogue of [en, pt]) {
      for (const level of [0, 20, 30, 40, 50]) {
        expect(lookup(catalogue, `viewer.georefPanel.reportPanel.levels.${level}`)).toEqual(expect.any(String));
      }
    }
  });

  it("does not leave a check with a sentence but no key", () => {
    // Passing checks whose detail is only values (coordinates, an EPSG code) need no words.
    const wordy = checksFor.filter(({ check }) => !check.key && /[a-z]{4,} [a-z]{3,}/i.test(check.detail) && !/^(E |EPSG:|\d)/.test(check.detail));
    expect(wordy.map(({ name, check }) => `${name}: ${check.id}: ${check.detail}`)).toEqual([]);
  });
});
