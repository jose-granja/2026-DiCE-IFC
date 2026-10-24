import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  annotationsOf,
  cloudScallops,
  hitTest,
  isDegenerate,
  moveAnnotation,
  readAnnotatedSnapshot,
  writeAnnotatedSnapshot,
  type Annotation,
} from "../annotations";

// A real, decodable PNG: `width`×1 px, every pixel `grey`.
function png(width: number, grey: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  const row = Buffer.alloc(1 + width, grey);
  row[0] = 0; // no filter
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(row)),
    chunk("IEND", new Uint8Array()),
  ]));
}

const arrow: Annotation = {
  id: "a1", kind: "arrow", colour: "#e5484d", stroke: 6, from: { x: 0.1, y: 0.2 }, to: { x: 0.6, y: 0.5 },
};
const note: Annotation = {
  id: "t1", kind: "text", colour: "#ffffff", stroke: 6, at: { x: 0.5, y: 0.1 }, text: "Falta\nrevestimento", size: 40,
};

describe("annotations kept inside the snapshot", () => {
  it("give back the clean image and the shapes they were drawn from", () => {
    const base = png(4, 10);
    const composited = png(4, 200);
    const annotated = writeAnnotatedSnapshot(composited, base, [arrow, note]);
    expect(readAnnotatedSnapshot(annotated)).toEqual({ base, shapes: [arrow, note] });
    // A plain snapshot is its own clean image, with nothing on it yet.
    expect(readAnnotatedSnapshot(base)).toBeNull();
    expect(annotationsOf(base)).toEqual({ base, shapes: [] });
  });

  it("leave the image an ordinary PNG: every original chunk, in order, with IEND last", () => {
    const composited = png(4, 200);
    const annotated = writeAnnotatedSnapshot(composited, png(4, 10), [arrow]);
    const types: string[] = [];
    for (let offset = 8; offset < annotated.length; ) {
      const length = new DataView(annotated.buffer).getUint32(offset);
      types.push(String.fromCharCode(...annotated.subarray(offset + 4, offset + 8)));
      offset += 12 + length;
    }
    expect(types).toEqual(["IHDR", "IDAT", "dcAn", "IEND"]);
    expect([...annotated.subarray(0, 8)]).toEqual([...composited.subarray(0, 8)]);
  });

  it("replace their earlier version instead of stacking a second", () => {
    const base = png(4, 10);
    const once = writeAnnotatedSnapshot(png(4, 200), base, [arrow]);
    const twice = writeAnnotatedSnapshot(once, base, [note]);
    expect(readAnnotatedSnapshot(twice)?.shapes).toEqual([note]);
    expect(twice.length).toBeLessThan(once.length + 200);
  });

  it("are ignored when the chunk is not what this app writes — a topic can come from anyone", () => {
    const base = png(4, 10);
    const bad = writeAnnotatedSnapshot(png(4, 200), base, [{ ...arrow, colour: "red" } as Annotation]);
    expect(readAnnotatedSnapshot(bad)).toBeNull();
    // Cut short: not a PNG any more, not a crash.
    expect(readAnnotatedSnapshot(bad.subarray(0, bad.length - 30))).toBeNull();
    expect(() => writeAnnotatedSnapshot(new Uint8Array([1, 2, 3]), base, [arrow])).toThrow();
  });
});

describe("annotation geometry", () => {
  it("bulges a revision cloud outwards on every side, closing on itself", () => {
    const scallops = cloudScallops({ x: 100, y: 100 }, { x: 300, y: 200 }, 6);
    expect(scallops.length).toBeGreaterThan(8);
    expect(scallops[0].from).toEqual(scallops.at(-1)!.to);
    for (const { control } of scallops) {
      const inside = control.x > 100 && control.x < 300 && control.y > 100 && control.y < 200;
      expect(inside).toBe(false);
    }
  });

  it("picks the topmost shape near the pointer, and nothing far from every one", () => {
    const box: Annotation = { id: "r", kind: "rect", colour: "#0090ff", stroke: 3, from: { x: 0, y: 0 }, to: { x: 1, y: 1 } };
    // Width 1000 × height 500: the arrow runs (100,100) → (600,250).
    expect(hitTest([box, arrow], { x: 350, y: 175 }, 1000, 500)?.id).toBe("a1");
    expect(hitTest([arrow], { x: 350, y: 300 }, 1000, 500)).toBeNull();
    expect(hitTest([note], { x: 510, y: 60 }, 1000, 500)?.id).toBe("t1");
  });

  it("moves a shape as a whole, and tells a click from a drag", () => {
    expect(moveAnnotation(arrow, 0.1, -0.1)).toMatchObject({ from: { x: 0.2, y: 0.1 }, to: { x: 0.7, y: 0.4 } });
    expect(moveAnnotation(note, 0.1, 0)).toMatchObject({ at: { x: 0.6, y: 0.1 } });
    expect(isDegenerate({ ...arrow, to: { x: 0.101, y: 0.2 } }, 1000, 500)).toBe(true);
    expect(isDegenerate(arrow, 1000, 500)).toBe(false);
  });
});
