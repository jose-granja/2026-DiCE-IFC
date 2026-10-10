import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { decodePointCloud } from "../decode";
import { pointCloudFormat, POINT_CLOUD_ACCEPT } from "../formats";
import type { LazPerfModule } from "../laz";

/** A LAS 1.2 file, point format 2 (XYZ, intensity, RGB), coordinates in map units. */
function buildLas(points: Array<{ x: number; y: number; z: number; i?: number; rgb?: [number, number, number] }>) {
  const headerSize = 227;
  const recordLength = 26;
  const buffer = new ArrayBuffer(headerSize + points.length * recordLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes.set([..."LASF"].map((c) => c.charCodeAt(0)), 0);
  view.setUint8(24, 1);
  view.setUint8(25, 2);
  view.setUint16(94, headerSize, true);
  view.setUint32(96, headerSize, true);
  view.setUint32(100, 0, true);
  view.setUint8(104, 2);
  view.setUint16(105, recordLength, true);
  view.setUint32(107, points.length, true);
  const scale = 0.01;
  for (let axis = 0; axis < 3; axis += 1) view.setFloat64(131 + axis * 8, scale, true);
  for (let axis = 0; axis < 3; axis += 1) view.setFloat64(155 + axis * 8, 0, true);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const zs = points.map((p) => p.z);
  view.setFloat64(179, Math.max(...xs), true);
  view.setFloat64(187, Math.min(...xs), true);
  view.setFloat64(195, Math.max(...ys), true);
  view.setFloat64(203, Math.min(...ys), true);
  view.setFloat64(211, Math.max(...zs), true);
  view.setFloat64(219, Math.min(...zs), true);
  points.forEach((point, index) => {
    const at = headerSize + index * recordLength;
    view.setInt32(at, Math.round(point.x / scale), true);
    view.setInt32(at + 4, Math.round(point.y / scale), true);
    view.setInt32(at + 8, Math.round(point.z / scale), true);
    view.setUint16(at + 12, point.i ?? 0, true);
    const [r, g, b] = point.rgb ?? [0, 0, 0];
    view.setUint16(at + 20, r * 257, true);
    view.setUint16(at + 22, g * 257, true);
    view.setUint16(at + 24, b * 257, true);
  });
  return new Blob([buffer]);
}

describe("point cloud formats", () => {
  it("recognises exactly the supported extensions, whatever the case", () => {
    for (const name of ["a.las", "B.LAZ", "c.Ply", "d.pcd", "e.e57", "f.pts", "g.xyz"]) {
      expect(pointCloudFormat(name), name).not.toBeNull();
    }
    expect(pointCloudFormat("model.ifc")).toBeNull();
    expect(pointCloudFormat("scan.las.zip")).toBeNull();
    expect(pointCloudFormat("las")).toBeNull();
    expect(POINT_CLOUD_ACCEPT).toBe(".las,.laz,.ply,.pcd,.e57,.pts,.xyz");
  });
});

describe("decodePointCloud", () => {
  it("keeps survey-scale coordinates precise by subtracting an origin in float64", async () => {
    // PT-TM06-sized eastings and a UTM-sized northing: raw float32 would
    // quantise these to a few centimetres and a metre respectively.
    const base = { x: 170_000.123, y: 4_650_000.456, z: 85.5 };
    const cloud = await decodePointCloud(
      buildLas([
        { ...base, rgb: [255, 0, 0] },
        { x: base.x + 1.25, y: base.y + 2.5, z: base.z + 3, rgb: [0, 255, 0] },
      ]),
      "las",
    );

    expect(cloud.pointCount).toBe(2);
    // Scene axes: x east, y up, z = −north.
    const [x0, y0, z0, x1, y1, z1] = cloud.positions;
    expect(x1 - x0).toBeCloseTo(1.25, 2);
    expect(y1 - y0).toBeCloseTo(3, 2);
    expect(z1 - z0).toBeCloseTo(-2.5, 2);
    // Each point is where it should be once the origin is put back.
    expect(cloud.origin[0] + x0).toBeCloseTo(base.x, 1);
    expect(cloud.origin[1] + -z0).toBeCloseTo(base.y, 1);
    expect(cloud.origin[2] + y0).toBeCloseTo(base.z, 1);
    // And what is stored is small, which is the point.
    expect(Math.max(...cloud.positions.map(Math.abs))).toBeLessThan(10);
    expect(Array.from(cloud.colours ?? [])).toEqual([255, 0, 0, 0, 255, 0]);
  });

  it("thins a large cloud evenly instead of refusing it, and says so", async () => {
    const points = Array.from({ length: 1000 }, (_, i) => ({ x: i, y: 0, z: 0 }));
    const cloud = await decodePointCloud(buildLas(points), "las", { maxPoints: 100 });
    expect(cloud.sourcePointCount).toBe(1000);
    expect(cloud.pointCount).toBeLessThanOrEqual(100);
    expect(cloud.pointCount).toBeGreaterThan(50);
    // Evenly: the thinned cloud still spans the whole extent.
    expect(cloud.bounds.max[0] - cloud.bounds.min[0]).toBeGreaterThan(900);
  });

  it("reads XYZ and PTS text, with and without colour", async () => {
    const xyz = await decodePointCloud(new Blob(["1 2 3\n4 5 6\n"]), "xyz");
    expect(xyz.pointCount).toBe(2);
    expect(xyz.colours).toBeNull();

    // PTS: a count line, then X Y Z intensity R G B.
    const pts = await decodePointCloud(
      new Blob(["2\n1 2 3 100 255 0 0\n4 5 6 200 0 0 255\n"]),
      "pts",
    );
    expect(pts.pointCount).toBe(2);
    expect(Array.from(pts.colours ?? [])).toEqual([255, 0, 0, 0, 0, 255]);
    expect(pts.intensities).not.toBeNull();
  });

  it("recentres a text cloud whose coordinates are survey-sized", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `${600_000 + i} ${4_100_000 + i * 2} ${10 + i}`);
    const cloud = await decodePointCloud(new Blob([lines.join("\n") + "\n"]), "xyz");
    expect(cloud.origin[0]).toBeGreaterThan(599_000);
    expect(Math.max(...cloud.positions.map(Math.abs))).toBeLessThan(200);
  });

  it("reads an ASCII PLY", async () => {
    const ply = [
      "ply",
      "format ascii 1.0",
      "element vertex 3",
      "property float x",
      "property float y",
      "property float z",
      "property uchar red",
      "property uchar green",
      "property uchar blue",
      "end_header",
      "0 0 0 255 0 0",
      "1 0 0 0 255 0",
      "0 1 2 0 0 255",
      "",
    ].join("\n");
    const cloud = await decodePointCloud(new Blob([ply]), "ply");
    expect(cloud.pointCount).toBe(3);
    expect(cloud.colours).not.toBeNull();
    // z = 2 is up in the file, so it is y in the scene.
    expect(cloud.bounds.max[1] - cloud.bounds.min[1]).toBeCloseTo(2, 5);
  });

  it("reads an ASCII PCD", async () => {
    const pcd = [
      "# .PCD v0.7",
      "VERSION 0.7",
      "FIELDS x y z",
      "SIZE 4 4 4",
      "TYPE F F F",
      "COUNT 1 1 1",
      "WIDTH 3",
      "HEIGHT 1",
      "VIEWPOINT 0 0 0 1 0 0 0",
      "POINTS 3",
      "DATA ascii",
      "0 0 0",
      "1 0 0",
      "0 1 0",
      "",
    ].join("\n");
    const cloud = await decodePointCloud(new Blob([pcd]), "pcd");
    expect(cloud.pointCount).toBe(3);
  });

  it("fails with a message, not a hang, on a file that is not a point cloud", async () => {
    await expect(decodePointCloud(new Blob(["not a point cloud"]), "las")).rejects.toThrow();
    await expect(decodePointCloud(new Blob([""]), "xyz")).rejects.toThrow();
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      decodePointCloud(buildLas([{ x: 0, y: 0, z: 0 }]), "las", { signal: controller.signal }),
    ).rejects.toThrow();
  });
});

/*
  LAZ needs a compressed file and a decoder. There is no compressor here, so the
  check runs against whatever file is named in POINT_CLOUD_TEST_LAZ and skips
  without one — the same arrangement as the real signed container in
  `lib/signing/__tests__/real-container.test.ts`.
*/
const lazFixture = process.env.POINT_CLOUD_TEST_LAZ;
describe.skipIf(!lazFixture || !existsSync(lazFixture))("a real .laz file", () => {
  it("decodes through laz-perf", async () => {
    const require = createRequire(import.meta.url);
    const { createLazPerf } = require("laz-perf") as {
      createLazPerf: (options?: object) => Promise<LazPerfModule>;
    };
    const bytes = readFileSync(lazFixture as string);
    const cloud = await decodePointCloud(new Blob([bytes]), "laz", {
      maxPoints: 200_000,
      loadLazPerf: () => createLazPerf(),
    });
    expect(cloud.pointCount).toBeGreaterThan(1000);
    expect(cloud.pointCount).toBeLessThanOrEqual(200_000);
    expect(Number.isFinite(cloud.bounds.min[0])).toBe(true);
    expect(cloud.sourcePointCount).toBeGreaterThanOrEqual(cloud.pointCount);
  });
});

describe("the shipped fixtures", () => {
  const fixture = (name: string) => {
    const path = new URL(`../../../fixtures/pointcloud/${name}`, import.meta.url);
    return new Blob([readFileSync(path)]);
  };

  it.each(["las", "ply", "pcd", "xyz", "pts"] as const)("reads patch.%s", async (format) => {
    const cloud = await decodePointCloud(fixture(`patch.${format}`), format);
    expect(cloud.pointCount).toBe(1968);
    // A 5 m wide patch with a wall 3 m high, whatever the file format.
    expect(cloud.bounds.max[1] - cloud.bounds.min[1]).toBeCloseTo(2.875, 1);
  });

  it("recovers the survey position from the LAS, and the same patch from the local files", async () => {
    const las = await decodePointCloud(fixture("patch.las"), "las");
    expect(Math.round(las.origin[0] / 10) * 10).toBe(-40000);
    expect(Math.round(las.origin[1] / 10) * 10).toBe(180000);
    // Close to the origin, so float32 keeps its millimetres.
    expect(Math.max(...las.positions.map(Math.abs))).toBeLessThan(5);
  });
});
