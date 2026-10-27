// @vitest-environment jsdom

/**
 * A picture from the computer as a snapshot. Decoding and drawing need a real
 * browser (e2e/bcf.spec.ts); here: the size it is drawn at, and that a
 * viewpoint which is only a picture is still a valid BCF one.
 */

import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { parseBcf } from "../parse";
import { serializeBcf } from "../serialize";
import { fitWithin, hasViewToRestore, MAX_SNAPSHOT_SIDE, pictureViewpoint } from "../snapshot-file";
import { createTopic, emptyBcfFile } from "../types";
import { validateArchive } from "../validate";

describe("fitWithin", () => {
  it("keeps a picture that already fits", () => {
    expect(fitWithin(1200, 800)).toEqual({ width: 1200, height: 800 });
    expect(fitWithin(MAX_SNAPSHOT_SIDE, 10)).toEqual({ width: MAX_SNAPSHOT_SIDE, height: 10 });
  });

  it("scales a larger one down by its longest side, keeping its shape", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1500, height: 1125 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 1125, height: 1500 });
    // Never down to nothing.
    expect(fitWithin(100_000, 10)).toEqual({ width: 1500, height: 1 });
  });
});

describe("a picture-only viewpoint", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it("has nothing to restore, until it is given a view", () => {
    const viewpoint = pictureViewpoint({ fileName: "snapshot-a.png", bytes: png });
    expect(hasViewToRestore(viewpoint)).toBe(false);
    expect(hasViewToRestore({ ...viewpoint, clippingPlanes: [{ location: [0, 0, 0], direction: [0, 0, 1] }] })).toBe(
      true,
    );
    expect(
      hasViewToRestore({
        ...viewpoint,
        components: { selection: [], defaultVisibility: true, exceptions: [], coloring: [] },
      }),
    ).toBe(true);
  });

  it("is written as valid BCF 3.0 and read back with its picture", async () => {
    const file = emptyBcfFile();
    const topic = createTopic({ title: "Site photo", author: "a@b.c", topicType: "Issue", topicStatus: "Open" });
    const viewpoint = pictureViewpoint({ fileName: "snapshot-a.png", bytes: png });
    file.topics.push({ ...topic, viewpoints: [viewpoint] });

    const { bytes, notes } = serializeBcf(file);
    expect(await validateArchive(bytes)).toEqual([]);
    // No `.bcfv`: it would need a camera, and an invented one sends the reader to the origin.
    expect(notes).toEqual([]);
    expect(Object.keys(unzipSync(bytes)).filter((name) => name.endsWith(".bcfv"))).toEqual([]);

    const parsed = parseBcf(bytes);
    expect(parsed.notes).toEqual([]);
    const [back] = parsed.file.topics[0].viewpoints;
    expect(back.camera).toBeNull();
    expect(back.snapshot?.fileName).toBe("snapshot-a.png");
    expect([...(back.snapshot?.bytes ?? [])]).toEqual([...png]);
    expect(hasViewToRestore(back)).toBe(false);
  });
});
