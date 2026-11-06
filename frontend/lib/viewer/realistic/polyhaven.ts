"use client";

/**
 * Poly Haven (polyhaven.com), one of realistic materials' two texture
 * libraries (ADR 014).
 *
 * Three hosts, each asked only for public library data, never for anything
 * of the model's. Poly Haven's API terms ask a client to identify itself by
 * `Referer` or user agent. A browser cannot set its user agent, and this site
 * sends no `Referer` (`Referrer-Policy: no-referrer`), so these requests, and
 * only these, send the site's origin as `Referer`.
 *
 * - `api.polyhaven.com/assets?t=textures`: the catalogue (names, categories,
 *   real-world sizes). It has no colour, so:
 * - `cdn.polyhaven.com/asset_img/primary/<id>.png`: a 64-pixel flat preview
 *   per candidate, averaged here once and kept in `localStorage` after.
 *   Not the `thumbnail_url` the catalogue gives: those are shaded spheres,
 *   whose middle reads about 14 ΔE darker than the texture itself (measured
 *   against 29 diffuse maps; the flat previews are about 7 ΔE off, unbiased).
 *   The sphere is the fallback if a preview is missing.
 * - `api.polyhaven.com/files/<id>` and `dl.polyhaven.org`: the chosen
 *   textures' 1k JPEGs: the diffuse map, the normal map (`nor_gl`) and the
 *   `arm` map (occlusion, roughness, metalness) — `relief.ts`.
 *
 * Every URL the API returns is checked against these hosts before it is
 * fetched.
 */

import { inFamily, type TextureFamily } from "./classify";
import {
  decodeLayer,
  onHost,
  requestInit,
  tileMetresFromMm,
  type LoadedTexture,
  type SourceCandidate,
  type TextureSource,
} from "./source";

export const POLYHAVEN_API = "https://api.polyhaven.com";
const PREVIEW_HOST = "cdn.polyhaven.com";
const DOWNLOAD_HOST = "dl.polyhaven.org";

/** The origins the CSP has to allow for this — `proxy.ts`. */
export const POLYHAVEN_ORIGINS = [POLYHAVEN_API, `https://${PREVIEW_HOST}`, `https://${DOWNLOAD_HOST}`];

export const polyHavenPage = (id: string) => `https://polyhaven.com/a/${encodeURIComponent(id)}`;

export type PolyHavenAsset = {
  name: string;
  /** "Top/Sub/Leaf", e.g. "Brick & Block/Clay Brick/Weathered". */
  category?: string;
  categories?: string[];
  attributes?: { surface_use?: string; condition?: string[]; aerial?: boolean };
  /** Real-world size in millimetres, width × height. */
  dimensions?: [number, number];
  thumbnail_url?: string;
  img_version?: string;
};

export type PolyHavenCatalogue = Record<string, PolyHavenAsset>;

const REQUEST = requestInit("origin");

const ID = /^[a-z0-9_]+$/;

let catalogue: Promise<PolyHavenCatalogue> | null = null;

/** The texture catalogue, fetched once per page. */
export function fetchCatalogue(): Promise<PolyHavenCatalogue> {
  catalogue ??= fetch(`${POLYHAVEN_API}/assets?t=textures`, REQUEST)
    .then((response) => {
      if (!response.ok) throw new Error(`Poly Haven answered ${response.status}.`);
      return response.json() as Promise<PolyHavenCatalogue>;
    })
    .then((assets) => Object.fromEntries(Object.entries(assets).filter(([id]) => ID.test(id))))
    .catch((error: unknown) => {
      catalogue = null;
      throw error;
    });
  return catalogue;
}

/** Aerial photographs and snow-covered ground are not building materials. */
export function usable(asset: PolyHavenAsset): boolean {
  if (asset.attributes?.aerial) return false;
  const words = `${asset.name} ${asset.category ?? ""} ${(asset.categories ?? []).join(" ")}`.toLowerCase();
  return !/\bsnow|\bmoon\b|regolith/.test(words);
}

/** Real-world size, clamped to what reads as a material and not a satellite photo. */
export function tileMetres(asset: PolyHavenAsset): [number, number] {
  const [w, h] = asset.dimensions ?? [];
  return [tileMetresFromMm(w), tileMetresFromMm(h ?? w)];
}

const colourKey = (id: string, asset: PolyHavenAsset) => `polyhaven:${id}@${asset.img_version ?? ""}`;

const layers = new Map<string, Promise<LoadedTexture>>();

/** `GET /files/<id>`: each map's files, by map, resolution and format. */
type PolyHavenFiles = Record<string, Record<string, { jpg?: { url?: string } }> | undefined>;

/** A map's 1k JPEG, if Poly Haven lists one on its download host. */
function jpg1k(files: PolyHavenFiles, map: string): string | null {
  const url = files[map]?.["1k"]?.jpg?.url;
  return (url && onHost(url, DOWNLOAD_HOST)?.href) || null;
}

/** Test seam: forget what this page has fetched. */
export function resetPolyHavenForTests() {
  catalogue = null;
  layers.clear();
}

export const polyHaven: TextureSource = {
  id: "polyhaven",
  measureAll: true,
  concurrency: 8,

  async candidates(family: TextureFamily): Promise<SourceCandidate[]> {
    const assets = await fetchCatalogue();
    return Object.entries(assets)
      .filter(([, asset]) => usable(asset) && inFamily(asset, family))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, asset]) => ({
        key: `polyhaven:${id}`,
        source: "polyhaven",
        family: family.id,
        id,
        name: asset.name,
        page: polyHavenPage(id),
        surfaceUse: asset.attributes?.surface_use,
        condition: asset.attributes?.condition,
        data: asset,
      }));
  },

  referrer: "origin",

  colourKey(candidate) {
    return colourKey(candidate.id, candidate.data as PolyHavenAsset);
  },

  previews(candidate) {
    if (!ID.test(candidate.id)) return [];
    const asset = candidate.data as PolyHavenAsset;
    // One fixed size and no version parameter: the CDN resizes each distinct
    // URL from scratch (1–2 s cold, 50 ms cached), so every visitor should ask
    // for the same one. The version is in the local cache key instead.
    const flat = { url: `https://${PREVIEW_HOST}/asset_img/primary/${candidate.id}.png?width=64`, region: "all" as const };
    // No flat preview: the shaded sphere, whose middle is the best of it.
    const sphere = asset.thumbnail_url ? onHost(asset.thumbnail_url, PREVIEW_HOST) : null;
    if (!sphere) return [flat];
    sphere.searchParams.set("width", "32");
    sphere.searchParams.set("height", "32");
    return [flat, { url: sphere.href, region: "middle" }];
  },

  load(candidate) {
    let pending = layers.get(candidate.id);
    if (!pending) {
      pending = (async () => {
        if (!ID.test(candidate.id)) throw new Error("Not a Poly Haven id.");
        const response = await fetch(`${POLYHAVEN_API}/files/${candidate.id}`, REQUEST);
        if (!response.ok) throw new Error(`Poly Haven answered ${response.status}.`);
        const files = (await response.json()) as PolyHavenFiles;
        const diffuse = jpg1k(files, "Diffuse");
        if (!diffuse) throw new Error("Poly Haven listed no 1k diffuse map.");
        const normal = jpg1k(files, "nor_gl");
        const arm = jpg1k(files, "arm");
        return decodeLayer(
          diffuse,
          tileMetres(candidate.data as PolyHavenAsset),
          REQUEST,
          candidate.family,
          async () => (normal && arm ? { normal, arm } : null),
        );
      })();
      pending.catch(() => layers.delete(candidate.id));
      layers.set(candidate.id, pending);
    }
    return pending;
  },
};
