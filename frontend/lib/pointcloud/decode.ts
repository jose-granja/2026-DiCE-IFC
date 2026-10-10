/**
 * Decode a point-cloud file into one set of typed arrays the viewer can draw.
 *
 * Pure with respect to the browser — it takes a `Blob` and returns arrays — so
 * it runs in a Web Worker in the app (`lib/workers/pointcloud.worker.ts`) and in
 * plain Node under test. The format readers are `@ifc-lite/pointcloud`'s; this
 * adds the three things the viewer needs and they do not do:
 *
 * - **A local origin, subtracted in float64.** Survey coordinates are large
 *   (an ETRS89 / PT-TM06 easting is around 10⁵, a UTM northing around 10⁶), and
 *   float32 has about seven significant digits: stored raw, a point cloud
 *   shimmers and steps by centimetres to metres. The origin is taken from the
 *   file's own extent, subtracted before narrowing, and handed back so the
 *   caller can put it where it belongs.
 * - **A point budget.** A scan is routinely a few hundred million points. The
 *   cloud is thinned evenly to `maxPoints` rather than failing, and says so.
 * - **The viewer's axes.** Point clouds are Z-up like IFC; the scene is Y-up
 *   (`render = (x, z, −y)`, see `lib/viewer/federation.ts`). The swap is done
 *   here, once, while copying.
 */

import {
  AsciiPointsStreamingSource,
  E57StreamingSource,
  LasStreamingSource,
  PcdStreamingSource,
  PlyStreamingSource,
  parseLasHeader,
} from "@ifc-lite/pointcloud";

import { createLazSource, type LazPerfLoader } from "./laz";
import type { PointCloudFormat } from "./formats";
import type { PointSource } from "./source";

type Triple = [number, number, number];

export type DecodedPointCloud = {
  /** `[x, y, z, …]` in the scene's Y-up frame, relative to `origin`. */
  positions: Float32Array;
  /** `[r, g, b, …]`, 0–255. Null when the file carries no colour. */
  colours: Uint8Array | null;
  /** Raw per-point intensity. Null when the file carries none. */
  intensities: Uint16Array | null;
  /** What was subtracted from every point: the file's own axes (east, north, up), float64. */
  origin: Triple;
  /** Extent of `positions`, scene frame. */
  bounds: { min: Triple; max: Triple };
  pointCount: number;
  /** How many the file holds. More than `pointCount` when it was thinned. */
  sourcePointCount: number;
};

export type DecodeOptions = {
  /** Upper bound on points kept. Default 8 million. */
  maxPoints?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** Where `laz-perf` comes from; tests supply the Node build. */
  loadLazPerf?: LazPerfLoader;
};

export const DEFAULT_MAX_POINTS = 8_000_000;
const CHUNK_POINTS = 250_000;
const ASCII_SAMPLE_BYTES = 1024 * 1024;

function makeSource(
  format: PointCloudFormat,
  blob: Blob,
  stride: number,
  originOffset: Triple | undefined,
  loadLazPerf: LazPerfLoader | undefined,
): PointSource {
  const options = { downsample: { stride }, originOffset };
  switch (format) {
    case "las":
      return new LasStreamingSource(blob, options);
    case "laz":
      return createLazSource(blob, { stride, originOffset, load: loadLazPerf });
    case "ply":
      return new PlyStreamingSource(blob, options);
    case "pcd":
      return new PcdStreamingSource(blob, options);
    case "e57":
      return new E57StreamingSource(blob, options);
    case "pts":
    case "xyz":
      return new AsciiPointsStreamingSource(blob, format, options);
  }
}

/** The formats whose reader can skip points cheaply instead of decoding them to discard them. */
const SKIPS_NATIVELY: ReadonlySet<PointCloudFormat> = new Set(["las", "laz", "e57"]);

const centreOf = (box: { min: number[]; max: number[] }): Triple => {
  const centre = box.min.map((low, axis) => Math.round((low + box.max[axis]) / 2)) as Triple;
  return centre.every(Number.isFinite) ? centre : [0, 0, 0];
};

/**
 * A point near the middle of the cloud, in the file's own coordinates.
 *
 * It only has to be *near*: float32 keeps a millimetre at a kilometre. So the
 * header will do for LAS and LAZ, and for the text formats the first megabyte
 * of a file that is stored in scan order is plenty.
 */
async function findOrigin(
  format: PointCloudFormat,
  blob: Blob,
  loadLazPerf: LazPerfLoader | undefined,
  signal?: AbortSignal,
): Promise<Triple> {
  try {
    if (format === "las" || format === "laz") {
      return centreOf(parseLasHeader(await blob.slice(0, 4096).arrayBuffer()).bbox);
    }

    let sample = blob;
    if ((format === "pts" || format === "xyz") && blob.size > ASCII_SAMPLE_BYTES) {
      const head = new Uint8Array(await blob.slice(0, ASCII_SAMPLE_BYTES).arrayBuffer());
      // A cut-off last line would be read as a point with missing columns.
      const lastNewline = head.lastIndexOf(0x0a);
      sample = new Blob([lastNewline > 0 ? head.subarray(0, lastNewline + 1) : head]);
    }

    const probe = makeSource(format, sample, 1, undefined, loadLazPerf);
    try {
      return centreOf((await probe.open(signal)).bbox);
    } finally {
      probe.close();
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // Without an origin the cloud is still drawn, only less precisely.
    return [0, 0, 0];
  }
}

export async function decodePointCloud(
  blob: Blob,
  format: PointCloudFormat,
  options: DecodeOptions = {},
): Promise<DecodedPointCloud> {
  const { signal, onProgress, loadLazPerf } = options;
  const maxPoints = Math.max(1, options.maxPoints ?? DEFAULT_MAX_POINTS);

  const origin = await findOrigin(format, blob, loadLazPerf, signal);
  const offset = origin.some((value) => value !== 0) ? origin : undefined;

  let source = makeSource(format, blob, 1, offset, loadLazPerf);
  let skipEvery = 1;
  try {
    let info = await source.open(signal);
    const sourcePointCount = info.totalPointCount;

    if (sourcePointCount > maxPoints) {
      const stride = Math.ceil(sourcePointCount / maxPoints);
      if (SKIPS_NATIVELY.has(format)) {
        source.close();
        source = makeSource(format, blob, stride, offset, loadLazPerf);
        info = await source.open(signal);
      } else {
        skipEvery = stride;
      }
    }

    const capacity = Math.min(info.totalPointCount, maxPoints) + 1024;
    let positions = new Float32Array(capacity * 3);
    let colours = info.hasColor ? new Uint8Array(capacity * 3) : null;
    let intensities = info.hasIntensity ? new Uint16Array(capacity) : null;
    let sawColour = false;
    let sawIntensity = false;
    let count = 0;
    let seen = 0;

    const low: Triple = [Infinity, Infinity, Infinity];
    const high: Triple = [-Infinity, -Infinity, -Infinity];

    const grow = (needed: number) => {
      if (needed <= positions.length / 3) return;
      const size = Math.max(needed, Math.ceil((positions.length / 3) * 1.5));
      const next = new Float32Array(size * 3);
      next.set(positions.subarray(0, count * 3));
      positions = next;
      if (colours) {
        const nextColours = new Uint8Array(size * 3);
        nextColours.set(colours.subarray(0, count * 3));
        colours = nextColours;
      }
      if (intensities) {
        const nextIntensities = new Uint16Array(size);
        nextIntensities.set(intensities.subarray(0, count));
        intensities = nextIntensities;
      }
    };

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const chunk = await source.next(CHUNK_POINTS, signal);
      if (!chunk) break;

      grow(count + chunk.pointCount);
      const from = chunk.positions;
      for (let i = 0; i < chunk.pointCount; i += 1) {
        const index = seen;
        seen += 1;
        if (skipEvery > 1 && index % skipEvery !== 0) continue;

        const x = from[i * 3];
        const y = from[i * 3 + 1];
        const z = from[i * 3 + 2];
        if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) continue;

        // Z-up → Y-up: render = (x, z, −y).
        const at = count * 3;
        positions[at] = x;
        positions[at + 1] = z;
        positions[at + 2] = -y;

        if (x < low[0]) low[0] = x;
        if (z < low[1]) low[1] = z;
        if (-y < low[2]) low[2] = -y;
        if (x > high[0]) high[0] = x;
        if (z > high[1]) high[1] = z;
        if (-y > high[2]) high[2] = -y;

        if (colours && chunk.colors) {
          colours[at] = Math.round(chunk.colors[i * 3] * 255);
          colours[at + 1] = Math.round(chunk.colors[i * 3 + 1] * 255);
          colours[at + 2] = Math.round(chunk.colors[i * 3 + 2] * 255);
          sawColour = true;
        }
        if (intensities && chunk.intensities) {
          intensities[count] = chunk.intensities[i];
          sawIntensity = true;
        }
        count += 1;
      }
      onProgress?.(Math.min(seen, sourcePointCount), sourcePointCount);
    }

    if (count === 0) throw new Error("The file holds no points.");

    return {
      positions: positions.slice(0, count * 3),
      colours: colours && sawColour ? colours.slice(0, count * 3) : null,
      intensities: intensities && sawIntensity ? intensities.slice(0, count) : null,
      origin,
      bounds: { min: low, max: high },
      pointCount: count,
      sourcePointCount,
    };
  } finally {
    source.close();
  }
}
