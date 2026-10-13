import { describe, expect, it } from "vitest";
import { strToU8, unzipSync, Zip, ZipDeflate, zipSync } from "fflate";

import { crc32, readZip, writeZip, ZipFormatError } from "../zip";

const bytes = async (file: Blob) => new Uint8Array(await file.arrayBuffer());

/** A zip inside the zip — what an .xlsx, a .bcf or an .ifczip is. */
const innerZip = zipSync({ "xl/workbook.xml": strToU8("<workbook/>"), "[Content_Types].xml": strToU8("<Types/>") });

describe("crc32", () => {
  it("is the zip polynomial", async () => {
    // The standard check value for CRC-32/ISO-HDLC.
    expect(await crc32(new Blob(["123456789"]))).toBe(0xcbf43926);
    expect(await crc32(new Blob([]))).toBe(0);
  });
});

describe("writing and reading a project zip", () => {
  it("brings back zips stored inside it byte for byte", async () => {
    // The regression: a streaming reader took the inner archive's headers for
    // the outer one's and reported "unknown compression type".
    const archive = await writeZip([
      { path: "Project/project.json", data: new Blob(["{}"]) },
      { path: "Project/clash/clash-matrix.xlsx", data: new Blob([innerZip as BlobPart]) },
      { path: "Project/bcf/topics.bcf", data: new Blob([innerZip as BlobPart]) },
      { path: "Project/models/Wall.ifc", data: new Blob(["ISO-10303-21;"]) },
    ]);
    const files = await readZip(archive);
    expect(files.map((entry) => entry.path)).toEqual([
      "Project/project.json",
      "Project/clash/clash-matrix.xlsx",
      "Project/bcf/topics.bcf",
      "Project/models/Wall.ifc",
    ]);
    expect(await bytes(files[1].file)).toEqual(innerZip);
    expect(unzipSync(await bytes(files[2].file))["xl/workbook.xml"]).toEqual(strToU8("<workbook/>"));
    expect(await files[3].file.text()).toBe("ISO-10303-21;");
    expect(files[3].file.name).toBe("Wall.ifc");
  });

  it("keeps names that are not ASCII", async () => {
    const archive = await writeZip([{ path: "Obra/modelos/Fundações — Bloco A.ifc", data: new Blob(["x"]) }]);
    const [entry] = await readZip(archive);
    expect(entry.path).toBe("Obra/modelos/Fundações — Bloco A.ifc");
  });

  it("writes an archive another zip reader opens", async () => {
    // fflate's own reader, which shares no code with ours.
    const archive = await writeZip([
      { path: "P/a.txt", data: new Blob(["alpha"]) },
      { path: "P/inner.xlsx", data: new Blob([innerZip as BlobPart]) },
    ]);
    const opened = unzipSync(await bytes(archive));
    expect(new TextDecoder().decode(opened["P/a.txt"])).toBe("alpha");
    expect(opened["P/inner.xlsx"]).toEqual(innerZip);
  });

  it("reads a folder the user zipped themselves, compressed", async () => {
    const zipped = zipSync({ "Mine/project.json": strToU8('{"a":1}'), "Mine/models/b.ifc": strToU8("b".repeat(5000)) }, { level: 9 });
    const files = await readZip(new Blob([zipped as BlobPart]));
    expect(await files.find((entry) => entry.path === "Mine/models/b.ifc")!.file.text()).toBe("b".repeat(5000));
  });

  it("reads an archive whose entries put their sizes after the data", async () => {
    // What streaming zippers produce; the central directory has the sizes.
    const chunks: Uint8Array[] = [];
    const done = new Promise<void>((resolve) => {
      const zip = new Zip((_error, data, final) => {
        chunks.push(data);
        if (final) resolve();
      });
      const entry = new ZipDeflate("S/project.json", { level: 6 });
      zip.add(entry);
      entry.push(strToU8('{"streamed":true}'), true);
      zip.end();
    });
    await done;
    const [entry] = await readZip(new Blob(chunks as BlobPart[]));
    expect(await entry.file.text()).toBe('{"streamed":true}');
  });

  it("says when a file is not a zip", async () => {
    await expect(readZip(new Blob(["just text, no archive here"]))).rejects.toBeInstanceOf(ZipFormatError);
  });
});
