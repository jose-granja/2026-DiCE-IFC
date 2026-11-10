import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { imageKey, unwrapModel } from "../container";

const MODEL = strToU8("ISO-10303-21;\nEND-ISO-10303-21;\n");

describe("a .ifczip's images", () => {
  it("are kept by lower-case file name, beside the model", async () => {
    const archive = zipSync({
      "model.ifc": MODEL,
      "textures/Brick.JPG": new Uint8Array([1]),
      "wood.png": new Uint8Array([2]),
      "notes.txt": new Uint8Array([3]),
      "META-INF/signature.png": new Uint8Array([4]),
    });
    const unwrapped = await unwrapModel(new File([archive as BlobPart], "model.ifczip"));
    expect([...unwrapped.images.keys()].sort()).toEqual(["brick.jpg", "wood.png"]);
    expect(unwrapped.images.get("brick.jpg")).toEqual(new Uint8Array([1]));
  });

  it("are none for a plain .ifc", async () => {
    const unwrapped = await unwrapModel(new File([MODEL as BlobPart], "model.ifc"));
    expect(unwrapped.images.size).toBe(0);
  });

  it("are found by the file name a reference ends in, whatever its path", () => {
    expect(imageKey("textures/Checker.PNG")).toBe("checker.png");
    expect(imageKey("C:\\Users\\me\\Textures\\Wood.jpg")).toBe("wood.jpg");
    expect(imageKey("file:///home/me/Brick.png")).toBe("brick.png");
    expect(imageKey("plain.png")).toBe("plain.png");
  });
});
