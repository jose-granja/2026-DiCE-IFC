import { describe, expect, it } from "vitest";
import { decodePointCloud, type DecodedPointCloud } from "../decode";
import { prepareE57 } from "../e57";
import { placePointCloud, suggestFrame } from "../place";
import { crc32c, e57Fixture } from "./e57-fixture";

function point(cloud: DecodedPointCloud, index: number) {
  return [
    cloud.origin[0] + cloud.positions[index * 3],
    cloud.origin[1] - cloud.positions[index * 3 + 2],
    cloud.origin[2] + cloud.positions[index * 3 + 1],
  ];
}

describe("E57 survey coordinates", () => {
  it.each([false, true])("preserves separate translation-only poses (XML before data: %s)", async (xmlFirst) => {
    const blob = new Blob([e57Fixture([
      { points: [[1.125, 2.25, -963.5]], translation: [-13_500, 198_500, 1083.75] },
      { points: [[1.125, 2.25, -963.5]], translation: [-12_500, 198_500, 1093.25] },
    ], { xmlFirst })]);
    const cloud = await decodePointCloud(blob, "e57");
    expect(cloud.pointCount).toBe(2);
    expect(point(cloud, 0)).toEqual([-13_498.875, 198_502.25, 120.25]);
    expect(point(cloud, 1)).toEqual([-12_498.875, 198_502.25, 129.75]);
    expect(suggestFrame(cloud.origin)).toBe("map");
    expect(Math.max(...cloud.positions.map(Math.abs))).toBeLessThan(1001);

    const placed = placePointCloud({ origin: cloud.origin, frame: "map", model: null,
      worldOrigin: { source: "mapConversion", mapPosition: [-13_500, 198_500, 120] } });
    expect(placed.ok).toBe(true);
    if (placed.ok) {
      expect(cloud.positions[0] + placed.transform.offset[0]).toBe(1.125);
      expect(cloud.positions[1] + placed.transform.offset[1]).toBe(0.25);
      expect(cloud.positions[2] + placed.transform.offset[2]).toBe(-2.25);
    }
  });

  it("retains millimetres at large survey coordinates with a complete pose", async () => {
    const cloud = await decodePointCloud(new Blob([e57Fixture([{
      points: [[0, 0, 0], [0.001, 0.002, 0.003]],
      translation: [600_000.123, 4_650_000.456, 100.789],
      rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
    }])]), "e57");
    const first = point(cloud, 0);
    const second = point(cloud, 1);
    expect(second[0] - first[0]).toBeCloseTo(-0.002, 6);
    expect(second[1] - first[1]).toBeCloseTo(0.001, 6);
    expect(second[2] - first[2]).toBeCloseTo(0.003, 6);
    expect(Math.max(...cloud.positions.map(Math.abs))).toBeLessThan(1);
  });

  it("applies a rotation-only pose without inventing a translation", async () => {
    const cloud = await decodePointCloud(new Blob([e57Fixture([{
      points: [[2, 0, 3]], rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
    }])]), "e57");
    expect(point(cloud, 0)[0]).toBeCloseTo(0, 6);
    expect(point(cloud, 0)[1]).toBeCloseTo(2, 6);
    expect(point(cloud, 0)[2]).toBe(3);
  });

  it("finds a survey origin from points when no pose or bounds are present", async () => {
    const cloud = await decodePointCloud(new Blob([e57Fixture([{
      points: [[600_000.123, 4_650_000.456, 100.789], [600_000.124, 4_650_000.458, 100.792]],
    }])]), "e57");
    expect(suggestFrame(cloud.origin)).toBe("map");
    expect(point(cloud, 1)[0] - point(cloud, 0)[0]).toBeCloseTo(0.001, 6);
    expect(Math.max(...cloud.positions.map(Math.abs))).toBeLessThan(1);
  });

  it("keeps thinning aligned across scans while applying each pose once", async () => {
    const points: [number, number, number][] = Array.from({ length: 7 }, (_, i) => [i, 0, 0]);
    const cloud = await decodePointCloud(new Blob([e57Fixture([
      { points, translation: [100_000, 200_000, 50] },
      { points, translation: [100_100, 200_000, 50] },
    ])]), "e57", { maxPoints: 5 });
    expect(cloud.sourcePointCount).toBe(14);
    expect(cloud.pointCount).toBe(5);
    expect(Array.from({ length: cloud.pointCount }, (_, i) => point(cloud, i)[0]))
      .toEqual([100_000, 100_003, 100_006, 100_102, 100_105]);
  });

  it("does not rewrite complete poses or pose-shaped text in CDATA", async () => {
    const blob = new Blob([e57Fixture([{ points: [[1, 2, 3]], translation: [10, 20, 30], rotation: [1, 0, 0, 0] }], {
      description: '<pose type="Structure"><translation type="Structure"><x type="Float">100</x></translation></pose>',
    })]);
    expect(await prepareE57(blob)).toBe(blob);
    expect(point(await decodePointCloud(blob, "e57"), 0)).toEqual([11, 22, 33]);
  });

  it("keeps original bytes and valid CRCs when constructing the private view", async () => {
    const original = e57Fixture([{ points: [[1, 2, 3]], translation: [10, 20, 30] }]);
    const blob = new Blob([original]);
    const prepared = new Uint8Array(await (await prepareE57(blob)).arrayBuffer());
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(original);
    expect(prepared.subarray(1024, original.length)).toEqual(original.subarray(1024));
    const view = new DataView(prepared.buffer);
    for (let page = 0; page < prepared.length; page += 1024) {
      expect(view.getUint32(page + 1020)).toBe(crc32c(prepared.subarray(page, page + 1020)));
    }
  });

  it("rejects truncated XML and honours cancellation", async () => {
    const bytes = e57Fixture([{ points: [[1, 2, 3]], translation: [1, 2, 3] }]);
    await expect(prepareE57(new Blob([bytes.subarray(0, 500)]))).rejects.toThrow(/past the end/);
    const controller = new AbortController();
    controller.abort();
    await expect(prepareE57(new Blob([bytes]), controller.signal)).rejects.toThrow();
  });
});
