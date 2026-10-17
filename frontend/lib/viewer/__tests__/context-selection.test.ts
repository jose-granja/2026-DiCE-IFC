import { DEFAULT_CONTEXT_APPEARANCE } from "@/lib/viewer/context-appearance";
import { beforeEach, expect, it } from "vitest";
import { useContextModelStore } from "../context-model-store";
import { useViewerStore } from "../store";
import type { ContextGeometry } from "@/lib/georef/context-geometry";

const file = new File([], "context.gpkg");
const geometry: ContextGeometry = {
  positions: new Float32Array(9), colours: new Float32Array(9),
  origin: { easting: 0, northing: 0, height: 0 }, epsg: 3763, objectCount: 1, sizeMetres: 1, types: [],
  features: [{ id: "1", type: "Polygon", source: "GeoPackage", properties: { name: "Portugal" } }],
};
beforeEach(() => {
  useViewerStore.getState().reset();
  useContextModelStore.getState().clear();
  useContextModelStore.getState().setSettings({ visible: true });
  useContextModelStore.getState().setLoaded(file, geometry);
});

it("clears context inspection for IFC selection and deselection", () => {
  const context = useContextModelStore.getState();
  context.selectFeature(0);
  useViewerStore.getState().select([{ modelId: "ifc", expressId: 42 }]);
  expect(useContextModelStore.getState().selectedFeature).toBeNull();
  context.selectFeature(0);
  useViewerStore.getState().clearSelection();
  expect(useContextModelStore.getState().selectedFeature).toBeNull();
});

it("clears stale feature indices when hiding, replacing, removing or restoring context", () => {
  for (const change of [
    () => useContextModelStore.getState().setSettings({ visible: false }),
    () => useContextModelStore.getState().setLoaded(file, { ...geometry, features: [] }),
    () => useContextModelStore.getState().clear(),
    () => useContextModelStore.getState().restore(file, { visible: true, clipEnabled: true, clipRadius: "100", appearance: DEFAULT_CONTEXT_APPEARANCE }),
  ]) {
    const context = useContextModelStore.getState();
    context.setSettings({ visible: true }); context.setLoaded(file, geometry); context.selectFeature(0);
    expect(useContextModelStore.getState().selectedFeature).toBe(0);
    change();
    expect(useContextModelStore.getState().selectedFeature).toBeNull();
  }
});

it("clears inspection only when its colour group is hidden and rejects hidden selections", () => {
  const context = useContextModelStore.getState();
  const appearance = { ...DEFAULT_CONTEXT_APPEARANCE, colouring: { property: "name", overrides: {}, hiddenValues: ['string:"Spain"'] } };
  context.selectFeature(0);
  context.setSettings({ appearance });
  expect(useContextModelStore.getState().selectedFeature).toBe(0);
  context.setSettings({ appearance: { ...appearance, colouring: { ...appearance.colouring, hiddenValues: ['string:"Portugal"'] } } });
  expect(useContextModelStore.getState().selectedFeature).toBeNull();
  context.selectFeature(0);
  expect(useContextModelStore.getState().selectedFeature).toBeNull();
  context.setSettings({ appearance });
  context.selectFeature(0);
  expect(useContextModelStore.getState().selectedFeature).toBe(0);
});
