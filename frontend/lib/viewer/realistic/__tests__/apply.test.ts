import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyRealisticMaterials, SHORTLIST, type MeasureColours } from "../apply";
import { srgbToLab, type Lab } from "../choose";
import type { TextureFamily } from "../classify";
import { linearMean, resetColourCacheForTests, tileMetresFromMm, type SourceCandidate, type TextureSource } from "../source";

vi.mock("@/lib/workers/texture-colour-client", () => ({ measureColoursInWorker: vi.fn() }));

type Fake = { id: string; family: string; rgb: [number, number, number]; words?: [number, number, number]; surfaceUse?: string };

/** A library whose previews are named by colour, measured by a fake that reads the colour back. */
function fakeSource(id: "polyhaven" | "360into", textures: Fake[], options: { measureAll: boolean; fail?: boolean }): TextureSource & { loaded: string[] } {
  const loaded: string[] = [];
  return {
    id,
    measureAll: options.measureAll,
    concurrency: 4,
    referrer: "none",
    loaded,
    candidates: vi.fn(async (family: TextureFamily) => {
      if (options.fail) throw new Error(`${id} is down`);
      return textures
        .filter((t) => t.family === family.id)
        .map((t): SourceCandidate => ({
          key: `${id}:${t.id}`,
          source: id,
          family: family.id,
          id: t.id,
          name: t.id.toUpperCase(),
          page: `https://${id}.example/${t.id}`,
          surfaceUse: t.surfaceUse,
          estimate: t.words ? srgbToLab(t.words) : null,
          data: t,
        }));
    }),
    colourKey: (candidate) => `${id}:${candidate.id}`,
    previews: (candidate) => [{ url: `rgb:${(candidate.data as Fake).rgb.join(",")}`, region: "all" }],
    load: vi.fn(async (candidate: SourceCandidate) => {
      loaded.push(candidate.key);
      return {
        pixels: new Uint8ClampedArray(4),
        size: 1,
        detail: new Uint8ClampedArray(4),
        detailSize: 1,
        // As the real libraries: Poly Haven publishes relief maps, 360into a photograph only.
        relief: id === "polyhaven" ? ("maps" as const) : ("estimated" as const),
        metres: [2, 2] as [number, number],
        mean: [0.5, 0.5, 0.5] as [number, number, number],
        key: candidate.key,
      };
    }),
  };
}

const measured: string[] = [];
const measure: MeasureColours = vi.fn(async (jobs: Parameters<MeasureColours>[0], _concurrency: number, onDone: (count: number) => void) => {
  const labs = jobs.map((job) => {
    measured.push(job.previews[0].url);
    return srgbToLab(job.previews[0].url.slice(4).split(",").map(Number) as [number, number, number]) as Lab;
  });
  onDone(jobs.length);
  return labs;
});

function fakeTarget(elementColours: Record<number, Array<[number, number, number]>>) {
  const picks = new Map<string, number>();
  const target = {
    layers: [] as Array<{ key: string }>,
    surfaceColours: () => new Map(Object.entries(elementColours).map(([id, c]) => [Number(id), c])),
    setSurfaceTextureLayers: vi.fn((layers: unknown[]) => {
      target.layers = layers as Array<{ key: string }>;
    }),
    setSurfaceTextures: vi.fn((_modelId: string, pick: (id: number, rgb: [number, number, number]) => number) => {
      for (const [id, list] of Object.entries(elementColours)) {
        for (const rgb of list) picks.set(`${id}:${rgb.join(",")}`, pick(Number(id), rgb));
      }
    }),
    clearSurfaceTextures: vi.fn(),
  };
  const layerOf = (key: string) => target.layers.findIndex((layer) => layer.key === key);
  return { target, picks, layerOf };
}

const model = (entries: Array<{ expressId: number; type: string; materials: Array<{ name: string }> }>) => [
  { modelId: "m", getSurfaceMaterials: async () => entries },
];

const storage = new Map<string, string>();
beforeEach(() => {
  vi.clearAllMocks();
  measured.length = 0;
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  resetColourCacheForTests();
});

describe("applyRealisticMaterials", () => {
  it("gives each element the texture of its material's kind nearest its colour, from either library", async () => {
    const ph = fakeSource("polyhaven", [
      { id: "grey_concrete", family: "concrete", rgb: [0.55, 0.55, 0.55] },
      { id: "oak", family: "wood", rgb: [0.6, 0.45, 0.3] },
    ], { measureAll: true });
    const into = fakeSource("360into", [
      { id: "white-concrete", family: "concrete", rgb: [0.9, 0.9, 0.88], words: [0.93, 0.93, 0.91] },
      { id: "dark-concrete", family: "concrete", rgb: [0.2, 0.2, 0.2], words: [0.28, 0.28, 0.3] },
    ], { measureAll: false });
    const { target, picks, layerOf } = fakeTarget({
      1: [[0.9, 0.9, 0.88]],
      2: [[0.55, 0.55, 0.55]],
      3: [[0.9, 0.9, 0.88]],
      4: [[0.6, 0.45, 0.3]],
      5: [[0.5, 0.5, 0.5]],
    });
    const result = await applyRealisticMaterials(
      target,
      model([
        { expressId: 1, type: "IfcWall", materials: [{ name: "Betão C30/37" }] },
        { expressId: 2, type: "IfcWall", materials: [{ name: "Concrete" }] },
        { expressId: 3, type: "IfcWall", materials: [{ name: "Rigid insulation" }, { name: "Concrete" }] },
        { expressId: 4, type: "IfcSlab", materials: [{ name: "Soalho de carvalho" }] },
        { expressId: 5, type: "IfcWindow", materials: [{ name: "Glass" }] },
      ]),
      { maxLayers: 16, sources: [ph, into], measure },
    );

    expect(target.setSurfaceTextureLayers).toHaveBeenCalledTimes(1);
    expect(target.layers).toHaveLength(3);
    expect(picks.get("1:0.9,0.9,0.88")).toBe(layerOf("360into:white-concrete"));
    expect(picks.get("2:0.55,0.55,0.55")).toBe(layerOf("polyhaven:grey_concrete"));
    // Insulation first in the layer set: the concrete behind it is what shows.
    expect(picks.get("3:0.9,0.9,0.88")).toBe(layerOf("360into:white-concrete"));
    expect(picks.get("4:0.6,0.45,0.3")).toBe(layerOf("polyhaven:oak"));
    expect(picks.get("5:0.5,0.5,0.5")).toBe(-1);

    expect(result.unmatched).toBe(1);
    expect(result.texturedElements).toBe(4);
    expect(result.unreachable).toEqual([]);
    expect(result.applied).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ material: "Betão C30/37", source: "360into", textureId: "white-concrete", textureName: "WHITE-CONCRETE", page: "https://360into.example/white-concrete", elements: 1 }),
        // Same kind and colour, so the same search, but listed under its own name.
        expect.objectContaining({ material: "Concrete", source: "360into", textureId: "white-concrete", relief: "estimated", elements: 1 }),
        // Each line says where its relief came from.
        expect.objectContaining({ material: "Soalho de carvalho", source: "polyhaven", textureId: "oak", relief: "maps" }),
      ]),
    );
  });

  it("measures every candidate of a cheap source, but only the nearest guesses of a dear one, and none twice", async () => {
    const many: Fake[] = Array.from({ length: 30 }, (_, i) => ({
      id: `c${String(i).padStart(2, "0")}`,
      family: "concrete",
      rgb: [i / 30, i / 30, i / 30],
      words: [i / 30, i / 30, i / 30],
    }));
    const into = fakeSource("360into", many, { measureAll: false });
    const ph = fakeSource("polyhaven", many.map((t) => ({ ...t, id: `p${t.id}` })), { measureAll: true });
    const { target } = fakeTarget({ 1: [[0.5, 0.5, 0.5]] });
    const entries = [{ expressId: 1, type: "IfcWall", materials: [{ name: "Concrete" }] }];
    await applyRealisticMaterials(target, model(entries), { maxLayers: 16, sources: [ph, into], measure });

    // All 30 of Poly Haven's, and of 360into's the eight whose words put them nearest mid-grey.
    expect(measured).toHaveLength(30 + SHORTLIST);
    const mid = (i: number) => `rgb:${[i / 30, i / 30, i / 30].join(",")}`;
    for (const i of [12, 13, 14, 15, 16, 17, 18]) expect(measured.filter((url) => url === mid(i))).toHaveLength(2);

    // A second search reads the colours back from this browser.
    measured.length = 0;
    await applyRealisticMaterials(target, model(entries), { maxLayers: 16, sources: [ph, into], measure });
    expect(measured).toEqual([]);
  });

  it("goes on with the other library when one cannot be reached, and fails only when none can", async () => {
    const down = fakeSource("polyhaven", [], { measureAll: true, fail: true });
    const up = fakeSource("360into", [{ id: "grey", family: "concrete", rgb: [0.5, 0.5, 0.5] }], { measureAll: false });
    const { target } = fakeTarget({ 1: [[0.5, 0.5, 0.5]] });
    const entries = [{ expressId: 1, type: "IfcWall", materials: [{ name: "Concrete" }] }];
    const result = await applyRealisticMaterials(target, model(entries), { maxLayers: 16, sources: [down, up], measure });
    expect(result.unreachable).toEqual(["polyhaven"]);
    expect(result.applied).toHaveLength(1);

    await expect(
      applyRealisticMaterials(target, model(entries), { maxLayers: 16, sources: [down], measure }),
    ).rejects.toThrow(/down/);
  });

  it("keeps to the layer budget, most used textures first, and leaves the rest in their own colours", async () => {
    const ph = fakeSource("polyhaven", [
      { id: "grey", family: "concrete", rgb: [0.6, 0.6, 0.6] },
      { id: "oak", family: "wood", rgb: [0.6, 0.45, 0.3] },
    ], { measureAll: true });
    const { target, picks } = fakeTarget({ 1: [[0.6, 0.6, 0.6]], 2: [[0.6, 0.6, 0.6]], 3: [[0.6, 0.45, 0.3]] });
    const result = await applyRealisticMaterials(
      target,
      model([
        { expressId: 1, type: "IfcWall", materials: [{ name: "Concrete" }] },
        { expressId: 2, type: "IfcWall", materials: [{ name: "Concrete" }] },
        { expressId: 3, type: "IfcSlab", materials: [{ name: "Oak" }] },
      ]),
      { maxLayers: 1, sources: [ph], measure },
    );
    expect(target.layers).toHaveLength(1);
    expect(picks.get("1:0.6,0.6,0.6")).toBe(0);
    expect(picks.get("3:0.6,0.45,0.3")).toBe(-1);
    expect(result.skipped).toBe(1);
    expect(ph.loaded).toEqual(["polyhaven:grey"]);
  });

  it("asks no library anything when no material has a kind", async () => {
    const ph = fakeSource("polyhaven", [], { measureAll: true });
    const { target } = fakeTarget({ 1: [[0.5, 0.5, 0.5]] });
    const result = await applyRealisticMaterials(
      target,
      model([{ expressId: 1, type: "IfcWindow", materials: [{ name: "Glass" }] }]),
      { maxLayers: 16, sources: [ph], measure },
    );
    expect(ph.candidates).not.toHaveBeenCalled();
    expect(target.clearSurfaceTextures).toHaveBeenCalled();
    expect(result).toEqual({ applied: [], texturedElements: 0, skipped: 0, unmatched: 1, unreachable: [] });
  });

  it("stops when turned off", async () => {
    const ph = fakeSource("polyhaven", [{ id: "grey", family: "concrete", rgb: [0.6, 0.6, 0.6] }], { measureAll: true });
    const { target } = fakeTarget({ 1: [[0.6, 0.6, 0.6]] });
    const controller = new AbortController();
    controller.abort();
    await expect(
      applyRealisticMaterials(
        target,
        model([{ expressId: 1, type: "IfcWall", materials: [{ name: "Concrete" }] }]),
        { maxLayers: 16, signal: controller.signal, sources: [ph], measure },
      ),
    ).rejects.toThrow(/turned off/);
    expect(target.setSurfaceTextureLayers).not.toHaveBeenCalled();
  });
});

describe("source helpers", () => {
  it("reads a real size within sensible bounds", () => {
    expect(tileMetresFromMm(2000)).toBe(2);
    expect(tileMetresFromMm(90000)).toBe(10);
    expect(tileMetresFromMm(0.0001)).toBe(2);
    expect(tileMetresFromMm(undefined)).toBe(2);
  });
  it("averages in linear light", () => {
    const [r] = linearMean(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]));
    expect(r).toBeCloseTo(1, 5);
  });
});
