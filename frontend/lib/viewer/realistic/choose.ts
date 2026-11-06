/**
 * The second half of realistic materials' search: among the textures of a
 * material's family, the one whose colour is nearest the colour the model
 * gives it.
 *
 * "Nearest" is measured in CIELAB (ΔE*ab, CIE76), where equal distances look
 * about equally different — RGB distance would call a dark brown nearer to
 * black than to a lighter brown. A texture meant for another kind of surface
 * (a floor texture on a wall) is allowed, at a cost: there may be no wall
 * texture of the right colour, and the right colour matters more.
 */

import type { SurfaceUse } from "./classify";

export type Lab = [number, number, number];

/** sRGB 0–1 → CIELAB (D65). */
export function srgbToLab([r, g, b]: [number, number, number]): Lab {
  const linear = (c: number) => {
    const v = Math.min(1, Math.max(0, c));
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const R = linear(r);
  const G = linear(g);
  const B = linear(b);
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function deltaE(a: Lab, b: Lab): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** What one candidate texture brings to the choice. */
export type TextureCandidate = {
  id: string;
  lab: Lab;
  surfaceUse?: string;
  condition?: string[];
};

/** A texture for the wrong kind of surface costs this much ΔE. */
export const SURFACE_MISMATCH_COST = 12;
/**
 * A broken, mossy or rusted look costs this much, and a merely weathered one
 * a little: models show buildings as designed, not as found.
 */
export const DAMAGED_COST = 15;
export const WEATHERED_COST = 4;
const DAMAGED = new Set(["damaged", "mossy", "rusted", "dirty", "cracked"]);
const WEATHERED = new Set(["weathered", "worn"]);

function surfaceMatches(want: SurfaceUse, have: string | undefined): boolean {
  if (!have) return true;
  if (want === "floor") return have === "floor" || have === "paving";
  if (want === "ground") return have === "ground" || have === "paving";
  return have === want;
}

/** The candidate that scores best, or null for none. */
export function chooseTexture(
  candidates: TextureCandidate[],
  target: Lab,
  surface: SurfaceUse | null,
): { id: string; distance: number } | null {
  let best: { id: string; distance: number; score: number } | null = null;
  for (const candidate of candidates) {
    const distance = deltaE(candidate.lab, target);
    let score = distance;
    if (surface && !surfaceMatches(surface, candidate.surfaceUse)) score += SURFACE_MISMATCH_COST;
    if (candidate.condition?.some((c) => DAMAGED.has(c))) score += DAMAGED_COST;
    else if (candidate.condition?.some((c) => WEATHERED.has(c))) score += WEATHERED_COST;
    // Ties go to the id, so the same model always gets the same textures.
    if (!best || score < best.score || (score === best.score && candidate.id < best.id)) {
      best = { id: candidate.id, distance, score };
    }
  }
  return best ? { id: best.id, distance: best.distance } : null;
}

/**
 * The mean colour of RGBA pixels, in Lab: of the whole image for a flat
 * swatch, or of the middle half for a preview with a frame or a sphere's rim.
 */
export function meanLab(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  region: "all" | "middle" = "middle",
): Lab {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const middle = region === "middle";
  const x0 = middle ? Math.floor(width / 4) : 0;
  const x1 = middle ? Math.ceil((width * 3) / 4) : width;
  const y0 = middle ? Math.floor(height / 4) : 0;
  const y1 = middle ? Math.ceil((height * 3) / 4) : height;
  // Averaged in linear light, as the eye would blend the pattern from afar.
  const toLinear = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const at = (y * width + x) * 4;
      if (pixels[at + 3] < 128) continue;
      r += toLinear(pixels[at]);
      g += toLinear(pixels[at + 1]);
      b += toLinear(pixels[at + 2]);
      n += 1;
    }
  }
  if (n === 0) return [50, 0, 0];
  const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
  return srgbToLab([toSrgb(r / n), toSrgb(g / n), toSrgb(b / n)]);
}
