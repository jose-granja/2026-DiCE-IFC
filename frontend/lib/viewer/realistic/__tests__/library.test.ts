import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchManifest, filesAt, LIBRARY_MANIFEST_URL, LibraryUnavailableError, resetLibraryForTests, type LibraryTexture } from "../library";

const good = {
  id: "polyhaven-red_brick",
  name: "Red Brick",
  family: "brick",
  surface: "wall",
  source: "polyhaven",
  sourceUrl: "https://polyhaven.com/a/red_brick",
  licence: "CC0-1.0",
  tile: [1.5, 1.5],
  mean: [0.3, 0.1, 0.05],
  lab: [40, 30, 25],
  sizes: {
    "1024": { color: "polyhaven-red_brick/abc/color-1024.webp", normal: "polyhaven-red_brick/abc/normal-1024.webp", arm: "polyhaven-red_brick/abc/arm-1024.webp" },
    "2048": { color: "polyhaven-red_brick/abc/color-2048.webp", normal: "polyhaven-red_brick/abc/normal-2048.webp", arm: "polyhaven-red_brick/abc/arm-2048.webp" },
  },
  thumb: "polyhaven-red_brick/abc/thumb.webp",
};

function answer(status: number, body: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

beforeEach(() => resetLibraryForTests());
afterEach(() => vi.unstubAllGlobals());

describe("the library manifest", () => {
  it("is read once, from this origin, without credentials", async () => {
    const fetch = answer(200, { version: 1, files: "/texture-library/files/", textures: [good] });
    const manifest = await fetchManifest();
    await fetchManifest();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(LIBRARY_MANIFEST_URL, { credentials: "omit" });
    expect(manifest.textures.map((t) => t.id)).toEqual(["polyhaven-red_brick"]);
  });

  it("leaves out a texture that is not what a texture should be, keeping the rest", async () => {
    answer(200, {
      version: 1,
      files: "/texture-library/files/",
      textures: [
        good,
        { ...good, id: "escape", thumb: "../../etc/passwd" },
        { ...good, id: "elsewhere", sizes: { "1024": { ...good.sizes["1024"], color: "https://evil.example/x.webp" } } },
        { ...good, id: "lava", family: "lava" },
      ],
    });
    expect((await fetchManifest()).textures.map((t) => t.id)).toEqual(["polyhaven-red_brick"]);
  });

  it("refuses files from another origin", async () => {
    answer(200, { version: 1, files: "//evil.example/", textures: [good] });
    await expect(fetchManifest()).rejects.toBeInstanceOf(LibraryUnavailableError);
  });

  it("says when the server has no library, and asks again next time", async () => {
    answer(404, { detail: "Not Found" });
    await expect(fetchManifest()).rejects.toMatchObject({ status: 404 });
    const fetch = answer(200, { version: 1, files: "/texture-library/files/", textures: [good] });
    await fetchManifest();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("says when the server cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(fetchManifest()).rejects.toMatchObject({ status: null });
  });
});

describe("filesAt", () => {
  it("takes the largest size up to the one asked for", () => {
    const texture = good as unknown as LibraryTexture;
    expect(filesAt(texture, 2048).color).toContain("color-2048");
    expect(filesAt(texture, 1024).color).toContain("color-1024");
    const roof = { ...texture, sizes: { "1024": texture.sizes["1024"] } };
    expect(filesAt(roof, 2048).color).toContain("color-1024");
  });
});
