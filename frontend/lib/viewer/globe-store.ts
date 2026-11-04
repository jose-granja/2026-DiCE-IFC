"use client";

/**
 * The 3D world context: the Cesium globe under the model, with terrain, OSM or
 * Google buildings, an ion asset or a 3D Tiles URL.
 *
 * Owned here rather than by the GIS panel, so it stays on when the user opens
 * another tab — the globe is drawn in the viewport, which is still on screen —
 * and so a project folder can save it and turn it back on. It used to be torn
 * down with the panel, which made it impossible to look at a filtered model
 * against its surroundings, or to save both.
 *
 * Still off by default, and still the one thing here that talks to a third
 * party: a tile request says roughly where the building is (ADR 003). A
 * restored project asks before turning it on (`ProjectActions`).
 *
 * What it needs from the GIS panel is where the model sits on the earth; the
 * panel reports that through `setPlacement` while it is open, and the last
 * report is kept for when it is not.
 */

import { create } from "zustand";

import type { WgsPoint } from "@/lib/georef/transform";
import { getActiveRenderer } from "./active-renderer";
import { createGlobe, type Globe, type GlobeLayer } from "./globe";
import { getGlobeCanvas } from "./globe-canvas";

import { GLOBE_IMAGERY, GLOBE_LAYERS, type GlobeImageryId, type GlobeLayerId } from "./globe-layers";

export { GLOBE_IMAGERY, GLOBE_LAYERS, type GlobeImageryId, type GlobeLayerId };

export type GlobeSettings = {
  layer: GlobeLayerId;
  assetId: string;
  url: string;
  /** The map draped over the terrain; a road map unless the user chose otherwise. */
  imagery: GlobeImageryId;
};

export type GlobeOutcome =
  | { ok: true }
  /** `reason` is for the UI to translate; `error` is the engine's own words otherwise. */
  | { ok: false; error: string; reason?: "noOrigin" | "notConfigured" };

type GlobeState = GlobeSettings & {
  on: boolean;
  phase: "starting" | "layer" | "preparing" | null;
  /** Where the model sits on the earth, as the GIS panel last reported it. */
  origin: WgsPoint | null;
  northCorrection: number;
  /** A restored project asked for the globe; the GIS panel turns it on once it has an origin. */
  pending: boolean;
  pendingOutcome: GlobeOutcome | null;

  setSettings: (patch: Partial<GlobeSettings>) => void;
  setPlacement: (origin: WgsPoint | null, northCorrection: number) => void;
  /** Switch on (with the current layer) or off. Resolves to what happened. */
  enable: (enabled: boolean) => Promise<GlobeOutcome>;
  /** Change the map over the terrain, on the live globe too if it is on. */
  setImagery: (imagery: GlobeImageryId) => Promise<GlobeOutcome>;
  /** Turn it off and release the globe — the viewer is going away, or the models are. */
  off: () => void;
  restore: (settings: GlobeSettings, turnOn: boolean) => void;
  finishPending: (outcome: GlobeOutcome) => void;
};

/** The live globe. Outside the store: a Cesium viewer is not state to diff. */
let globe: Globe | null = null;
/** Bumped on every switch, so a slow earlier one cannot land after a later one. */
let generation = 0;

export function getGlobe(): Globe | null {
  return globe;
}

function release() {
  generation += 1;
  const renderer = getActiveRenderer();
  renderer?.setGlobe(null, null);
  renderer?.setDepthProxy(null);
  globe?.dispose();
  globe = null;
}

export const useGlobeStore = create<GlobeState>((set, get) => ({
  layer: "terrain",
  assetId: "",
  url: "",
  imagery: "roadmap",
  on: false,
  phase: null,
  origin: null,
  northCorrection: 0,
  pending: false,
  pendingOutcome: null,

  setSettings: (patch) => set(patch),

  setPlacement: (origin, northCorrection) => {
    set({ origin, northCorrection });
    // Keep the model's position on the earth current without rebuilding: the
    // globe is expensive to create and the placement can change while it is up.
    if (globe) getActiveRenderer()?.setGlobe(globe, origin, northCorrection);
  },

  enable: async (enabled) => {
    if (!enabled) {
      release();
      set({ on: false, phase: null });
      return { ok: true };
    }

    const current = ++generation;
    const isCurrent = () => current === generation;
    const { layer, assetId, url, imagery, origin, northCorrection } = get();
    const renderer = getActiveRenderer();
    const canvas = getGlobeCanvas();
    if (!renderer || !canvas || !origin) {
      return { ok: false, error: "No position on the earth to show the globe around.", reason: "noOrigin" };
    }

    set({ on: true, phase: "starting" });
    try {
      let active = globe;
      if (!active) {
        active = await createGlobe(canvas);
        if (!isCurrent()) {
          active.dispose();
          return { ok: true };
        }
        globe = active;
      }

      const described: GlobeLayer =
        layer === "ion-asset"
          ? { kind: "ion-asset", assetId }
          : layer === "tileset-url"
            ? { kind: "tileset-url", url }
            : { kind: layer };

      set({ phase: "layer" });
      await active.setLayer(described);
      // The map is the nicety; terrain and the 3D layer are the substance, so a
      // map that will not load costs the map, not the globe.
      await active.setImagery(imagery).catch(() => undefined);
      if (!isCurrent()) return { ok: true };
      renderer.setGlobe(active, origin, northCorrection);
      set({ phase: "preparing" });

      /*
        Build the occluder for whatever was just loaded — terrain, 3D Tiles,
        or both.

        Deliberately after `setLayer`, and deliberately awaited separately: the
        globe should appear as soon as it can, and clamping to the scene is a
        network round trip. A failure here costs occlusion, not the map.

        The extent follows what the camera can see, so a model on a hillside
        gets the hillside. It is not rebuilt as the camera moves — the proxy is
        for the ground around the model, and re-sampling on every zoom would
        put a network request in the middle of a gesture.
      */
      try {
        const proxy = await active.sampleDepthProxy(origin, renderer.visibleGroundMetres(), northCorrection);
        if (isCurrent()) renderer.setDepthProxy(proxy);
      } catch {
        if (isCurrent()) renderer.setDepthProxy(null);
      }
      return { ok: true };
    } catch (error) {
      if (!isCurrent()) return { ok: true };
      // A failed layer must not leave a half-built globe hiding the model.
      release();
      set({ on: false, phase: null });
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (isCurrent()) set({ phase: null });
    }
  },

  setImagery: async (imagery) => {
    set({ imagery });
    if (!globe) return { ok: true };
    try {
      await globe.setImagery(imagery);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  off: () => {
    release();
    set({ on: false, phase: null, pending: false });
  },

  restore: (settings, turnOn) => set({ ...settings, pending: turnOn, pendingOutcome: null }),
  finishPending: (outcome) => set({ pending: false, pendingOutcome: outcome }),
}));
