// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createGlobe, type Globe } from "../globe";
import { getGlobe, useGlobeStore } from "../globe-store";

const { renderer } = vi.hoisted(() => ({
  renderer: { setGlobe: vi.fn(), setDepthProxy: vi.fn(), visibleGroundMetres: () => 100 },
}));
vi.mock("../globe", () => ({ createGlobe: vi.fn() }));
vi.mock("../active-renderer", () => ({ getActiveRenderer: () => renderer }));
vi.mock("../globe-canvas", () => ({ getGlobeCanvas: () => document.createElement("div") }));

const ORIGIN = { latitude: 41.15, longitude: -8.61, height: 10 };
let globe: Globe;

beforeEach(() => {
  vi.clearAllMocks();
  useGlobeStore.getState().off();
  useGlobeStore.setState({ layer: "terrain", assetId: "", url: "", imagery: "roadmap", origin: null, pendingOutcome: null });
  globe = {
    setLayer: vi.fn().mockResolvedValue(undefined),
    setImagery: vi.fn().mockResolvedValue(undefined),
    sampleDepthProxy: vi.fn().mockResolvedValue(null),
    getLoadingState: vi.fn().mockReturnValue({ loading: false, pending: 0 }),
    sync: vi.fn(), setSectionPlanes: vi.fn(), setSun: vi.fn(), getAttribution: () => "", isReady: () => true, dispose: vi.fn(),
  };
  vi.mocked(createGlobe).mockResolvedValue(globe);
});

describe("the 3D world context store", () => {
  it("turns the globe on with the chosen layer and keeps it without any panel", async () => {
    useGlobeStore.getState().setPlacement(ORIGIN, 0.01);
    useGlobeStore.getState().setSettings({ layer: "osm-buildings" });
    expect(await useGlobeStore.getState().enable(true)).toEqual({ ok: true });

    expect(globe.setLayer).toHaveBeenCalledWith({ kind: "osm-buildings" });
    expect(renderer.setGlobe).toHaveBeenCalledWith(globe, ORIGIN, 0.01);
    // Nothing here belongs to a component: the globe is up until asked to go.
    expect(useGlobeStore.getState().on).toBe(true);
    expect(getGlobe()).toBe(globe);
    expect(globe.dispose).not.toHaveBeenCalled();
  });

  it("drapes the chosen map when it turns on, and swaps it on the live globe", async () => {
    useGlobeStore.getState().setPlacement(ORIGIN, 0);
    await useGlobeStore.getState().enable(true);
    // A road map unless the user chose otherwise.
    expect(globe.setImagery).toHaveBeenCalledWith("roadmap");

    expect(await useGlobeStore.getState().setImagery("satellite")).toEqual({ ok: true });
    expect(globe.setImagery).toHaveBeenLastCalledWith("satellite");
    expect(useGlobeStore.getState().imagery).toBe("satellite");
    // No rebuild: the layer stays as it was.
    expect(globe.setLayer).toHaveBeenCalledOnce();
  });

  it("costs only the map when the map will not load", async () => {
    vi.mocked(globe.setImagery).mockRejectedValue(new Error("quota"));
    useGlobeStore.getState().setPlacement(ORIGIN, 0);
    expect(await useGlobeStore.getState().enable(true)).toEqual({ ok: true });
    expect(useGlobeStore.getState().on).toBe(true);
    expect(await useGlobeStore.getState().setImagery("satellite")).toEqual({ ok: false, error: "quota" });
  });

  it("follows the model when the GIS panel reports a new placement", async () => {
    useGlobeStore.getState().setPlacement(ORIGIN, 0);
    await useGlobeStore.getState().enable(true);
    const moved = { ...ORIGIN, latitude: 41.2 };
    useGlobeStore.getState().setPlacement(moved, 0.02);
    expect(renderer.setGlobe).toHaveBeenLastCalledWith(globe, moved, 0.02);
  });

  it("releases everything when switched off", async () => {
    useGlobeStore.getState().setPlacement(ORIGIN, 0);
    await useGlobeStore.getState().enable(true);
    useGlobeStore.getState().off();
    expect(globe.dispose).toHaveBeenCalledOnce();
    expect(renderer.setGlobe).toHaveBeenLastCalledWith(null, null);
    expect(renderer.setDepthProxy).toHaveBeenLastCalledWith(null);
    expect(useGlobeStore.getState().on).toBe(false);
  });

  it("will not turn on with nowhere on the earth to put it", async () => {
    expect(await useGlobeStore.getState().enable(true)).toMatchObject({ ok: false, reason: "noOrigin" });
    expect(createGlobe).not.toHaveBeenCalled();
  });

  it("holds a restored project's request until the GIS panel can act on it", () => {
    useGlobeStore.getState().restore({ layer: "google-photorealistic", assetId: "", url: "", imagery: "satellite" }, true);
    expect(useGlobeStore.getState()).toMatchObject({
      layer: "google-photorealistic",
      imagery: "satellite",
      pending: true,
      on: false,
    });
    // Restored without consent: the layer is kept, nothing is asked for.
    useGlobeStore.getState().restore({ layer: "osm-buildings", assetId: "", url: "", imagery: "roadmap" }, false);
    expect(useGlobeStore.getState()).toMatchObject({ layer: "osm-buildings", pending: false });
  });
});
