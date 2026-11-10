import { describe, expect, it } from "vitest";

import type { CoordinateInfo, GeoreferenceView } from "@/lib/ifc/types";
import { gridConvergence } from "@/lib/georef/transform";
import { renderSunAngles, solarPosition, sunPlaceOf, zonedTimeToUtc } from "../sun";

const LISBON = { latitude: 38.7223, longitude: -9.1393 };

/** The UTC instant of solar noon at `longitude` on a day, found by searching for the highest sun. */
function highestSun(day: string, latitude: number, longitude: number) {
  let best = { minutes: 0, elevation: -90, azimuth: 0 };
  for (let minutes = 0; minutes < 1440; minutes += 1) {
    const when = new Date(Date.parse(`${day}T00:00:00Z`) + minutes * 60_000);
    const { elevation, azimuth } = solarPosition(when, latitude, longitude);
    if (elevation > best.elevation) best = { minutes, elevation, azimuth };
  }
  return best;
}

describe("solar position", () => {
  it("is due south at noon in the north, as high as latitude and solstice say", () => {
    const noon = highestSun("2024-06-20", LISBON.latitude, LISBON.longitude);
    // 90° − latitude + 23.44° at the June solstice.
    expect(noon.elevation).toBeCloseTo(90 - LISBON.latitude + 23.44, 0);
    expect(Math.abs(noon.azimuth - 180)).toBeLessThan(2);
    // Lisbon's solar noon is about 12:37 UTC in June (its longitude, less the equation of time).
    expect(Math.abs(noon.minutes - (12 * 60 + 37))).toBeLessThanOrEqual(3);
  });

  it("is due north at noon in the south", () => {
    const noon = highestSun("2024-12-21", -33.87, 151.21); // Sydney
    expect(noon.elevation).toBeCloseTo(90 - 33.87 + 23.44, 0);
    expect(Math.min(noon.azimuth, 360 - noon.azimuth)).toBeLessThan(2);
  });

  it("is overhead at the equator at an equinox noon", () => {
    expect(highestSun("2024-03-20", 0, 0).elevation).toBeGreaterThan(89.5);
  });

  it("rises in the east and sets in the west, and is down at night", () => {
    const morning = solarPosition(new Date("2024-06-21T06:00:00Z"), LISBON.latitude, LISBON.longitude);
    expect(morning.elevation).toBeGreaterThan(0);
    expect(morning.azimuth).toBeGreaterThan(45);
    expect(morning.azimuth).toBeLessThan(90);
    const evening = solarPosition(new Date("2024-06-21T19:30:00Z"), LISBON.latitude, LISBON.longitude);
    expect(evening.azimuth).toBeGreaterThan(270);
    expect(evening.azimuth).toBeLessThan(315);
    expect(solarPosition(new Date("2024-06-21T00:00:00Z"), LISBON.latitude, LISBON.longitude).elevation).toBeLessThan(-20);
  });
});

describe("site time", () => {
  it("reads the clocks of the site's time zone, summer time included", () => {
    expect(zonedTimeToUtc("2024-07-01", "12:00", "Europe/Lisbon")?.toISOString()).toBe("2024-07-01T11:00:00.000Z");
    expect(zonedTimeToUtc("2024-01-15", "12:00", "Europe/Lisbon")?.toISOString()).toBe("2024-01-15T12:00:00.000Z");
    expect(zonedTimeToUtc("2024-01-15", "12:00", "Asia/Kolkata")?.toISOString()).toBe("2024-01-15T06:30:00.000Z");
    expect(zonedTimeToUtc("2024-01-15", "09:30", "America/New_York")?.toISOString()).toBe("2024-01-15T14:30:00.000Z");
  });

  it("refuses what does not parse", () => {
    expect(zonedTimeToUtc("15/01/2024", "12:00", "UTC")).toBeNull();
    expect(zonedTimeToUtc("2024-01-15", "noon", "UTC")).toBeNull();
  });
});

const COORDINATES = {
  originShift: [0, 0, 0],
  originalBounds: { min: [0, 0, 0], max: [1, 1, 1] },
  shiftedBounds: { min: [0, 0, 0], max: [1, 1, 1] },
  shifted: false,
} as unknown as CoordinateInfo;

const model = (georeference: GeoreferenceView, rotationY = 0) => ({
  id: "m",
  coordinates: COORDINATES,
  georeference,
  rotationY,
});

describe("the model's place", () => {
  it("has none without a map conversion or a site location", () => {
    expect(sunPlaceOf(model({ hasGeoreference: false }))).toBeNull();
    // A placeholder map conversion at 0, 0 is not a place.
    expect(
      sunPlaceOf(model({ hasGeoreference: true, mapConversion: { eastings: 0, northings: 0, orthogonalHeight: 0 }, projectedCRS: { name: "EPSG:3763" } })),
    ).toBeNull();
  });

  it("reads the site, with north along the model's +y unless TrueNorth says otherwise", () => {
    const site = { hasGeoreference: true, site: { latitude: 41.15, longitude: -8.61 } } as GeoreferenceView;
    const place = sunPlaceOf(model(site));
    expect(place).toMatchObject({ latitude: 41.15, longitude: -8.61, source: "site" });
    // IFC +y is the viewer's −z.
    expect(place && place !== "needsCrsIndex" && place.north[0]).toBeCloseTo(0);
    expect(place && place !== "needsCrsIndex" && place.north[1]).toBeCloseTo(-1);

    const turned = sunPlaceOf(model({ ...site, context: { expressId: 1, trueNorth: [2, 0] } }));
    expect(turned && turned !== "needsCrsIndex" && turned.north[0]).toBeCloseTo(1);
    expect(turned && turned !== "needsCrsIndex" && turned.north[1]).toBeCloseTo(0);
  });

  it("turns north with the model when the federation turns it", () => {
    const place = sunPlaceOf(model({ hasGeoreference: true, site: { latitude: 41.15, longitude: -8.61 } }, Math.PI / 2));
    expect(place && place !== "needsCrsIndex" && place.north[0]).toBeCloseTo(-1);
    expect(place && place !== "needsCrsIndex" && place.north[1]).toBeCloseTo(0);
  });

  it("finds a map-converted model on the earth, with true north off grid north by the convergence", () => {
    // Lisbon in PT-TM06, west of the projection's central meridian.
    const conversion = { eastings: -87_000, northings: -106_000, orthogonalHeight: 0 };
    const place = sunPlaceOf(model({ hasGeoreference: true, mapConversion: conversion, projectedCRS: { name: "EPSG:3763" } }));
    if (!place || place === "needsCrsIndex") throw new Error("no place");
    expect(place.source).toBe("mapConversion");
    expect(place.latitude).toBeCloseTo(38.7, 0);
    expect(place.longitude).toBeCloseTo(-9.1, 0);
    const gamma = gridConvergence({ easting: conversion.eastings, northing: conversion.northings }, 3763);
    expect(Math.abs(gamma)).toBeGreaterThan(0.005);
    // Grid north is the viewer's −z; true north is γ anticlockwise of it.
    expect(place.north[0]).toBeCloseTo(-Math.sin(gamma), 6);
    expect(place.north[1]).toBeCloseTo(-Math.cos(gamma), 6);

    // A map conversion that turns the model's plan by θ is turned back by the
    // federation (rotationY = θ): north lands in the same place.
    const theta = (30 * Math.PI) / 180;
    const rotated = sunPlaceOf(
      model(
        {
          hasGeoreference: true,
          mapConversion: { ...conversion, xAxisAbscissa: Math.cos(theta), xAxisOrdinate: Math.sin(theta) },
          projectedCRS: { name: "EPSG:3763" },
        },
        theta,
      ),
    );
    if (!rotated || rotated === "needsCrsIndex") throw new Error("no place");
    expect(rotated.north[0]).toBeCloseTo(place.north[0], 6);
    expect(rotated.north[1]).toBeCloseTo(place.north[1], 6);
  });
});

describe("the sun in the viewer's frame", () => {
  // North along −z, so east is +x, and the renderer's angle runs from +z toward +x.
  const north: [number, number] = [0, -1];

  it("puts an eastern sun on +x, a southern one on +z and a northern one on −z", () => {
    expect(renderSunAngles({ azimuth: 90, elevation: 30 }, north)).toEqual({ azimuth: 90, elevation: 30 });
    expect(renderSunAngles({ azimuth: 180, elevation: 30 }, north).azimuth).toBeCloseTo(0);
    expect(renderSunAngles({ azimuth: 0, elevation: 30 }, north).azimuth).toBeCloseTo(180);
    expect(renderSunAngles({ azimuth: 270, elevation: 30 }, north).azimuth).toBeCloseTo(270);
  });

  it("follows north when the model is turned", () => {
    // North along +x: an eastern sun is then along +z.
    expect(renderSunAngles({ azimuth: 90, elevation: 10 }, [1, 0]).azimuth).toBeCloseTo(0);
  });
});
