import { describe, expect, it } from "vitest";

import { deltaE, srgbToLab } from "../choose";
import { classifyMaterial } from "../classify";
import { colourFromWords, conditionOf, INTO360_CATEGORIES, surfaceOf, tileMetres as into360Tile, type Into360Texture } from "../into360";
import { polyHaven, tileMetres as polyHavenTile, usable } from "../polyhaven";

const texture = (patch: Partial<Into360Texture>): Into360Texture => ({
  slug: "t",
  title: "",
  direct_url: "https://360into.com/t.jpg",
  thumb_url: "https://360into.com/thumbs/t.webp",
  ...patch,
});

describe("360into", () => {
  it("guesses a colour from a texture's own words, for choosing what to measure", () => {
    expect(deltaE(colourFromWords("Beige Rough Hejazi Stone Wall")!, srgbToLab([0.83, 0.76, 0.62]))).toBeLessThan(1);
    expect(colourFromWords("Anthracite Concrete Plates")![0]).toBeLessThan(35);
    expect(colourFromWords("Light Grey Textured Paint")![0]).toBeGreaterThan(colourFromWords("Grey Textured Paint")![0]);
    expect(colourFromWords("Herringbone Pattern")).toBeNull();
    // A material's usual colour only when no colour is named.
    expect(colourFromWords("Limestone Tiles")![0]).toBeGreaterThan(70);
    expect(colourFromWords("Black Limestone Tiles")![0]).toBeLessThan(20);
  });

  it("reads the kind of surface from tags before the category", () => {
    expect(surfaceOf(texture({ tags: [{ slug: "flooring" }] }), "wall")).toBe("floor");
    expect(surfaceOf(texture({ tags: [{ slug: "wall-cladding" }] }))).toBe("wall");
    expect(surfaceOf(texture({}), "floor")).toBe("floor");
  });

  it("marks damaged and weathered looks from the words", () => {
    expect(conditionOf(texture({ title: "Old & Damaged Bricks" }))).toEqual(["damaged"]);
    expect(conditionOf(texture({ title: "Reclaimed Scaffold Boards" }))).toEqual(["weathered"]);
    expect(conditionOf(texture({ title: "Smooth Grey Concrete Plates" }))).toEqual(["clean"]);
  });

  it("keeps a non-square image's proportions, since its world size is given square", () => {
    const [w, h] = into360Tile(texture({ resolution: "1000x866", world_size: { width_mm: 600, height_mm: 600 } }));
    expect(w).toBe(0.6);
    expect(h).toBeCloseTo(0.52, 3);
    expect(into360Tile(texture({ resolution: "1024x1024" }))).toEqual([2, 2]);
  });

  it("has categories for the families it is strong in", () => {
    for (const name of ["Concrete", "Gypsum", "Brick", "Marble", "Oak", "Azulejo"]) {
      expect(INTO360_CATEGORIES[classifyMaterial({ name })!.id], name).toBeDefined();
    }
  });
});

describe("Poly Haven", () => {
  it("measures the flat preview, with the shaded sphere only as a fallback", () => {
    const previews = polyHaven.previews({
      key: "polyhaven:white_stucco",
      source: "polyhaven",
      family: "plaster",
      id: "white_stucco",
      name: "White Stucco",
      page: "",
      data: { name: "White Stucco", thumbnail_url: "https://cdn.polyhaven.com/asset_img/thumbs/white_stucco.png?width=256&height=256" },
    });
    expect(previews).toEqual([
      { url: "https://cdn.polyhaven.com/asset_img/primary/white_stucco.png?width=64", region: "all" },
      { url: "https://cdn.polyhaven.com/asset_img/thumbs/white_stucco.png?width=32&height=32", region: "middle" },
    ]);
  });

  it("leaves out aerial and snowy textures, and clamps sizes", () => {
    expect(usable({ name: "Aerial Rocks", attributes: { aerial: true } })).toBe(false);
    expect(usable({ name: "Asphalt Snow" })).toBe(false);
    expect(usable({ name: "Rough Concrete" })).toBe(true);
    expect(polyHavenTile({ name: "x", dimensions: [2000, 1500] })).toEqual([2, 1.5]);
  });
});
