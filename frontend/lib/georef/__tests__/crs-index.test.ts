import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { findCrs, indexedCrsCount, isWithinBounds, resolveCrsByName, searchCrs } from "@/config/epsg";
import { applyDatumOverride, classifyAccuracy } from "@/config/crs-overrides";
import { registerCrsRows, toDefinition } from "../crs-index";
import { siteDisagreement } from "../logeoref";
import { isSupportedCrs, mapToWgs84, wgs84ToMap } from "../transform";

const index = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../public/crs-index.json"), "utf8"),
) as { rows: Parameters<typeof toDefinition>[0][] };

describe("the full EPSG index", () => {
  it("is not available until it is registered", () => {
    expect(isSupportedCrs(31370)).toBe(false);
    expect(findCrs(31370)).toBeNull();
  });

  describe("once registered", () => {
    beforeAll(() => registerCrsRows(index.rows));

    it("carries thousands of systems besides the curated ones", () => {
      expect(indexedCrsCount()).toBeGreaterThan(5000);
    });

    it("finds a system by code, and keeps curated entries ahead of indexed ones", () => {
      expect(findCrs(31370)?.label).toMatch(/Belgian Lambert 72/);
      expect(findCrs(3763)?.label).toBe("ETRS89 / Portugal TM06");
      expect(findCrs(3763)?.region).toBe("Portugal (mainland)");
    });

    it("searches code, name and area, with every word required", () => {
      expect(searchCrs("31370")[0].code).toBe(31370);
      const results = searchCrs("utm zone 29n");
      expect(results.some((crs) => crs.code === 25829)).toBe(true);
      expect(searchCrs("belgium lambert").every((crs) => /lambert/i.test(crs.label))).toBe(true);
    });

    it("caps how many indexed results one search returns", () => {
      expect(searchCrs("zone").filter((crs) => crs.region === "EPSG registry").length).toBeLessThanOrEqual(100);
    });

    it("lists only the curated systems for an empty search", () => {
      expect(searchCrs("").every((crs) => crs.region !== "EPSG registry")).toBe(true);
    });

    it("transforms with an indexed system", () => {
      // Brussels Grand-Place in Belgian Lambert 72.
      const wgs = mapToWgs84({ easting: 148_500, northing: 170_500 }, 31370);
      expect(wgs.longitude).toBeCloseTo(4.35, 1);
      expect(wgs.latitude).toBeCloseTo(50.85, 1);
      const back = wgs84ToMap(wgs, 31370);
      expect(back.easting).toBeCloseTo(148_500, 0);
      expect(back.northing).toBeCloseTo(170_500, 0);
    });

    it("recognises an exact EPSG name from an IFC file", () => {
      expect(resolveCrsByName("ETRS89 / UTM zone 29N")).toBe(25829);
      expect(resolveCrsByName("not a crs")).toBeNull();
    });
  });
});

describe("vertical systems", () => {
  beforeAll(() => {
    // Mirror what `loadCrsIndex` does with the file's `vertical` rows.
    (globalThis as { fetch?: unknown }).fetch = async () => ({
      ok: true,
      json: async () => JSON.parse(readFileSync(path.resolve(__dirname, "../../../public/crs-index.json"), "utf8")),
    });
  });

  it("finds EPSG vertical systems and resolves an identifier to its name", async () => {
    const { loadCrsIndex, searchVerticalCrs, findVerticalCrs } = await import("../crs-index");
    expect(await loadCrsIndex()).toBe(true);
    expect(searchVerticalCrs("cascais")[0]).toMatchObject({ code: 5780, name: "Cascais height" });
    expect(searchVerticalCrs("5780")[0].code).toBe(5780);
    expect(findVerticalCrs("EPSG:5780")?.name).toBe("Cascais height");
    expect(findVerticalCrs("epsg:5780 ")?.code).toBe(5780);
    expect(findVerticalCrs("Cascais")).toBeNull();
  });
});

describe("area of use", () => {
  it("is south, west, north, east, so a point inside the area passes", () => {
    const rd = toDefinition(index.rows.find((row) => row[0] === 28992)!);
    expect(rd.bounds!.south).toBeLessThan(rd.bounds!.north);
    expect(rd.bounds!.west).toBeLessThan(rd.bounds!.east);
    // Rotterdam, where the MiniBIM model sits.
    expect(isWithinBounds(rd, 4.456, 51.903)).toBe(true);
    expect(isWithinBounds(rd, 4.456, 41.5)).toBe(false);
  });

  it("holds for every indexed system", () => {
    for (const row of index.rows) {
      const { bounds } = toDefinition(row);
      if (bounds) expect(bounds.south).toBeLessThanOrEqual(bounds.north);
    }
  });
});

describe("IfcSite versus IfcMapConversion", () => {
  beforeAll(() => registerCrsRows(index.rows));

  // The MiniBIM example: map conversion at RD 90770 / 435320, and IfcSite
  // latitude/longitude 51°54′9.635″ N 4°27′14.020″ E — the same place.
  const view = (latitude: number, longitude: number) => ({
    hasGeoreference: true,
    mapConversion: { eastings: 90770, northings: 435320, orthogonalHeight: 3.5 },
    projectedCRS: { name: "EPSG:28992" },
    site: { latitude, longitude },
  });

  it("agrees for the MiniBIM file once RD New is interpreted correctly", () => {
    expect(siteDisagreement(view(51.90267650305555, 4.453894484166667))).toBeNull();
  });

  it("reports a file whose two positions are far apart", () => {
    // ~160 m west and ~65 m south of the map conversion's origin.
    const result = siteDisagreement(view(51.9027, 4.4539 - 0.0013));
    expect(result).not.toBeNull();
    expect(result!.metres).toBeGreaterThan(50);
    expect(result!.bearingDegrees).toBeGreaterThan(200);
    expect(result!.bearingDegrees).toBeLessThan(290);
  });

  it("stays quiet when a piece is missing", () => {
    expect(siteDisagreement({ hasGeoreference: true, site: { latitude: 1, longitude: 1 } })).toBeNull();
    expect(siteDisagreement({ ...view(51.9, 4.4), projectedCRS: { name: "not a crs" } })).toBeNull();
  });
});

describe("datum shifts", () => {
  beforeAll(() => registerCrsRows(index.rows));

  it("places the Onze Lieve Vrouwetoren in Amersfoort where it really is", () => {
    // The reference point of RD New: RD (155000, 463000) = 52.155172 N, 5.387206 E.
    const wgs = mapToWgs84({ easting: 155000, northing: 463000 }, 28992);
    expect(wgs.latitude).toBeCloseTo(52.155172, 4); // ~10 m
    expect(wgs.longitude).toBeCloseTo(5.387206, 4);
  });

  it("puts the MiniBIM model's map conversion on its own IfcSite coordinates", () => {
    const wgs = mapToWgs84({ easting: 90770, northing: 435320 }, 28992);
    expect(wgs.latitude).toBeCloseTo(51.9026765, 4);
    expect(wgs.longitude).toBeCloseTo(4.4538945, 4);
  });

  it("never returns NaN for a system the index offers", () => {
    for (const code of [28992, 31370, 27700, 31467, 25832, 2154, 3763, 32632]) {
      if (!findCrs(code)) continue;
      const wgs = mapToWgs84({ easting: 500000, northing: 5_000_000 }, code);
      expect(Number.isNaN(wgs.latitude)).toBe(false);
    }
  });

  it("offers neither a grid-dependent system nor claims it can transform it", () => {
    // BETA2007.gsb systems other than the overridden DHDN zones, e.g. 5650.
    expect(findCrs(31466)?.accuracy).toBe("approximate");
    expect(classifyAccuracy("+proj=tmerc +ellps=bessel +nadgrids=BETA2007.gsb +units=m")).toBe("grid");
  });

  it("classifies how far a transform can be trusted", () => {
    expect(classifyAccuracy("+proj=utm +zone=29 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0")).toBe("exact");
    expect(classifyAccuracy("+proj=tmerc +ellps=bessel +towgs84=1,2,3,0,0,0,0")).toBe("approximate");
    expect(classifyAccuracy("+proj=tmerc +ellps=bessel +units=m")).toBe("uncertain");
  });

  it("swaps a datum shift without losing the rest of the definition", () => {
    const out = applyDatumOverride(31467, "+proj=tmerc +ellps=bessel +nadgrids=BETA2007.gsb +units=m +no_defs");
    expect(out).toContain("+towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7");
    expect(out).not.toContain("nadgrids");
    expect(out).toContain("+proj=tmerc");
  });
});
