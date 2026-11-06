"use client";

/**
 * What every texture library looks like to realistic materials (ADR 014):
 * candidates for a family, a measured colour per candidate, and a texture to
 * draw. Poly Haven (`polyhaven.ts`) and 360into (`into360.ts`) are the two;
 * `apply.ts` asks both and keeps the nearest colour, whichever it came from.
 */

import { meanLab, type Lab } from "./choose";
import type { TextureFamily, TextureFamilyId } from "./classify";
import { DETAIL_SIZE, estimateDetail, FAMILY_ROUGHNESS, packDetail } from "./relief";

export type TextureSourceId = "polyhaven" | "360into";

export type SourceCandidate = {
  /** `source:id`, unique across sources. */
  key: string;
  source: TextureSourceId;
  id: string;
  name: string;
  /** The texture's own page, for the list of what was applied. */
  page: string;
  /** The family it was a candidate for: its usual roughness, when the library gives none. */
  family: TextureFamilyId;
  surfaceUse?: string;
  condition?: string[];
  /**
   * A colour guessed from the texture's own words ("beige", "anthracite"…),
   * for sources whose colours are dear to measure: only the nearest guesses
   * are measured. Absent when the source measures everything.
   */
  estimate?: Lab | null;
  /** Source-specific data `colour` and `load` need. */
  data: unknown;
};

/** An image to average for a candidate's colour: all of a flat swatch, the middle of a sphere. */
export type Preview = { url: string; region: "all" | "middle" };

/** How a source's requests identify the site: Poly Haven's terms ask for the origin as `Referer`. */
export type Referrer = "origin" | "none";

export type TextureSource = {
  id: TextureSourceId;
  /** Measuring every candidate is cheap (tiny previews); otherwise shortlist by `estimate`. */
  measureAll: boolean;
  /** How many requests to have in flight at once. */
  concurrency: number;
  referrer: Referrer;
  candidates(family: TextureFamily): Promise<SourceCandidate[]>;
  /** Where a candidate's measured colour is kept; changes when the texture does. */
  colourKey(candidate: SourceCandidate): string;
  /** The images to average, best first: the next is tried when one cannot be read. */
  previews(candidate: SourceCandidate): Preview[];
  load(candidate: SourceCandidate): Promise<LoadedTexture>;
};

export const requestInit = (referrer: Referrer): RequestInit =>
  referrer === "origin" ? { referrerPolicy: "origin", credentials: "omit" } : { credentials: "omit" };

/** One colour to measure: the first preview that can be read wins. */
export type ColourJob = { previews: Preview[]; referrer: Referrer };

/** Measure one job here, on whatever thread this runs on. */
export async function measureJob(job: ColourJob): Promise<Lab | null> {
  for (const preview of job.previews) {
    try {
      return await measureColour(preview.url, preview.region, requestInit(job.referrer));
    } catch {
      // The next preview, if any.
    }
  }
  return null;
}

/** Side of every layer in the texture array, in pixels. */
export const TEXTURE_SIZE = 1024;

export type LoadedTexture = {
  pixels: Uint8ClampedArray;
  size: number;
  /** Relief, roughness and occlusion, `detailSize`² RGBA — `relief.ts`. */
  detail: Uint8ClampedArray;
  detailSize: number;
  /** Published maps, or estimated from the photograph. */
  relief: "maps" | "estimated";
  /** Metres one tile covers, width × height. */
  metres: [number, number];
  /** Mean colour, linear RGB 0–1 — what the shader pulls toward the model's colour. */
  mean: [number, number, number];
};

/** Real-world size in mm → metres, clamped to what reads as a material. */
export function tileMetresFromMm(mm: number | undefined): number {
  return mm && Number.isFinite(mm) && mm >= 100 ? Math.min(10, Math.max(0.25, mm / 1000)) : 2;
}

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

/** `url` when it is https on `host`, else null: an API's answer is data, not a list of places to go. */
export function onHost(url: string, host: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === host ? parsed : null;
  } catch {
    return null;
  }
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
  if (!response.ok) throw new Error(`${new URL(url).hostname} answered ${response.status}.`);
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

/** Where a texture's published relief is: a normal map (OpenGL convention) and an `arm` map. */
export type ReliefMaps = { normal: string; arm: string };

/**
 * Decode a texture into one layer of the array: square, `TEXTURE_SIZE`, with
 * its relief. Published maps are used when given and readable; otherwise the
 * relief is estimated from the photograph, so a missing map costs relief
 * detail, never the texture.
 */
export async function decodeLayer(
  url: string,
  metres: [number, number],
  init: RequestInit,
  family: TextureFamilyId,
  maps?: () => Promise<ReliefMaps | null>,
): Promise<LoadedTexture> {
  const [image, published] = await Promise.all([
    decodeImage(url, TEXTURE_SIZE, TEXTURE_SIZE, init),
    (async () => {
      const where = await maps?.();
      if (!where) return null;
      const [normal, arm] = await Promise.all([
        decodeImage(where.normal, DETAIL_SIZE, DETAIL_SIZE, init, "data"),
        decodeImage(where.arm, DETAIL_SIZE, DETAIL_SIZE, init, "data"),
      ]);
      return packDetail(normal.data, arm.data);
    })().catch(() => null),
  ]);
  const detail = published ?? estimateDetail(image.data, TEXTURE_SIZE, FAMILY_ROUGHNESS[family]);
  return {
    pixels: image.data,
    size: TEXTURE_SIZE,
    detail,
    detailSize: DETAIL_SIZE,
    relief: published ? "maps" : "estimated",
    metres,
    mean: linearMean(image.data),
  };
}

/** Measure a preview's mean colour: all of it for a flat swatch, the middle for a sphere. */
export async function measureColour(url: string, region: "all" | "middle", init: RequestInit): Promise<Lab> {
  const image = await decodeImage(url, 32, 32, init);
  return meanLab(image.data, image.width, image.height, region);
}

// ---------------------------------------------------------------------------
// Measured colours, kept in this browser
// ---------------------------------------------------------------------------

/**
 * v2: Poly Haven's colours are read from its flat previews, not the shaded
 * sphere thumbnails v1 used (14 ΔE too dark, measured against 29 diffuse maps).
 */
const COLOUR_KEY = "dice-realistic-colours-v2";
let colours: Record<string, Lab> | null = null;

function colourCache(): Record<string, Lab> {
  if (colours) return colours;
  try {
    colours = JSON.parse(localStorage.getItem(COLOUR_KEY) ?? "{}") as Record<string, Lab>;
  } catch {
    colours = {};
  }
  try {
    localStorage.removeItem("dice-realistic-colours-v1");
  } catch {
    // Nothing to tidy.
  }
  return colours;
}

export function cachedColour(key: string): Lab | null {
  return colourCache()[key] ?? null;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function rememberColour(key: string, lab: Lab): Lab {
  const rounded = lab.map((v) => Math.round(v * 10) / 10) as Lab;
  colourCache()[key] = rounded;
  // Written once a burst of measurements settles, not once per thumbnail.
  if (saveTimer === null) {
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        localStorage.setItem(COLOUR_KEY, JSON.stringify(colourCache()));
      } catch {
        // Private windows and full storage: measured again next time.
      }
    }, 250);
  }
  return rounded;
}

/** Test seam. */
export function resetColourCacheForTests() {
  colours = null;
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
