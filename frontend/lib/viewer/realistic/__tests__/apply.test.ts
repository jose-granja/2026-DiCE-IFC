import { describe, expect, it, vi } from "vitest";

import { applyRealisticMaterials, layerSize, MAX_LARGE_LAYERS } from "../apply";
import { srgbToLab } from "../choose";
import type { LibraryManifest, LibraryTexture } from "../library";
import { linearMean, type LoadedTexture } from "../source";

/** A library texture of one colour (sRGB), with 2K for walls and floors as the library builds it. */
function texture(id: string, family: LibraryTexture["family"], rgb: [number, number, number], surface: LibraryTexture["surface"] = "wall"): LibraryTexture {
  const maps = (size: number) => ({ color: `${id}/h/color-${size}.webp`, normal: `${id}/h/normal-${size}.webp`, arm: `${id}/h/arm-${size}.webp` });
  return {
    id,
    name: id.toUpperCase(),
    family,
    surface,
    source: id.startsWith("acg") ? "ambientcg" : "polyhaven",
    sourceUrl: `https://polyhaven.com/a/${id}`,
    licence: "CC0-1.0",
    tile: [2, 2],
    mean: [0.5, 0.5, 0.5],
    lab: srgbToLab(rgb),
    sizes: surface === "roof" ? { "1024": maps(1024) } : { "1024": maps(1024), "2048": maps(2048) },
    thumb: `${id}/h/thumb.webp`,
  };
}

function library(textures: LibraryTexture[]) {
  const manifest = vi.fn(async (): Promise<LibraryManifest> => ({ version: 1, files: "/texture-library/files/", textures }));
  const loads: Array<{ id: string; size: number; url: string }> = [];
  const load = vi.fn(async (files: string, t: LibraryTexture, size: number): Promise<LoadedTexture> => {
    loads.push({ id: t.id, size, url: `${files}${t.sizes[String(size)]?.color ?? t.sizes["1024"].color}` });
    return {
      pixels: new Uint8ClampedArray(4),
      size,
      detail: new Uint8ClampedArray(4),
      detailSize: size / 2,
      relief: "maps",
      metres: t.tile,
      mean: t.mean,
      key: t.id,
    } as LoadedTexture & { key: string };
  });
  return { manifest, load, loads };
}

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

describe("applyRealisticMaterials", () => {
  it("gives each material the library texture of its kind nearest its colour", async () => {
    const lib = library([
      texture("grey_concrete", "concrete", [0.55, 0.55, 0.55]),
      texture("acg-white-concrete", "concrete", [0.9, 0.9, 0.88]),
      texture("oak", "wood", [0.6, 0.45, 0.3], "floor"),
    ]);
    const { target, picks, layerOf } = fakeTarget({
      1: [[0.9, 0.9, 0.88]],
      2: [[0.55, 0.55, 0.55]],
      3: [[0.55, 0.55, 0.55]],
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
      { maxLayers: 16, manifest: lib.manifest, load: lib.load },
    );

    expect(target.layers).toHaveLength(3);
    expect(picks.get("1:0.9,0.9,0.88")).toBe(layerOf("acg-white-concrete"));
    expect(picks.get("2:0.55,0.55,0.55")).toBe(layerOf("grey_concrete"));
    // Insulation first in the layer set: the concrete behind it is what shows.
    expect(picks.get("3:0.55,0.55,0.55")).toBe(layerOf("grey_concrete"));
    expect(picks.get("4:0.6,0.45,0.3")).toBe(layerOf("oak"));
    expect(picks.get("5:0.5,0.5,0.5")).toBe(-1);

    expect(result.unmatched).toBe(1);
    expect(result.texturedElements).toBe(4);
    expect(result.applied.find((line) => line.material === "Betão C30/37")).toMatchObject({
      source: "ambientcg",
      textureId: "acg-white-concrete",
      textureName: "ACG-WHITE-CONCRETE",
      relief: "maps",
    });
    // Only the chosen textures are downloaded, from this origin's files.
    expect(lib.loads.map((l) => l.id).sort()).toEqual(["acg-white-concrete", "grey_concrete", "oak"]);
    expect(lib.loads.every((l) => l.url.startsWith("/texture-library/files/"))).toBe(true);
  });

  it("gives every element of a material one texture: its most common colour and surface decide", async () => {
    const lib = library([
      texture("grey_wall", "concrete", [0.55, 0.55, 0.55], "wall"),
      texture("grey_floor", "concrete", [0.56, 0.56, 0.56], "floor"),
      texture("white_wall", "concrete", [0.9, 0.9, 0.9], "wall"),
    ]);
    const { target, picks, layerOf } = fakeTarget({
      1: [[0.55, 0.55, 0.55]],
      2: [[0.55, 0.55, 0.55]],
      3: [[0.9, 0.9, 0.9]],
      4: [[0.56, 0.56, 0.56]],
    });
    const result = await applyRealisticMaterials(
      target,
      model([
        { expressId: 1, type: "IfcWall", materials: [{ name: "C30/37" }] },
        { expressId: 2, type: "IfcColumn", materials: [{ name: "C30/37" }] },
        // A white wall and a slab: alone, each would pick another texture.
        { expressId: 3, type: "IfcWall", materials: [{ name: "C30/37" }] },
        { expressId: 4, type: "IfcSlab", materials: [{ name: "C30/37" }] },
      ]),
      { maxLayers: 16, manifest: lib.manifest, load: lib.load },
    );

    expect(target.layers).toHaveLength(1);
    for (const key of ["1:0.55,0.55,0.55", "2:0.55,0.55,0.55", "3:0.9,0.9,0.9", "4:0.56,0.56,0.56"]) {
      expect(picks.get(key)).toBe(layerOf("grey_wall"));
    }
    expect(result.applied).toEqual([expect.objectContaining({ material: "C30/37", textureId: "grey_wall", elements: 4 })]);
  });

  it("draws at 2K when few textures are needed, and every layer at 1K when more are", async () => {
    const few = library([texture("grey_concrete", "concrete", [0.5, 0.5, 0.5])]);
    const one = fakeTarget({ 1: [[0.5, 0.5, 0.5]] });
    const result = await applyRealisticMaterials(one.target, model([{ expressId: 1, type: "IfcWall", materials: [{ name: "Concrete" }] }]), {
      maxLayers: 16,
      manifest: few.manifest,
      load: few.load,
    });
    expect(result.size).toBe(2048);
    expect(few.loads[0]).toMatchObject({ size: 2048, url: "/texture-library/files/grey_concrete/h/color-2048.webp" });

    // Nine materials of distinct colours, nine textures: past the 2K budget.
    const greys = Array.from({ length: MAX_LARGE_LAYERS + 1 }, (_, i) => (i + 1) / 12);
    const many = library(greys.map((g, i) => texture(`c${i}`, "concrete", [g, g, g])));
    const colours = Object.fromEntries(greys.map((g, i) => [i + 1, [[g, g, g] as [number, number, number]]]));
    const nine = fakeTarget(colours);
    const big = await applyRealisticMaterials(
      nine.target,
      model(greys.map((_, i) => ({ expressId: i + 1, type: "IfcWall", materials: [{ name: `Concrete ${i}` }] }))),
      { maxLayers: 16, manifest: many.manifest, load: many.load },
    );
    expect(big.size).toBe(1024);
    expect(new Set(many.loads.map((l) => l.size))).toEqual(new Set([1024]));
  });

  it("keeps to the layer budget, most used textures first, and leaves the rest in their own colours", async () => {
    const lib = library([
      texture("light", "concrete", [0.9, 0.9, 0.9]),
      texture("dark", "concrete", [0.1, 0.1, 0.1]),
    ]);
    const { target, picks, layerOf } = fakeTarget({ 1: [[0.9, 0.9, 0.9]], 2: [[0.9, 0.9, 0.9]], 3: [[0.1, 0.1, 0.1]] });
    const result = await applyRealisticMaterials(
      target,
      model([1, 2, 3].map((expressId) => ({ expressId, type: "IfcWall", materials: [{ name: expressId === 3 ? "Dark concrete" : "Concrete" }] }))),
      { maxLayers: 1, manifest: lib.manifest, load: lib.load },
    );
    expect(target.layers).toHaveLength(1);
    expect(picks.get("1:0.9,0.9,0.9")).toBe(layerOf("light"));
    expect(picks.get("3:0.1,0.1,0.1")).toBe(-1);
    expect(result.skipped).toBe(1);
  });

  it("asks the library nothing when no material has a kind", async () => {
    const lib = library([texture("grey_concrete", "concrete", [0.5, 0.5, 0.5])]);
    const { target } = fakeTarget({ 1: [[0.5, 0.5, 0.5]] });
    const result = await applyRealisticMaterials(target, model([{ expressId: 1, type: "IfcWindow", materials: [{ name: "Glass" }] }]), {
      maxLayers: 16,
      manifest: lib.manifest,
      load: lib.load,
    });
    expect(lib.manifest).not.toHaveBeenCalled();
    expect(target.clearSurfaceTextures).toHaveBeenCalled();
    expect(result.applied).toEqual([]);
  });

  it("fails when the library cannot be read, and draws nothing", async () => {
    const { target } = fakeTarget({ 1: [[0.5, 0.5, 0.5]] });
    await expect(
      applyRealisticMaterials(target, model([{ expressId: 1, type: "IfcWall", materials: [{ name: "Concrete" }] }]), {
        maxLayers: 16,
        manifest: async () => {
          throw new Error("no library");
        },
      }),
    ).rejects.toThrow("no library");
    expect(target.setSurfaceTextureLayers).not.toHaveBeenCalled();
  });

  it("stops when turned off", async () => {
    const lib = library([texture("grey_concrete", "concrete", [0.5, 0.5, 0.5])]);
    const { target } = fakeTarget({ 1: [[0.5, 0.5, 0.5]] });
    const controller = new AbortController();
    controller.abort();
    await expect(
      applyRealisticMaterials(target, model([{ expressId: 1, type: "IfcWall", materials: [{ name: "Concrete" }] }]), {
        maxLayers: 16,
        signal: controller.signal,
        manifest: lib.manifest,
        load: lib.load,
      }),
    ).rejects.toThrow(/turned off/);
  });
});

describe("layerSize", () => {
  it("is 2K for a few textures with 2K files, else 1K", () => {
    const wall = texture("w", "concrete", [0.5, 0.5, 0.5]);
    const roof = texture("r", "roofTiles", [0.5, 0.2, 0.1], "roof");
    expect(layerSize([wall, roof])).toBe(2048);
    expect(layerSize([roof])).toBe(1024);
    expect(layerSize(Array.from({ length: MAX_LARGE_LAYERS + 1 }, () => wall))).toBe(1024);
  });
});

it("averages in linear light", () => {
  // Black and white half and half: 0.5 in linear light, not the sRGB midpoint.
  const pixels = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  expect(linearMean(pixels)[0]).toBeCloseTo(0.5);
});
