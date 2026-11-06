/**
 * Relief and finish for realistic materials (ADR 014): a normal map, a
 * roughness and an ambient occlusion per texture, packed into one RGBA image
 * the renderer keeps beside the colour array.
 *
 * - R, G: the tangent-space normal's x and y, OpenGL convention (green
 *   toward the top of the image), 0–255 for −1…1. z is rebuilt in the shader.
 * - B: roughness, 0–255 for 0–1.
 * - A: ambient occlusion, 255 for none.
 *
 * Poly Haven publishes all three for every texture (`nor_gl`, and `arm`:
 * occlusion, roughness, metalness). 360into publishes a photograph only, so
 * its relief is estimated from the photograph's light and dark (darker reads
 * as deeper: mortar joints, grout, the gaps between boards), and its
 * roughness is the family's usual one, a little rougher in the dark parts.
 * A photograph already has its shadows in it, so no occlusion is added.
 */

import type { TextureFamilyId } from "./classify";

/**
 * Side of every layer of the relief array, in pixels: half the colour's.
 * Relief at 512 over a tile of a metre or two is 2–4 mm a pixel, finer than
 * a building is looked at, for a quarter of the memory.
 */
export const DETAIL_SIZE = 512;

/** How rough each family's surfaces usually are, for textures that do not say. */
export const FAMILY_ROUGHNESS: Record<TextureFamilyId, number> = {
  roofTiles: 0.75,
  stoneMasonry: 0.85,
  brick: 0.85,
  block: 0.9,
  tiles: 0.35,
  stone: 0.55,
  wood: 0.65,
  metal: 0.45,
  plaster: 0.9,
  concrete: 0.85,
  asphalt: 0.95,
  gravel: 0.95,
  soil: 1,
  grass: 0.95,
  carpet: 1,
  vinyl: 0.5,
};

/**
 * How steep an estimated slope is for a change in brightness. Mortar a third
 * darker than the brick over three pixels tilts its edge about 20°; JPEG
 * noise, after the blur, a degree or two.
 */
const ESTIMATE_STRENGTH = 4;

/** How much rougher the darkest parts are than the mean, for estimated roughness. */
const DARK_ROUGHER = 0.3;

/** Brightness at `DETAIL_SIZE`, averaged over each block of `albedo` (sRGB values, not linear: what the eye reads as depth). */
function brightness(albedo: Uint8ClampedArray | Uint8Array, size: number, out: number): Float32Array {
  const step = size / out;
  const h = new Float32Array(out * out);
  for (let row = 0; row < out; row += 1) {
    for (let col = 0; col < out; col += 1) {
      let sum = 0;
      let n = 0;
      const r0 = Math.floor(row * step);
      const c0 = Math.floor(col * step);
      const r1 = Math.max(r0 + 1, Math.floor((row + 1) * step));
      const c1 = Math.max(c0 + 1, Math.floor((col + 1) * step));
      for (let r = r0; r < r1; r += 1) {
        for (let c = c0; c < c1; c += 1) {
          const at = (r * size + c) * 4;
          sum += 0.299 * albedo[at] + 0.587 * albedo[at + 1] + 0.114 * albedo[at + 2];
          n += 1;
        }
      }
      h[row * out + col] = sum / (255 * n);
    }
  }
  return h;
}

/** A 3×3 box blur that wraps round the edges: the textures tile. */
function blurWrapped(h: Float32Array, side: number): Float32Array {
  const out = new Float32Array(h.length);
  for (let row = 0; row < side; row += 1) {
    for (let col = 0; col < side; col += 1) {
      let sum = 0;
      for (let dr = -1; dr <= 1; dr += 1) {
        const r = (row + dr + side) % side;
        for (let dc = -1; dc <= 1; dc += 1) sum += h[r * side + ((col + dc + side) % side)];
      }
      out[row * side + col] = sum / 9;
    }
  }
  return out;
}

/**
 * Estimate a relief layer from a photograph: `albedo` is `size`² RGBA, top row
 * first, and seamless (the slopes wrap round its edges).
 */
export function estimateDetail(
  albedo: Uint8ClampedArray | Uint8Array,
  size: number,
  roughness: number,
  side = DETAIL_SIZE,
): Uint8ClampedArray {
  const h = blurWrapped(brightness(albedo, size, side), side);
  let mean = 0;
  for (const v of h) mean += v;
  mean /= h.length || 1;
  const out = new Uint8ClampedArray(side * side * 4);
  for (let row = 0; row < side; row += 1) {
    const up = ((row - 1 + side) % side) * side;
    const down = ((row + 1) % side) * side;
    for (let col = 0; col < side; col += 1) {
      const left = (col - 1 + side) % side;
      const right = (col + 1) % side;
      // The normal leans against the slope: (−∂h/∂u, −∂h/∂v, 1), v toward the top.
      const nx = (-(h[row * side + right] - h[row * side + left]) / 2) * ESTIMATE_STRENGTH;
      const ny = (-(h[up + col] - h[down + col]) / 2) * ESTIMATE_STRENGTH;
      const length = Math.hypot(nx, ny, 1);
      const at = (row * side + col) * 4;
      out[at] = Math.round((nx / length) * 127.5 + 127.5);
      out[at + 1] = Math.round((ny / length) * 127.5 + 127.5);
      const rough = Math.min(1, Math.max(0.05, roughness + (mean - h[row * side + col]) * DARK_ROUGHER));
      out[at + 2] = Math.round(rough * 255);
      out[at + 3] = 255;
    }
  }
  return out;
}

/**
 * Pack a published normal map (OpenGL convention) and an `arm` map
 * (occlusion, roughness, metalness), both `side`² RGBA, into one relief layer.
 */
export function packDetail(
  normal: Uint8ClampedArray | Uint8Array,
  arm: Uint8ClampedArray | Uint8Array,
): Uint8ClampedArray {
  if (normal.length !== arm.length) throw new Error("The normal and arm maps must be the same size.");
  const out = new Uint8ClampedArray(normal.length);
  for (let at = 0; at < normal.length; at += 4) {
    out[at] = normal[at];
    out[at + 1] = normal[at + 1];
    out[at + 2] = arm[at + 1];
    out[at + 3] = arm[at];
  }
  return out;
}
