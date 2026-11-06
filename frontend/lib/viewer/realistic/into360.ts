"use client";

/**
 * 360into (360into.com), realistic materials' second texture library
 * (ADR 014, amended 2026-11-06).
 *
 * Its strength is finished building materials, where Poly Haven is thin:
 * - clean facing brick;
 * - polished limestone, travertine and marble;
 * - paint, precast concrete and parquet.
 *
 * Measured over 41 typical IFC colours, the nearest texture in the right
 * family was 3.6 ΔE away with 360into against 18.1 with Poly Haven.
 * Poly Haven stays for metal, roofing, asphalt and ground, where 360into has
 * a handful of textures or none.
 *
 * One host, `360into.com`, for everything:
 * - `/api/v1/textures?category=<slug>`: the catalogue, a category at a time
 *   and only for the families in use. It has a real-world size per texture
 *   but no colour.
 * - `/thumbs/<slug>.webp`: a 512-pixel crop of the texture itself (within
 *   0.5 ΔE of the full image), averaged here and kept in `localStorage`.
 *   At about 36 kB each, too dear to measure a whole family, so only the
 *   candidates whose own words ("beige", "anthracite"…) put them nearest the
 *   wanted colour are measured.
 * - `direct_url`: the chosen texture, ≤ 3 MB.
 *
 * 360into's categories are assigned by machine and are noisy. Concrete
 * "plates" include pavers, so each category carries the kind of surface it
 * suits, and a mismatch costs what it costs for Poly Haven.
 */

import { srgbToLab, type Lab } from "./choose";
import type { TextureFamily, TextureFamilyId } from "./classify";
import {
  decodeLayer,
  onHost,
  tileMetresFromMm,
  requestInit,
  type LoadedTexture,
  type SourceCandidate,
  type TextureSource,
} from "./source";

export const INTO360_ORIGIN = "https://360into.com";
const HOST = "360into.com";

/** No referrer requirement here: the site's own `no-referrer` stands. */
const REQUEST = requestInit("none");

/** Larger files (a few 4096² JPEGs reach 16 MB) are not worth a 1024² layer. */
export const MAX_FILE_BYTES = 3_000_000;

/** 360into categories per family, with the kind of surface each suits. */
export const INTO360_CATEGORIES: Partial<Record<TextureFamilyId, Array<{ slug: string; surface?: string }>>> = {
  concrete: [
    { slug: "concrete-rough", surface: "wall" },
    { slug: "concrete-precast", surface: "wall" },
    { slug: "concrete" },
    { slug: "concrete-plates", surface: "floor" },
  ],
  plaster: [
    { slug: "plaster", surface: "wall" },
    { slug: "paint-matte", surface: "wall" },
    { slug: "paint-textured", surface: "wall" },
  ],
  brick: [
    { slug: "brick-facing", surface: "wall" },
    { slug: "brick-colored", surface: "wall" },
    { slug: "brick" },
    { slug: "brick-paving", surface: "floor" },
  ],
  block: [{ slug: "brick-paving", surface: "floor" }],
  stone: [{ slug: "stone-tiles" }, { slug: "stone-natural", surface: "wall" }],
  stoneMasonry: [{ slug: "stone-natural", surface: "wall" }],
  wood: [
    { slug: "wood-planks" },
    { slug: "wood-fine" },
    { slug: "wood-panels", surface: "wall" },
    { slug: "wood-raw" },
    { slug: "flooring", surface: "floor" },
  ],
  tiles: [{ slug: "tiles" }],
  metal: [{ slug: "metal", surface: "wall" }],
  roofTiles: [{ slug: "roofing", surface: "roof" }],
  asphalt: [{ slug: "asphalt", surface: "floor" }],
  carpet: [{ slug: "carpet", surface: "floor" }],
  vinyl: [{ slug: "plastic" }],
};

export type Into360Texture = {
  slug: string;
  title: string;
  category?: { slug: string; name?: string };
  tags?: Array<{ slug: string; name?: string }>;
  resolution?: string;
  file_size?: number;
  mime_type?: string;
  direct_url: string;
  thumb_url: string;
  page_url?: string;
  world_size?: { width_mm?: number; height_mm?: number };
  updated_at?: string;
};

const SLUG = /^[a-z0-9-]+$/;
const MIME = /^image\/(jpeg|png|webp)$/;

// ---------------------------------------------------------------------------
// Words → colour, for choosing which thumbnails to measure
// ---------------------------------------------------------------------------

/** Colours named outright. */
const COLOUR_WORDS: Array<[RegExp, [number, number, number]]> = [
  [/\b(white|snow|chalk|alabaster)\b/, [0.93, 0.93, 0.91]],
  [/\b(ivory|cream|pearl|bone|off white|ecru)\b/, [0.91, 0.88, 0.8]],
  [/\b(beige|sand|sandy|buff|bejige)\b/, [0.83, 0.76, 0.62]],
  [/\b(taupe|greige|mushroom)\b/, [0.6, 0.55, 0.5]],
  [/\b(silver|light grey|light gray|pale grey)\b/, [0.76, 0.76, 0.76]],
  [/\b(grey|gray|pewter)\b/, [0.6, 0.6, 0.6]],
  [/\b(anthracite|graphite|charcoal|dark grey|dark gray|carbon)\b/, [0.28, 0.28, 0.3]],
  [/\b(black|ebony|onyx|jet)\b/, [0.12, 0.12, 0.12]],
  [/\b(brown|chocolate|coffee|mocha|umber)\b/, [0.42, 0.29, 0.2]],
  [/\b(honey|amber|golden|tan|ochre)\b/, [0.74, 0.58, 0.38]],
  [/\b(red|burgundy|wine|crimson)\b/, [0.58, 0.22, 0.17]],
  [/\b(terracotta|rust|copper|orange|sienna)\b/, [0.72, 0.42, 0.28]],
  [/\b(yellow|mustard|lemon)\b/, [0.85, 0.75, 0.3]],
  [/\b(green|olive|sage|moss|emerald)\b/, [0.4, 0.5, 0.35]],
  [/\b(teal|turquoise|aqua)\b/, [0.2, 0.5, 0.5]],
  [/\b(blue|navy|azure|cobalt|indigo)\b/, [0.3, 0.42, 0.65]],
  [/\b(pink|rose|blush|salmon)\b/, [0.86, 0.62, 0.62]],
  [/\b(purple|violet|lilac|plum|mauve)\b/, [0.5, 0.36, 0.55]],
];

/** A material's usual colour, used only when no colour is named. */
const MATERIAL_WORDS: Array<[RegExp, [number, number, number]]> = [
  [/\b(limestone|travertine|sandstone)\b/, [0.83, 0.77, 0.65]],
  [/\b(marble|plaster|stucco)\b/, [0.88, 0.87, 0.84]],
  [/\b(concrete|cement|granite|zinc|steel|aluminium|aluminum|galvanised|galvanized)\b/, [0.6, 0.6, 0.6]],
  [/\b(slate|basalt|bitumen|asphalt)\b/, [0.28, 0.28, 0.3]],
  [/\b(walnut|wenge|mahogany)\b/, [0.42, 0.29, 0.2]],
  [/\b(oak|pine|birch|maple|ash|beech|sycamore|spruce)\b/, [0.74, 0.58, 0.38]],
  [/\b(cedar|teak|cherry|clay|brick)\b/, [0.68, 0.42, 0.3]],
];

function averageOf(words: string, table: Array<[RegExp, [number, number, number]]>): Lab | null {
  const found = table.filter(([pattern]) => pattern.test(words)).map(([, rgb]) => srgbToLab(rgb));
  if (!found.length) return null;
  return found
    .reduce((sum, c) => [sum[0] + c[0], sum[1] + c[1], sum[2] + c[2]], [0, 0, 0])
    .map((v) => v / found.length) as Lab;
}

/** A rough colour from a texture's title and tags, or null when they suggest none. */
export function colourFromWords(text: string): Lab | null {
  const words = text.toLowerCase().replace(/[-_]+/g, " ");
  const lab = averageOf(words, COLOUR_WORDS) ?? averageOf(words, MATERIAL_WORDS);
  if (!lab) return null;
  if (/\b(light|pale|bleached|whitewashed)\b/.test(words)) lab[0] = Math.min(100, lab[0] + 12);
  if (/\b(dark|deep|smoked|charred)\b/.test(words)) lab[0] = Math.max(0, lab[0] - 15);
  return lab;
}

// ---------------------------------------------------------------------------
// The texture's own facts
// ---------------------------------------------------------------------------

/** Floor, wall or roof, from the tags first and the category second. */
export function surfaceOf(texture: Into360Texture, categorySurface?: string): string | undefined {
  const tags = new Set((texture.tags ?? []).map((tag) => tag.slug));
  const has = (...names: string[]) => names.some((name) => tags.has(name));
  if (has("roofing", "roof", "roof-tiles")) return "roof";
  if (has("floor", "flooring", "paving", "pavers", "floor-tiles")) return "floor";
  if (has("wall", "wall-cladding", "facade", "cladding", "wall-tiles")) return "wall";
  return categorySurface;
}

const DAMAGED = /\b(damaged|cracked|broken|rust|rusty|rusted|dirty|mossy|ruin)/;
const WEATHERED = /\b(weathered|worn|old|aged|reclaimed|used|distressed|patina)\b/;

export function conditionOf(texture: Into360Texture): string[] {
  const words = `${texture.title} ${(texture.tags ?? []).map((tag) => tag.name ?? tag.slug).join(" ")} ${texture.category?.slug ?? ""}`
    .toLowerCase()
    .replace(/[-_]+/g, " ");
  if (DAMAGED.test(words)) return ["damaged"];
  if (WEATHERED.test(words)) return ["weathered"];
  return ["clean"];
}

/**
 * One tile in metres. `world_size` is given square even for a non-square
 * image (432 of 1,080 are), so the height follows the image's own proportions;
 * the layer is resized to a square, and these metres stretch it back.
 */
export function tileMetres(texture: Into360Texture): [number, number] {
  const width = tileMetresFromMm(texture.world_size?.width_mm);
  const [w, h] = (texture.resolution ?? "").split("x").map(Number);
  const aspect = w > 0 && h > 0 ? h / w : 1;
  return [width, Math.min(10, Math.max(0.25, width * aspect))];
}

function usable(texture: Into360Texture): boolean {
  return (
    SLUG.test(texture.slug) &&
    (!texture.mime_type || MIME.test(texture.mime_type)) &&
    (texture.file_size ?? 0) <= MAX_FILE_BYTES &&
    onHost(texture.direct_url, HOST) !== null &&
    onHost(texture.thumb_url, HOST) !== null
  );
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const categories = new Map<string, Promise<Into360Texture[]>>();
const layers = new Map<string, Promise<LoadedTexture>>();

/** Test seam: forget what this page has fetched. */
export function resetInto360ForTests() {
  categories.clear();
  layers.clear();
}

/** At most this many pages of 100 per category; the largest has 202 textures. */
const MAX_PAGES = 5;

/** One retry: under several requests at once, the odd one fails and then succeeds. */
async function fetchWithRetry(url: string): Promise<Response> {
  const response = await fetch(url, REQUEST).catch(() => null);
  if (response?.ok) return response;
  const second = await fetch(url, REQUEST);
  if (!second.ok) throw new Error(`360into answered ${second.status}.`);
  return second;
}

function fetchCategory(slug: string): Promise<Into360Texture[]> {
  let pending = categories.get(slug);
  if (!pending) {
    pending = (async () => {
      const textures: Into360Texture[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const url = new URL("/api/v1/textures", INTO360_ORIGIN);
        url.searchParams.set("category", slug);
        url.searchParams.set("sort", "name");
        url.searchParams.set("per_page", "100");
        url.searchParams.set("page", String(page));
        const body = (await (await fetchWithRetry(url.href)).json()) as {
          data?: Into360Texture[];
          meta?: { total_pages?: number };
        };
        textures.push(...(body.data ?? []));
        if (page >= (body.meta?.total_pages ?? 1)) break;
      }
      return textures;
    })();
    pending.catch(() => categories.delete(slug));
    categories.set(slug, pending);
  }
  return pending;
}

const colourKey = (texture: Into360Texture) => `360into:${texture.slug}@${texture.updated_at ?? ""}`;

export const into360: TextureSource = {
  id: "360into",
  measureAll: false,
  concurrency: 4,

  async candidates(family: TextureFamily): Promise<SourceCandidate[]> {
    const wanted = INTO360_CATEGORIES[family.id] ?? [];
    // All of a family's categories at once; in order afterwards, so a texture
    // listed twice keeps the first category's surface.
    const fetched = await Promise.all(wanted.map(({ slug }) => fetchCategory(slug)));
    const seen = new Set<string>();
    const out: SourceCandidate[] = [];
    for (const [index, { surface }] of wanted.entries()) {
      for (const texture of fetched[index]) {
        if (seen.has(texture.slug) || !usable(texture)) continue;
        seen.add(texture.slug);
        out.push({
          key: `360into:${texture.slug}`,
          source: "360into",
          family: family.id,
          id: texture.slug,
          name: texture.title,
          page: `${INTO360_ORIGIN}/t/${encodeURIComponent(texture.slug)}`,
          surfaceUse: surfaceOf(texture, surface),
          condition: conditionOf(texture),
          estimate: colourFromWords(`${texture.title} ${(texture.tags ?? []).map((tag) => tag.name ?? tag.slug).join(" ")}`),
          data: texture,
        });
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  },

  referrer: "none",

  colourKey(candidate) {
    return colourKey(candidate.data as Into360Texture);
  },

  previews(candidate) {
    const url = onHost((candidate.data as Into360Texture).thumb_url, HOST);
    return url ? [{ url: url.href, region: "all" }] : [];
  },

  load(candidate) {
    const texture = candidate.data as Into360Texture;
    // By family too: a photograph's estimated roughness is its family's.
    const key = `${texture.slug}|${candidate.family}`;
    let pending = layers.get(key);
    if (!pending) {
      const url = onHost(texture.direct_url, HOST);
      // A photograph only: its relief is estimated from it (`relief.ts`).
      pending = url
        ? decodeLayer(url.href, tileMetres(texture), REQUEST, candidate.family)
        : Promise.reject(new Error("Not a 360into texture URL."));
      pending.catch(() => layers.delete(key));
      layers.set(key, pending);
    }
    return pending;
  },
};
