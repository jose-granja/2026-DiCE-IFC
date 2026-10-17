import { describe, expect, it } from "vitest";
import type { ContextFeature } from "@/lib/georef/context-geometry";
import { contextColourGroups, contextValueKey, DEFAULT_CONTEXT_APPEARANCE } from "../context-appearance";
import { contextEdgeMasks } from "../context-edges";
import { useContextModelStore } from "../context-model-store";

const feature = (value: unknown): ContextFeature => ({ id: "f", type: "Polygon", source: "GeoJSON", properties: value === undefined ? {} : { category: value } });

describe("context property colours", () => {
  it("groups equal values while preserving zero, false, null, missing and text types", () => {
    const groups = contextColourGroups([0, 0, "0", false, null, undefined, ""].map(feature), { property: "category", overrides: {} });
    expect(groups).toHaveLength(6);
    expect(groups.find((group) => group.key === contextValueKey(0))?.count).toBe(2);
    expect(new Set(groups.map((group) => group.key)).size).toBe(6);
  });

  it("keeps colours independent of feature order, applies overrides and ignores invalid colours", () => {
    const features = [feature("Residential"), feature("Park")];
    const colouring = { property: "category", overrides: { [contextValueKey("Park")]: "#123456", [contextValueKey("Residential")]: "invalid" } };
    const groups = contextColourGroups(features, colouring);
    expect(groups).toEqual(contextColourGroups([...features].reverse(), colouring));
    expect(groups.find((group) => group.value === "Park")?.colour).toBe("#123456");
    expect(groups.find((group) => group.value === "Residential")?.colour).toMatch(/^#[\da-f]{6}$/i);
  });
});

describe("context outlines", () => {
  const square = new Float32Array([0,0,0, 1,0,0, 1,0,1, 0,0,0, 1,0,1, 0,0,1]);
  it("omits triangulation seams across ranges belonging to the same feature", () => {
    const masks = contextEdgeMasks(square, [{ firstTriangle: 0, triangleCount: 1, featureIndex: 0 }, { firstTriangle: 1, triangleCount: 1, featureIndex: 0 }]);
    expect([...masks]).toEqual([5, 5, 5, 3, 3, 3]);
  });
  it("retains a shared coplanar border between two distinct features", () => {
    const masks = contextEdgeMasks(square, [{ firstTriangle: 0, triangleCount: 1, featureIndex: 0 }, { firstTriangle: 1, triangleCount: 1, featureIndex: 1 }]);
    expect([...masks]).toEqual([7, 7, 7, 7, 7, 7]);
  });
});

it("preserves restored styling while loading, then clears property colours for a different context file", () => {
  const store = useContextModelStore.getState();
  store.clear();
  const file = new File([], "context.geojson");
  const appearance = { edgesOn: false, edgeWidth: 2, colouring: { property: "category", overrides: { [contextValueKey("Park")]: "#123456" } } };
  store.restore(file, { visible: true, clipEnabled: true, clipRadius: "100", appearance });
  const geometry = { positions: new Float32Array(), colours: new Float32Array(), origin: { easting: 0, northing: 0, height: 0 }, epsg: 3763, objectCount: 0, types: [], sizeMetres: 0 };
  store.setLoaded(file, geometry);
  expect(useContextModelStore.getState().appearance).toEqual(appearance);
  store.finishPending({ ok: true });
  store.setLoaded(new File([], "other.geojson"), geometry);
  expect(useContextModelStore.getState().appearance.colouring).toBeNull();
  store.clear();
  expect(useContextModelStore.getState().appearance).toEqual(DEFAULT_CONTEXT_APPEARANCE);
});
