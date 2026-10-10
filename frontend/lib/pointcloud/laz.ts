/**
 * A `.laz` reader for `@ifc-lite/pointcloud`'s `StreamingPointSource` contract.
 *
 * The package ships a LAZ source of its own, and it cannot run here: it finds
 * the `laz-perf` WebAssembly through a Vite-only `?url` import that Turbopack
 * cannot build (see `next.config.ts` and `scripts/copy-cesium-assets.mts`). This
 * is the same algorithm — read the header, hand the bytes to `LASZip`, pull
 * records through, decode them with the package's own `decodeLasPoints` — with
 * the library loaded from where `copy:cesium` put it instead.
 */

import {
  decodeLasPoints,
  parseLasHeader,
  sampleMaxRgbChannel,
  type DecodedPointChunk,
  type LasHeader,
} from "@ifc-lite/pointcloud";

import type { PointSource, PointSourceInfo } from "./source";

/** The part of laz-perf's emscripten module this reads through. */
export interface LazPerfModule {
  LASZip: new () => {
    delete(): void;
    open(ptr: number, length: number): void;
    getPoint(dest: number): void;
    getPointLength(): number;
  };
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
}

export type LazPerfLoader = () => Promise<LazPerfModule>;

const LAZ_PERF_WASM = "/laz-perf/laz-perf.wasm";

let shared: Promise<LazPerfModule> | null = null;

/** The served build. Memoised, and forgotten on failure so the next file retries. */
export const loadServedLazPerf: LazPerfLoader = () => {
  shared ??= (async () => {
    const response = await fetch(LAZ_PERF_WASM);
    if (!response.ok) {
      throw new Error(
        `The LAZ decoder is missing (${response.status} for ${LAZ_PERF_WASM}). Run \`npm run copy:cesium\`.`,
      );
    }
    const wasmBinary = new Uint8Array(await response.arrayBuffer());
    // A served URL, not a module either bundler resolves. Held in a variable so
    // that Vite (which runs the tests) does not try to, and `turbopackIgnore`
    // keeps Turbopack's hands off it, as for `/sqlite/index.mjs`.
    const url = "/laz-perf/laz-perf.mjs";
    const loaded = (await import(/* turbopackIgnore: true */ /* @vite-ignore */ url)) as {
      default: (options: { wasmBinary: Uint8Array }) => Promise<LazPerfModule>;
    };
    return loaded.default({ wasmBinary });
  })().catch((error: unknown) => {
    shared = null;
    throw error;
  });
  return shared;
};

function abortIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

export function createLazSource(
  blob: Blob,
  options: {
    stride?: number;
    originOffset?: readonly [number, number, number];
    load?: LazPerfLoader;
  } = {},
): PointSource {
  const stride = Math.max(1, Math.floor(options.stride ?? 1));
  const originOffset = options.originOffset;
  const load = options.load ?? loadServedLazPerf;

  let mod: LazPerfModule | null = null;
  let laszip: InstanceType<LazPerfModule["LASZip"]> | null = null;
  let header: LasHeader | null = null;
  let filePtr = 0;
  let pointPtr = 0;
  let pointSize = 0;
  let rgbScale = 1;
  let cursor = 0;

  const info = (parsed: LasHeader): PointSourceInfo => {
    const shift = originOffset ?? [0, 0, 0];
    return {
      totalPointCount: Math.ceil(parsed.pointCount / stride),
      bbox: {
        min: [
          parsed.bbox.min[0] - shift[0],
          parsed.bbox.min[1] - shift[1],
          parsed.bbox.min[2] - shift[2],
        ],
        max: [
          parsed.bbox.max[0] - shift[0],
          parsed.bbox.max[1] - shift[1],
          parsed.bbox.max[2] - shift[2],
        ],
      },
      hasColor: parsed.hasRgb,
      hasIntensity: true,
      hasClassification: true,
    };
  };

  const release = () => {
    try {
      laszip?.delete();
    } catch {
      /* already gone */
    }
    if (mod && pointPtr) mod._free(pointPtr);
    if (mod && filePtr) mod._free(filePtr);
    laszip = null;
    mod = null;
    header = null;
    filePtr = 0;
    pointPtr = 0;
  };

  return {
    async open(signal) {
      abortIfAborted(signal);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      abortIfAborted(signal);
      const parsed = parseLasHeader(bytes);
      const loaded = await load();
      abortIfAborted(signal);

      try {
        mod = loaded;
        filePtr = loaded._malloc(bytes.byteLength);
        loaded.HEAPU8.set(bytes, filePtr);
        laszip = new loaded.LASZip();
        laszip.open(filePtr, bytes.byteLength);
        pointSize = laszip.getPointLength();
        pointPtr = loaded._malloc(pointSize);

        if (parsed.hasRgb) {
          // 8-bit colour stored in 16-bit fields is common and the header does
          // not say which it is: look at the first few thousand points, then
          // start the forward-only iterator again.
          const probe = Math.min(4096, parsed.pointCount);
          const sample = new Uint8Array(probe * pointSize);
          for (let i = 0; i < probe; i += 1) {
            laszip.getPoint(pointPtr);
            sample.set(loaded.HEAPU8.subarray(pointPtr, pointPtr + pointSize), i * pointSize);
          }
          const max = sampleMaxRgbChannel(sample, parsed);
          rgbScale = max > 0 && max <= 255 ? 65535 / 255 : 1;
          laszip.delete();
          laszip = new loaded.LASZip();
          laszip.open(filePtr, bytes.byteLength);
        }

        header = parsed;
        cursor = 0;
        return info(parsed);
      } catch (error) {
        release();
        throw error;
      }
    },

    async next(maxPoints, signal): Promise<DecodedPointChunk | null> {
      abortIfAborted(signal);
      if (!header || !mod || !laszip) throw new Error("open() must be awaited before next().");
      if (cursor >= header.pointCount) return null;

      const take = Math.min(maxPoints * stride, header.pointCount - cursor);
      const kept = Math.ceil(take / stride);
      const slab = new Uint8Array(kept * pointSize);
      let written = 0;
      for (let i = 0; i < take; i += 1) {
        laszip.getPoint(pointPtr);
        if (i % stride === 0) {
          slab.set(mod.HEAPU8.subarray(pointPtr, pointPtr + pointSize), written * pointSize);
          written += 1;
        }
      }
      cursor += take;
      return decodeLasPoints(slab, header, kept, pointSize, rgbScale, originOffset);
    },

    close: release,
  };
}
