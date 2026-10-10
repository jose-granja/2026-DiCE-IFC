/**
 * The shape every point-cloud reader here has, whoever wrote it.
 *
 * Mirrors `StreamingPointSource` from `@ifc-lite/pointcloud` (restated so
 * callers need not import the engine) — `open()` reads what is needed to say how
 * many points there are, `next()` hands them over in pieces.
 */

import type { DecodedPointChunk } from "@ifc-lite/pointcloud";

export type PointSourceInfo = {
  totalPointCount: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  hasColor: boolean;
  hasIntensity: boolean;
  hasClassification: boolean;
};

export interface PointSource {
  open(signal?: AbortSignal): Promise<PointSourceInfo>;
  next(maxPoints: number, signal?: AbortSignal): Promise<DecodedPointChunk | null>;
  close(): void;
}
