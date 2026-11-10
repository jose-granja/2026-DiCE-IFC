import { readFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { ifcLiteAdapter } from "../ifc-lite-adapter";

const FIXTURES = path.resolve(__dirname, "../../../fixtures/ifc");

async function geometryOf(name: string, bytes: Uint8Array) {
  const model = await ifcLiteAdapter.loadModel({
    name,
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  });
  try {
    return await ifcLiteAdapter.getGeometry(model.id);
  } finally {
    await ifcLiteAdapter.unloadModel(model.id);
  }
}

describe("the model's own textures", () => {
  it("brings an embedded image (IfcBlobTexture) with its pixels and coordinates", async () => {
    const { meshes } = await geometryOf("textured-blob-ifc4.ifc", await readFile(path.join(FIXTURES, "textured-blob-ifc4.ifc")));
    const panel = meshes.find((mesh) => mesh.expressId === 105);
    expect(panel?.uvs).toHaveLength((panel!.positions.length / 3) * 2);
    expect(panel?.texture).toMatchObject({ repeatS: true, repeatT: true, pixels: { width: 4, height: 4 } });
    expect(panel?.texture?.key).toMatch(/^px:4x4:/);
    // The fixture's checker: red, then blue.
    expect(Array.from(panel!.texture!.pixels!.rgba.slice(0, 8))).toEqual([220, 30, 30, 255, 30, 60, 220, 255]);
    expect(panel?.texture?.url).toBeUndefined();
  });

  it("brings an image reference (IfcImageTexture) as written, keyed by the texture", async () => {
    // The worker parses the model entry; the images stay on the main thread (container.ts).
    const entries = unzipSync(new Uint8Array(await readFile(path.join(FIXTURES, "textured-image-ifc4.ifczip"))));
    const { meshes } = await geometryOf("textured-image-ifc4.ifc", entries["textured-image-ifc4.ifc"]);
    const packed = meshes.find((mesh) => mesh.expressId === 105);
    const remote = meshes.find((mesh) => mesh.expressId === 305);
    expect(packed?.texture).toEqual({ key: "ref:109", repeatS: true, repeatT: true, url: "textures/Checker.PNG" });
    expect(remote?.texture).toMatchObject({ key: "ref:309", url: "https://textures.invalid/remote.png" });
    expect(packed?.uvs).toHaveLength(8);
    expect(entries["textures/checker.png"]).toBeDefined();
  });

  it("leaves untextured meshes as they were", async () => {
    const { meshes } = await geometryOf("georeferenced-wall-ifc4.ifc", await readFile(path.join(FIXTURES, "georeferenced-wall-ifc4.ifc")));
    expect(meshes.length).toBeGreaterThan(0);
    for (const mesh of meshes) {
      expect(mesh.texture).toBeUndefined();
      expect(mesh.uvs).toBeUndefined();
    }
  });
});
