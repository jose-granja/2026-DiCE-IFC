"use client";

/**
 * Realistic materials, end to end: from each model's materials and colours to
 * textures on screen.
 *
 * 1. The worker lists every element's materials and the renderer every
 *    element's authored colours.
 * 2. Each element's showing material is put in a family (`classify.ts`).
 *    **One texture per material**: each material asks once, with the colour
 *    and the kind of surface most of its elements have, so every element of a
 *    material draws the same texture whatever its own colour or IFC class.
 * 3. The texture library's manifest (`library.ts`, this app's own server)
 *    offers the family's textures with their measured colours; the nearest
 *    wins (`choose.ts`).
 * 4. The winners are downloaded and drawn, at most `MAX_SURFACE_LAYERS` of
 *    them, the most used first: at 2K when few enough, else 1K.
 *
 * Nothing about the model leaves the browser: the manifest is read whole, and
 * only the chosen textures' files are asked for.
 */

import type { SurfaceMaterialEntry } from "@/lib/ifc/types";

import { surfaceMaterial, surfaceUseFor, type SurfaceUse, type TextureFamily, type TextureFamilyId } from "./classify";
import { chooseTexture, srgbToLab, type Lab } from "./choose";
import { fetchManifest, loadLibraryTexture, type LibraryManifest, type LibrarySourceId, type LibraryTexture } from "./library";
import { mapLimit, TEXTURE_SIZE, type LoadedTexture } from "./source";

/** Layers drawn at 2K when this few are needed, else every layer at 1K: 2K costs four times the memory. */
export const MAX_LARGE_LAYERS = 8;
export const LARGE_SIZE = 2048;

/** The size every layer is drawn at, for `count` textures. */
export function layerSize(textures: LibraryTexture[]): number {
  const large = textures.some((texture) => texture.sizes[String(LARGE_SIZE)]);
  return large && textures.length <= MAX_LARGE_LAYERS ? LARGE_SIZE : TEXTURE_SIZE;
}

/** The part of the renderer this needs (`ViewerRenderer`). */
export type RealisticTarget = {
  surfaceColours(modelId: string): Map<number, Array<[number, number, number]>>;
  setSurfaceTextureLayers(layers: LoadedTexture[]): void;
  setSurfaceTextures(modelId: string, pick: (expressId: number, colour: [number, number, number]) => number): void;
  clearSurfaceTextures(): void;
};

export type RealisticModel = {
  modelId: string;
  getSurfaceMaterials(): Promise<SurfaceMaterialEntry[]>;
};

/** One line of "what was applied": a material, and the texture it got. */
export type AppliedTexture = {
  material: string;
  family: TextureFamilyId;
  /** The library the texture was taken from, for the credit. */
  source: LibrarySourceId;
  textureId: string;
  textureName: string;
  /** The texture's page in its library. */
  page: string;
  /** The library's own relief and roughness maps, or estimated when they would not load. */
  relief: LoadedTexture["relief"];
  elements: number;
};

export type RealisticProgress = { done: number; total: number };

export type RealisticResult = {
  applied: AppliedTexture[];
  /** Elements drawing at least one texture. */
  texturedElements: number;
  /** Materials that got no texture: past the layer budget, or the download failed. */
  skipped: number;
  /** Elements with materials none of which has a family (glass, insulation, unknown words). */
  unmatched: number;
  /** The size the layers were drawn at: 2048 or 1024. */
  size: number;
};

/** Colours closer than this count as one when finding a material's usual colour — a rounding step. */
const COLOUR_STEP = 1 / 64;
const quantise = (rgb: [number, number, number]) => rgb.map((c) => Math.round(c / COLOUR_STEP)).join(",");

/** A material is one name within one family, across every model shown. */
const materialKey = (family: TextureFamily, name: string) => `${family.id}|${name}`;

/** One material's search: what most of its elements look like. */
type Request = {
  family: TextureFamily;
  material: string;
  surface: SurfaceUse | null;
  lab: Lab;
  /** The elements (`modelId#expressId`) drawing it. */
  elements: Set<string>;
};

/** What a material's elements bring, before the most common is taken. */
type Tally = {
  family: TextureFamily;
  material: string;
  /** Quantised colour → its sRGB and the elements showing it. */
  colours: Map<string, { rgb: [number, number, number]; elements: Set<string> }>;
  /** Kind of surface (`""` for none) → the elements of it. */
  surfaces: Map<string, Set<string>>;
  elements: Set<string>;
};

/** The entry most elements share; ties to the lowest key, so the choice never depends on order. */
function mostCommon<T>(entries: Map<string, T>, count: (value: T) => number): [string, T] {
  return [...entries].sort((a, b) => count(b[1]) - count(a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0];
}

export async function applyRealisticMaterials(
  target: RealisticTarget,
  models: RealisticModel[],
  options: {
    signal?: AbortSignal;
    maxLayers: number;
    onProgress?: (progress: RealisticProgress) => void;
    /** Test seams. */
    manifest?: () => Promise<LibraryManifest>;
    load?: (files: string, texture: LibraryTexture, size: number) => Promise<LoadedTexture>;
  },
): Promise<RealisticResult> {
  const { signal, maxLayers, onProgress, manifest = fetchManifest, load = loadLibraryTexture } = options;
  const abortIfAsked = () => {
    if (signal?.aborted) throw new DOMException("Realistic materials were turned off.", "AbortError");
  };

  // 1–2. Each element's material, and what each material's elements look like.
  const tallies = new Map<string, Tally>();
  /** modelId → expressId → the element's material. */
  const elements = new Map<string, Map<number, string>>();
  let unmatched = 0;
  for (const model of models) {
    const entries = await model.getSurfaceMaterials();
    abortIfAsked();
    const colours = target.surfaceColours(model.modelId);
    const byElement = new Map<number, string>();
    for (const entry of entries) {
      const showing = surfaceMaterial(entry.materials);
      if (!showing) {
        unmatched += 1;
        continue;
      }
      const key = materialKey(showing.family, showing.material.name);
      byElement.set(entry.expressId, key);
      const element = `${model.modelId}#${entry.expressId}`;
      const tally = tallies.get(key) ?? {
        family: showing.family,
        material: showing.material.name,
        colours: new Map(),
        surfaces: new Map(),
        elements: new Set<string>(),
      };
      tallies.set(key, tally);
      const own = colours.get(entry.expressId) ?? [];
      // Translucent only (glass in a frame's material): nothing drawn to texture.
      if (own.length === 0) continue;
      tally.elements.add(element);
      const surface = surfaceUseFor(entry.type) ?? "";
      tally.surfaces.set(surface, (tally.surfaces.get(surface) ?? new Set<string>()).add(element));
      for (const rgb of own) {
        const shade = tally.colours.get(quantise(rgb)) ?? { rgb, elements: new Set<string>() };
        shade.elements.add(element);
        tally.colours.set(quantise(rgb), shade);
      }
    }
    elements.set(model.modelId, byElement);
  }

  const requests = new Map<string, Request>();
  for (const [key, tally] of tallies) {
    if (tally.elements.size === 0) continue;
    const [, colour] = mostCommon(tally.colours, (shade) => shade.elements.size);
    const [surface] = mostCommon(tally.surfaces, (users) => users.size);
    requests.set(key, {
      family: tally.family,
      material: tally.material,
      surface: (surface || null) as SurfaceUse | null,
      lab: srgbToLab(colour.rgb),
      elements: tally.elements,
    });
  }

  if (requests.size === 0) {
    target.clearSurfaceTextures();
    return { applied: [], texturedElements: 0, skipped: 0, unmatched, size: TEXTURE_SIZE };
  }

  // 3. The library's textures, by family, with the colours measured when it was built.
  const library = await manifest();
  abortIfAsked();
  const byId = new Map(library.textures.map((texture) => [texture.id, texture]));
  const byFamily = new Map<TextureFamilyId, LibraryTexture[]>();
  for (const texture of library.textures) byFamily.set(texture.family, [...(byFamily.get(texture.family) ?? []), texture]);

  // Each request's texture, then the layer budget: the most used first.
  const chosen = new Map<string, string>();
  const usage = new Map<string, Set<string>>();
  for (const [key, request] of requests) {
    const candidates = (byFamily.get(request.family.id) ?? []).map((texture) => ({
      id: texture.id,
      lab: texture.lab,
      surfaceUse: texture.surface,
    }));
    const pick = chooseTexture(candidates, request.lab, request.surface);
    if (!pick) continue;
    chosen.set(key, pick.id);
    const users = usage.get(pick.id) ?? new Set<string>();
    for (const element of request.elements) users.add(element);
    usage.set(pick.id, users);
  }
  const ranked = [...usage.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
  const wanted = ranked.slice(0, maxLayers).map(([id]) => byId.get(id)!);
  const size = layerSize(wanted);

  // 4. Download, in that order, until the budget is full.
  let done = 0;
  const total = wanted.length;
  onProgress?.({ done, total });
  const loaded: Array<{ id: string; texture: LoadedTexture }> = [];
  let cursor = 0;
  // A failed download frees its place for the next texture in line.
  while (loaded.length < maxLayers && cursor < ranked.length) {
    const batch = ranked.slice(cursor, cursor + (maxLayers - loaded.length));
    cursor += batch.length;
    const textures = await mapLimit(batch, 4, async ([id]) => {
      abortIfAsked();
      const texture = await load(library.files, byId.get(id)!, size).catch(() => null);
      done += 1;
      onProgress?.({ done: Math.min(done, total), total });
      return texture ? { id, texture } : null;
    });
    for (const texture of textures) if (texture) loaded.push(texture);
  }
  abortIfAsked();

  const layerOf = new Map(loaded.map(({ id }, index) => [id, index]));
  const reliefOf = new Map(loaded.map(({ id, texture }) => [id, texture.relief]));
  target.setSurfaceTextureLayers(loaded.map(({ texture }) => texture));
  for (const model of models) {
    const byElement = elements.get(model.modelId);
    target.setSurfaceTextures(model.modelId, (expressId) => {
      const material = byElement?.get(expressId);
      const id = material === undefined ? undefined : chosen.get(material);
      return id === undefined ? -1 : (layerOf.get(id) ?? -1);
    });
  }

  // What was applied: one line per material.
  const applied: AppliedTexture[] = [];
  const textured = new Set<string>();
  let skipped = 0;
  for (const [key, request] of requests) {
    const id = chosen.get(key);
    if (id === undefined || !layerOf.has(id)) {
      skipped += 1;
      continue;
    }
    const texture = byId.get(id)!;
    for (const element of request.elements) textured.add(element);
    applied.push({
      material: request.material,
      family: request.family.id,
      source: texture.source,
      textureId: texture.id,
      textureName: texture.name,
      page: texture.sourceUrl,
      relief: reliefOf.get(id) ?? "estimated",
      elements: request.elements.size,
    });
  }
  onProgress?.({ done: total, total });
  return {
    applied: applied.sort((a, b) => b.elements - a.elements || a.material.localeCompare(b.material)),
    texturedElements: textured.size,
    skipped,
    unmatched,
    size: loaded[0]?.texture.size ?? size,
  };
}
