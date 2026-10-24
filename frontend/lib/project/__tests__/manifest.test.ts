import { describe, expect, it } from "vitest";

import { PROJECT_FORMAT, ProjectFormatError, parseProjectManifest } from "../manifest";

const minimal = { format: PROJECT_FORMAT, version: 1, savedAt: "2026-10-13T12:00:00Z", models: [] };
const parse = (value: unknown) => parseProjectManifest(JSON.stringify(value));

describe("project.json", () => {
  it("reads a minimal project, filling in everything it does not say", () => {
    const manifest = parse(minimal);
    expect(manifest.pointClouds).toEqual([]);
    expect(manifest.context).toBeNull();
    expect(manifest.ids).toEqual({ validation: null, editor: null });
    expect(manifest.filters).toMatchObject({ hidden: [], isolated: null, classes: [] });
    expect(manifest.measurements).toEqual({ distances: [], angles: [], areas: [], volumes: [] });
    expect(manifest.viewer.camera).toBeNull();
  });

  it("refuses what is not a project, and says which kind of wrong it is", () => {
    const code = (text: string) => {
      try {
        parseProjectManifest(text);
      } catch (error) {
        return error instanceof ProjectFormatError ? error.code : "other";
      }
      return "accepted";
    };
    expect(code("{")).toBe("notJson");
    expect(code(JSON.stringify({ format: "something-else" }))).toBe("notProject");
    expect(code(JSON.stringify({ ...minimal, version: 99 }))).toBe("newerVersion");
  });

  it("names the field that is wrong", () => {
    const error = (() => {
      try {
        parse({ ...minimal, models: [{ path: "models/a.ifc", name: "a.ifc", manualOffset: [1, "2", 3] }] });
      } catch (caught) {
        return caught as ProjectFormatError;
      }
    })();
    expect(error?.code).toBe("invalid");
    expect(error?.detail).toMatch(/^models\.0\.manualOffset\.1:/);
  });

  it("refuses values the viewer would choke on, rather than passing them through", () => {
    // A non-finite coordinate would put NaN into the renderer.
    expect(() => parse({ ...minimal, sectionPlanes: [{ id: "s", axis: "y", position: null, rotation: 0, flipped: false, enabled: true }] })).toThrow(ProjectFormatError);
    // A string where a list of strings is expected would reach the store as one.
    expect(() => parse({ ...minimal, filters: { classes: "IfcWall" } })).toThrow(ProjectFormatError);
    // A colour is used in CSS; anything but a hex colour is refused.
    expect(() =>
      parse({ ...minimal, models: [{ path: "m.ifc", name: "m.ifc", colour: "red; background:url(x)" }] }),
    ).toThrow(ProjectFormatError);
  });

  it("holds only paths for the quantity list and the clash matrix, which are workbooks", () => {
    expect(parse({ ...minimal, quantities: { path: "quantities/quantities.xlsx" } }).quantities).toEqual({
      path: "quantities/quantities.xlsx",
    });
    // The matrix itself is not accepted inline any more.
    expect(() => parse({ ...minimal, clash: { groups: [], tolerances: [], rules: [] } })).toThrow(
      ProjectFormatError,
    );
  });

  it("reads a BCF entry saved without the marker flag as markers off", () => {
    expect(parse({ ...minimal, bcf: { path: "bcf/topics.bcf" } }).bcf).toEqual({
      path: "bcf/topics.bcf",
      markersVisible: false,
    });
  });

  it("drops keys it does not know, so nothing unexpected reaches the stores", () => {
    const manifest = parse({ ...minimal, extra: "ignored", viewer: { panel: "ids", surprise: 1 } });
    expect("extra" in manifest).toBe(false);
    expect("surprise" in manifest.viewer).toBe(false);
    expect(manifest.viewer.panel).toBe("ids");
  });

  it("defaults old projects to three property decimal places and validates saved precision", () => {
    const display = { lightIntensity: 1, exposure: 0.75, edgesOn: true, edgeWidth: 1 };
    expect(parse({ ...minimal, viewer: { display } }).viewer.display?.propertyDecimalPlaces).toBe(3);
    for (const digits of [0, 5, 15]) {
      expect(parse({ ...minimal, viewer: { display: { ...display, propertyDecimalPlaces: digits } } }).viewer.display?.propertyDecimalPlaces).toBe(digits);
    }
    for (const digits of [-1, 1.5, 16]) {
      expect(() => parse({ ...minimal, viewer: { display: { ...display, propertyDecimalPlaces: digits } } })).toThrow(ProjectFormatError);
    }
  });
});

it("restores old context projects with default appearance and validates new styles", () => {
  const context = { path: "context/map.gpkg", name: "map.gpkg" };
  expect(parse({ ...minimal, context }).context?.appearance).toEqual({ edgesOn: true, edgeWidth: 1, colouring: null });
  const appearance = { edgesOn: false, edgeWidth: 2, layer: { field: "layer", value: "Land" }, colouring: { property: "NAME", overrides: { 'string:"Portugal"': "#123456" } } };
  expect(parse({ ...minimal, context: { ...context, appearance } }).context?.appearance).toEqual(appearance);
  expect(() => parse({ ...minimal, context: { ...context, appearance: { ...appearance, colouring: { ...appearance.colouring, hiddenValues: [12] } } } })).toThrow(ProjectFormatError);
  expect(() => parse({ ...minimal, context: { ...context, appearance: { ...appearance, edgeWidth: -1 } } })).toThrow(ProjectFormatError);
  expect(() => parse({ ...minimal, context: { ...context, appearance: { ...appearance, colouring: { property: "NAME", overrides: { bad: "red;url(x)" } } } } })).toThrow(ProjectFormatError);
});
