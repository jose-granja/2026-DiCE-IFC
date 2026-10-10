/**
 * How a point cloud is coloured.
 *
 * `rgb` is what the scanner captured and what people expect first; the others
 * exist because a lot of clouds have no colour at all (a bare LAS from airborne
 * LiDAR is intensity and height only) and because a height ramp is the quickest
 * way to see that a cloud and a model are at the same level.
 */

export type PointColourMode = "rgb" | "intensity" | "height" | "flat";

export type ColourSource = {
  /** Scene-frame positions, `[x, y, z, …]` with `y` up. */
  positions: Float32Array;
  colours: Uint8Array | null;
  intensities: Uint16Array | null;
};

/** The modes a given cloud can actually show. */
export function availableModes(source: Pick<ColourSource, "colours" | "intensities">): PointColourMode[] {
  const modes: PointColourMode[] = [];
  if (source.colours) modes.push("rgb");
  if (source.intensities) modes.push("intensity");
  modes.push("height", "flat");
  return modes;
}

export function defaultMode(source: Pick<ColourSource, "colours" | "intensities">): PointColourMode {
  return availableModes(source)[0];
}

/** Blue → cyan → green → yellow → red. */
const RAMP: ReadonlyArray<readonly [number, number, number]> = [
  [49, 54, 149],
  [69, 117, 180],
  [116, 173, 209],
  [171, 217, 233],
  [255, 255, 191],
  [253, 174, 97],
  [244, 109, 67],
  [215, 48, 39],
];

export function rampColour(t: number): [number, number, number] {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  const scaled = clamped * (RAMP.length - 1);
  const index = Math.min(RAMP.length - 2, Math.floor(scaled));
  const fraction = scaled - index;
  const low = RAMP[index];
  const high = RAMP[index + 1];
  return [
    low[0] + (high[0] - low[0]) * fraction,
    low[1] + (high[1] - low[1]) * fraction,
    low[2] + (high[2] - low[2]) * fraction,
  ];
}

/**
 * The value below which `fraction` of the data lies, from a 1024-bin histogram.
 * Exact enough for a colour stretch, and one pass over millions of points.
 */
export function percentile(values: ArrayLike<number>, fraction: number, step = 1, offset = 0): number {
  let low = Infinity;
  let high = -Infinity;
  const count = Math.floor((values.length - offset) / step);
  for (let i = 0; i < count; i += 1) {
    const value = values[offset + i * step];
    if (value < low) low = value;
    if (value > high) high = value;
  }
  if (!(high > low)) return low;

  const bins = 1024;
  const histogram = new Uint32Array(bins);
  const scale = (bins - 1) / (high - low);
  for (let i = 0; i < count; i += 1) {
    histogram[Math.floor((values[offset + i * step] - low) * scale)] += 1;
  }
  const target = count * fraction;
  let seen = 0;
  for (let bin = 0; bin < bins; bin += 1) {
    seen += histogram[bin];
    if (seen >= target) return low + bin / scale;
  }
  return high;
}

/** One RGB triple per point, 0–255. */
export function buildColours(
  mode: PointColourMode,
  source: ColourSource,
  flat: [number, number, number] = [200, 200, 205],
): Uint8Array {
  const count = source.positions.length / 3;
  const out = new Uint8Array(count * 3);

  if (mode === "rgb" && source.colours) {
    out.set(source.colours);
    return out;
  }

  if (mode === "intensity" && source.intensities) {
    // Stretched between the 2nd and 98th percentile: a handful of retroreflective
    // targets would otherwise squash everything else into the dark end.
    const low = percentile(source.intensities, 0.02);
    const high = percentile(source.intensities, 0.98);
    const range = high > low ? high - low : 1;
    for (let i = 0; i < count; i += 1) {
      const grey = Math.round(255 * Math.min(1, Math.max(0, (source.intensities[i] - low) / range)));
      out[i * 3] = grey;
      out[i * 3 + 1] = grey;
      out[i * 3 + 2] = grey;
    }
    return out;
  }

  if (mode === "height") {
    const low = percentile(source.positions, 0.01, 3, 1);
    const high = percentile(source.positions, 0.99, 3, 1);
    const range = high > low ? high - low : 1;
    for (let i = 0; i < count; i += 1) {
      const [r, g, b] = rampColour((source.positions[i * 3 + 1] - low) / range);
      out[i * 3] = r;
      out[i * 3 + 1] = g;
      out[i * 3 + 2] = b;
    }
    return out;
  }

  for (let i = 0; i < count; i += 1) {
    out[i * 3] = flat[0];
    out[i * 3 + 1] = flat[1];
    out[i * 3 + 2] = flat[2];
  }
  return out;
}
