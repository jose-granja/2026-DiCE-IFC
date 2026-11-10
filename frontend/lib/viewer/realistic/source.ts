"use client";

/**
 * Turning a texture's files into a layer of the renderer's texture array: its
 * colour, and its relief (normal, roughness, occlusion), decoded in the
 * browser at the size the array uses.
 */

import type { TextureFamilyId } from "./classify";
import { estimateDetail, FAMILY_ROUGHNESS, packDetail } from "./relief";

/** Side of every layer in the texture array, in pixels, unless 2K is used (`apply.ts`). */
export const TEXTURE_SIZE = 1024;

export type LoadedTexture = {
  pixels: Uint8ClampedArray;
  size: number;
  /** Relief, roughness and occlusion, `detailSize`² RGBA — `relief.ts`. */
  detail: Uint8ClampedArray;
  detailSize: number;
  /** Published maps, or estimated from the photograph when they would not load. */
  relief: "maps" | "estimated";
  /** Metres one tile covers, width × height. */
  metres: [number, number];
  /** Mean colour, linear RGB 0–1 — what the shader pulls toward the model's colour. */
  mean: [number, number, number];
};

/** The mean colour of RGBA pixels in linear RGB, from every fourth pixel. */
export function linearMean(pixels: Uint8ClampedArray | Uint8Array): [number, number, number] {
  const sum = [0, 0, 0];
  let n = 0;
  for (let at = 0; at + 3 < pixels.length; at += 16) {
    for (let c = 0; c < 3; c += 1) {
      const v = pixels[at + c] / 255;
      sum[c] += v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }
    n += 1;
  }
  return n ? [sum[0] / n, sum[1] / n, sum[2] / n] : [0.5, 0.5, 0.5];
}

/**
 * Fetch an image and decode it to `width` × `height` RGBA. A `data` image (a
 * normal or roughness map) holds numbers, not colours, so no colour profile is
 * applied to it.
 */
export async function decodeImage(
  url: string,
  width: number,
  height: number,
  init: RequestInit,
  kind: "colour" | "data" = "colour",
): Promise<ImageData> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  const bitmap = await createImageBitmap(await response.blob(), {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: "high",
    ...(kind === "data" ? { colorSpaceConversion: "none" as const, premultiplyAlpha: "none" as const } : {}),
  });
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("No 2D canvas to read the texture with.");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, width, height);
}

/** Where a texture's relief is: a normal map (OpenGL convention) and an `arm` map (occlusion, roughness, metalness). */
export type ReliefMaps = { normal: string; arm: string };

/**
 * Decode a texture into one layer of the array: square, `size` pixels, with
 * its relief at half that. A relief map that will not load costs the relief's
 * detail, estimated from the photograph instead, never the texture.
 */
export async function decodeLayer(
  url: string,
  metres: [number, number],
  init: RequestInit,
  family: TextureFamilyId,
  maps: ReliefMaps,
  size = TEXTURE_SIZE,
): Promise<LoadedTexture> {
  const detailSize = size / 2;
  const [image, published] = await Promise.all([
    decodeImage(url, size, size, init),
    Promise.all([
      decodeImage(maps.normal, detailSize, detailSize, init, "data"),
      decodeImage(maps.arm, detailSize, detailSize, init, "data"),
    ])
      .then(([normal, arm]) => packDetail(normal.data, arm.data))
      .catch(() => null),
  ]);
  const detail = published ?? estimateDetail(image.data, size, FAMILY_ROUGHNESS[family], detailSize);
  return {
    pixels: image.data,
    size,
    detail,
    detailSize,
    relief: published ? "maps" : "estimated",
    metres,
    mean: linearMean(image.data),
  };
}

/** Run `task` over `items`, at most `limit` at a time. */
export async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
