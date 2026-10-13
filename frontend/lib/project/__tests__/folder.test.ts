import { describe, expect, it } from "vitest";

import {
  projectFolderName,
  projectZip,
  ProjectFolderError,
  readProjectFromFileList,
  readProjectFromZip,
  safeFileName,
  uniquePaths,
} from "../folder";

/** A `File` as `<input webkitdirectory>` hands it over, with its path in the folder. */
function inFolder(path: string, contents: string): File {
  const file = new File([contents], path.split("/").pop()!);
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

describe("names", () => {
  it("cleans what a file system would refuse, keeping the name recognisable", () => {
    expect(safeFileName("Bloco A: estrutura.ifc")).toBe("Bloco A_ estrutura.ifc");
    expect(safeFileName("a/b\\c?.ifc")).toBe("a_b_c_.ifc");
    expect(safeFileName("trailing. ")).toBe("trailing");
    expect(safeFileName("..")).toBe("file");
    expect(safeFileName("\u0007bell.ifc")).toBe("bell.ifc");
  });

  it("never hands out the same path twice, ignoring case as macOS and Windows do", () => {
    const next = uniquePaths();
    expect(next("models", "Wall.ifc")).toBe("models/Wall.ifc");
    expect(next("models", "wall.ifc")).toBe("models/wall (2).ifc");
    expect(next("models", "Wall.ifc")).toBe("models/Wall (3).ifc");
    // A different folder is a different namespace.
    expect(next("pointclouds", "Wall.ifc")).toBe("pointclouds/Wall.ifc");
  });

  it("keeps a double extension together", () => {
    const next = uniquePaths();
    expect(next("context", "porto.city.json")).toBe("context/porto.city.json");
    expect(next("context", "porto.city.json")).toBe("context/porto (2).city.json");
  });

  it("names the folder from the local clock", () => {
    expect(projectFolderName(new Date(2026, 9, 13, 14, 5))).toBe("DiCE-IFC project 2026-10-13 1405");
  });
});

describe("reading a folder", () => {
  it("finds project.json and looks files up relative to it", async () => {
    const source = await readProjectFromFileList([
      inFolder("My project/project.json", '{"format":"x"}'),
      inFolder("My project/models/Wall.ifc", "ISO-10303-21;"),
    ]);
    expect(source.name).toBe("My project");
    expect(source.manifestText).toBe('{"format":"x"}');
    expect(await source.file("models/Wall.ifc")?.text()).toBe("ISO-10303-21;");
    // Case and stray separators do not matter; a missing file is undefined.
    expect(source.file("./MODELS/wall.ifc")).toBeDefined();
    expect(source.file("models/other.ifc")).toBeUndefined();
  });

  it("opens the outermost project when an older one was copied inside it", async () => {
    const source = await readProjectFromFileList([
      inFolder("Current/backup/project.json", "old"),
      inFolder("Current/project.json", "new"),
    ]);
    expect(source.manifestText).toBe("new");
  });

  it("does not reach outside the project folder", async () => {
    // A sibling of the project folder, picked along with it, is not part of it.
    const source = await readProjectFromFileList([
      inFolder("Parent/Project/project.json", "{}"),
      inFolder("Parent/secret.ifc", "nope"),
    ]);
    expect(source.file("../secret.ifc")).toBeUndefined();
    expect(source.file("secret.ifc")).toBeUndefined();
  });

  it("says when the folder is not a project", async () => {
    await expect(readProjectFromFileList([inFolder("Photos/a.jpg", "")])).rejects.toMatchObject({
      code: "noManifest",
    });
  });
});

describe("the .zip fallback", () => {
  it("holds the same folder, and reads back as one", async () => {
    const zip = await projectZip("DiCE-IFC project 2026-10-13 1405", [
      { path: "project.json", data: new Blob(['{"format":"dice-ifc-project"}']) },
      { path: "models/Wall.ifc", data: new Blob(["ISO-10303-21;\nEND-ISO-10303-21;"]) },
      { path: "bcf/topics.bcf", data: new Blob([new Uint8Array([0, 1, 2, 255])]) },
    ]);

    const source = await readProjectFromZip(new File([zip], "project.zip"));
    expect(source.name).toBe("DiCE-IFC project 2026-10-13 1405");
    expect(source.manifestText).toBe('{"format":"dice-ifc-project"}');
    expect(await source.file("models/Wall.ifc")?.text()).toBe("ISO-10303-21;\nEND-ISO-10303-21;");
    // Binary content comes back byte for byte.
    expect(new Uint8Array(await source.file("bcf/topics.bcf")!.arrayBuffer())).toEqual(
      new Uint8Array([0, 1, 2, 255]),
    );
  });

  it("refuses a file that is not a zip, in words the user can act on", async () => {
    const error = await readProjectFromZip(new File(["not a zip"], "notes.zip")).catch((e) => e);
    expect(error).toBeInstanceOf(ProjectFolderError);
    expect(error.code).toBe("notZip");
  });
});
