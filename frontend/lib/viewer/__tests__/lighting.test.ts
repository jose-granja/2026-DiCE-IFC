import { describe, expect, it } from "vitest";

import { DEFAULT_SUN_AZIMUTH, isLightPreset, LIGHT_PRESETS, LIGHT_RIGS, sunDirection } from "../lighting";

describe("sun direction", () => {
  it("is overhead at 90° and on the horizon at 0°", () => {
    const [x, y, z] = sunDirection(123, 90);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(1);
    expect(z).toBeCloseTo(0);
    expect(sunDirection(0, 0)[1]).toBeCloseTo(0);
  });

  it("turns from +Z toward +X", () => {
    const north = sunDirection(0, 0);
    const east = sunDirection(90, 0);
    expect(north[2]).toBeCloseTo(1);
    expect(east[0]).toBeCloseTo(1);
  });

  it("is unit length", () => {
    for (const [azimuth, elevation] of [[0, 10], [200, 45], [355, 89]]) {
      expect(Math.hypot(...sunDirection(azimuth, elevation))).toBeCloseTo(1);
    }
  });

  it("puts the studio's default sun where IFC Lite's is", () => {
    const [x, y, z] = sunDirection(DEFAULT_SUN_AZIMUTH, LIGHT_RIGS.studio.elevation);
    const ifcLite = [0.5, 1, 0.3];
    const length = Math.hypot(...ifcLite);
    expect(x).toBeCloseTo(ifcLite[0] / length, 1);
    expect(y).toBeCloseTo(ifcLite[1] / length, 1);
    expect(z).toBeCloseTo(ifcLite[2] / length, 1);
  });
});

describe("light rigs", () => {
  it("has a rig for every preset, and knows the presets", () => {
    for (const preset of LIGHT_PRESETS) {
      expect(LIGHT_RIGS[preset]).toBeDefined();
      expect(isLightPreset(preset)).toBe(true);
    }
    expect(isLightPreset("disco")).toBe(false);
    expect(isLightPreset(undefined)).toBe(false);
  });

  it("lights the outdoors by one sun: only the studio has a second, opposite one", () => {
    expect(LIGHT_RIGS.studio.counterSun).toBeGreaterThan(0);
    for (const preset of LIGHT_PRESETS.filter((p) => p !== "studio")) expect(LIGHT_RIGS[preset].counterSun).toBe(0);
  });

  it("makes golden hour low and warm, and overcast mostly sky", () => {
    expect(LIGHT_RIGS.goldenHour.elevation).toBeLessThan(20);
    const [r, , b] = LIGHT_RIGS.goldenHour.sun.colour;
    expect(r).toBeGreaterThan(b);
    expect(LIGHT_RIGS.overcast.hemisphere).toBeGreaterThan(LIGHT_RIGS.overcast.sun.intensity * 3);
    expect(LIGHT_RIGS.overcast.shadowStrength).toBeLessThan(LIGHT_RIGS.clearSky.shadowStrength);
  });
});
