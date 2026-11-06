"use client";

/**
 * Realistic materials, end to end: from each model's materials and colours to
 * textures on screen.
 *
 * 1. The worker lists every element's materials and the renderer every
 *    element's authored colours.
 * 2. Each element's showing material is put in a family (`classify.ts`), and
 *    each (family, kind of surface, colour) asks for one texture.
 * 3. Every source (Poly Haven, 360into) offers its candidates for the
 *    families in use. Their colours are measured: all of Poly Haven's (tiny
 *    previews), and of 360into's only those whose own words put them nearest
 *    the colours wanted. The nearest wins, whichever library it is from
 *    (`choose.ts`).
 * 4. The winners are downloaded and drawn, at most `MAX_SURFACE_LAYERS` of
 *    them, the most used first.
 *
 * Nothing about the model leaves the browser. The libraries are asked for
 * their own categories and then for texture ids.
 */

import type { SurfaceMaterialEntry } from "@/lib/ifc/types";

import { surfaceMaterial, surfaceUseFor, type SurfaceUse, type TextureFamily, type TextureFamilyId } from "./classify";
import { chooseTexture, deltaE, srgbToLab, type Lab } from "./choose";
import { into360 } from "./into360";
import { polyHaven } from "./polyhaven";
import { measureColoursInWorker } from "@/lib/workers/texture-colour-client";

import {
  cachedColour,
  mapLimit,
  rememberColour,
  type ColourJob,
  type LoadedTexture,
  type SourceCandidate,
  type TextureSource,
  type TextureSourceId,
} from "./source";

/** How preview colours get measured: in a worker by default (`texture-colour-client.ts`). */
export type MeasureColours = (
  jobs: ColourJob[],
  concurrency: number,
  onDone: (count: number) => void,
  signal?: AbortSignal,
) => Promise<Array<Lab | null>>;

/** Both libraries, asked together. */
export const TEXTURE_SOURCES: TextureSource[] = [polyHaven, into360];

/**
 * How many of a source's unmeasured candidates are measured per colour wanted,
 * nearest guess first, when the source does not measure them all.
 */
export const SHORTLIST = 8;

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
  source: TextureSourceId;
  textureId: string;
  textureName: string;
  /** The texture's page in its library. */
  page: string;
  /** The library's own relief and roughness maps, or estimated from the photograph. */
  relief: LoadedTexture["relief"];
  elements: number;
};

export type RealisticProgress = { done: number; total: number };

export type RealisticResult = {
  applied: AppliedTexture[];
  /** Elements drawing at least one texture. */
  texturedElements: number;
  /** Colours of a material that got no texture: past the layer budget, or the download failed. */
  skipped: number;
  /** Elements with materials none of which has a family (glass, insulation, unknown words). */
  unmatched: number;
  /** Libraries that could not be reached; the others were used without them. */
  unreachable: TextureSourceId[];
};

/** Colours closer than this share one search — a rounding step in sRGB. */
const COLOUR_STEP = 1 / 64;
const quantise = (rgb: [number, number, number]) => rgb.map((c) => Math.round(c / COLOUR_STEP)).join(",");

type Request = {
  family: TextureFamily;
  surface: SurfaceUse | null;
  lab: Lab;
  /** Material name → the elements (`modelId#expressId`) asking, for the list of what was applied. */
  materials: Map<string, Set<string>>;
};

export async function applyRealisticMaterials(
  target: RealisticTarget,
  models: RealisticModel[],
  options: {
    signal?: AbortSignal;
    maxLayers: number;
    onProgress?: (progress: RealisticProgress) => void;
    sources?: TextureSource[];
    measure?: MeasureColours;
  },
): Promise<RealisticResult> {
  const { signal, maxLayers, onProgress, sources = TEXTURE_SOURCES, measure = measureColoursInWorker } = options;
  const abortIfAsked = () => {
    if (signal?.aborted) throw new DOMException("Realistic materials were turned off.", "AbortError");
  };

  // 1–2. What each element asks for.
  const requests = new Map<string, Request>();
  /** modelId → expressId → the element's family and surface. */
  const elements = new Map<string, Map<number, { family: TextureFamily; surface: SurfaceUse | null }>>();
  let unmatched = 0;
  for (const model of models) {
    const entries = await model.getSurfaceMaterials();
    abortIfAsked();
    const colours = target.surfaceColours(model.modelId);
    const byElement = new Map<number, { family: TextureFamily; surface: SurfaceUse | null }>();
    for (const entry of entries) {
      const showing = surfaceMaterial(entry.materials);
      if (!showing) {
        unmatched += 1;
        continue;
      }
      const surface = surfaceUseFor(entry.type);
      byElement.set(entry.expressId, { family: showing.family, surface });
      for (const rgb of colours.get(entry.expressId) ?? []) {
        const key = `${showing.family.id}|${surface ?? ""}|${quantise(rgb)}`;
        const request = requests.get(key) ?? {
          family: showing.family,
          surface,
          lab: srgbToLab(rgb),
          materials: new Map<string, Set<string>>(),
        };
        const users = request.materials.get(showing.material.name) ?? new Set<string>();
        users.add(`${model.modelId}#${entry.expressId}`);
        request.materials.set(showing.material.name, users);
        requests.set(key, request);
      }
    }
    elements.set(model.modelId, byElement);
  }

  if (requests.size === 0) {
    target.clearSurfaceTextures();
    return { applied: [], texturedElements: 0, skipped: 0, unmatched, unreachable: [] };
  }

  // 3. Candidates from every source, for the families asked for only. A
  // library that cannot be reached is left out; with none, this fails.
  const families = new Map<TextureFamilyId, TextureFamily>();
  for (const request of requests.values()) families.set(request.family.id, request.family);
  const candidatesBy = new Map<TextureFamilyId, SourceCandidate[]>();
  const unreachable: TextureSourceId[] = [];
  let firstError: unknown = null;
  // Every source and family at once; a source that fails for any family is
  // left out altogether, since a half-asked library would skew the choice.
  const offers = await Promise.all(
    sources.map((source) =>
      Promise.all([...families.values()].map(async (family) => [family.id, await source.candidates(family)] as const))
        .then((lists) => ({ source, lists, error: null as unknown }))
        .catch((error: unknown) => ({ source, lists: [] as Array<readonly [TextureFamilyId, SourceCandidate[]]>, error })),
    ),
  );
  abortIfAsked();
  for (const { source, lists, error } of offers) {
    if (error) {
      unreachable.push(source.id);
      firstError ??= error;
      continue;
    }
    for (const [family, list] of lists) candidatesBy.set(family, [...(candidatesBy.get(family) ?? []), ...list]);
  }
  if (unreachable.length === sources.length) throw firstError ?? new Error("No texture library could be reached.");

  // Which colours to measure: everything from a source that measures all,
  // and from the others, per colour wanted, the nearest guesses by name.
  const sourceOf = new Map(sources.map((source) => [source.id, source]));
  const toMeasure = new Map<string, SourceCandidate>();
  for (const request of requests.values()) {
    const shortlists = new Map<TextureSourceId, SourceCandidate[]>();
    for (const candidate of candidatesBy.get(request.family.id) ?? []) {
      const source = sourceOf.get(candidate.source)!;
      // Colours already measured cost nothing, so they always take part.
      if (source.measureAll || cachedColour(source.colourKey(candidate))) toMeasure.set(candidate.key, candidate);
      // The shortlist ranks every candidate, measured or not, so the same
      // search asks for the same few and a second visit measures nothing new.
      if (!source.measureAll) shortlists.set(candidate.source, [...(shortlists.get(candidate.source) ?? []), candidate]);
    }
    for (const list of shortlists.values()) {
      const guess = (c: SourceCandidate) => (c.estimate ? deltaE(c.estimate, request.lab) : 30);
      for (const candidate of [...list].sort((a, b) => guess(a) - guess(b) || a.key.localeCompare(b.key)).slice(0, SHORTLIST)) {
        toMeasure.set(candidate.key, candidate);
      }
    }
  }

  let done = 0;
  const total = toMeasure.size + Math.min(maxLayers, requests.size);
  const tick = () => {
    done += 1;
    onProgress?.({ done: Math.min(done, total), total });
  };
  onProgress?.({ done, total });

  // Colours measured before are read from this browser; the rest are
  // measured, per source at that source's pace, all sources at once.
  const labs = new Map<string, Lab>();
  await Promise.all(
    sources.map(async (source) => {
      const fresh: SourceCandidate[] = [];
      for (const candidate of toMeasure.values()) {
        if (candidate.source !== source.id) continue;
        const known = cachedColour(source.colourKey(candidate));
        if (known) {
          labs.set(candidate.key, known);
          tick();
        } else fresh.push(candidate);
      }
      const measured = await measure(
        fresh.map((candidate) => ({ previews: source.previews(candidate), referrer: source.referrer })),
        source.concurrency,
        (count) => {
          for (let i = 0; i < count; i += 1) tick();
        },
        signal,
      );
      measured.forEach((lab, index) => {
        if (lab) labs.set(fresh[index].key, rememberColour(source.colourKey(fresh[index]), lab));
      });
    }),
  );
  abortIfAsked();

  const candidateByKey = new Map<string, SourceCandidate>();
  for (const list of candidatesBy.values()) for (const candidate of list) candidateByKey.set(candidate.key, candidate);
  const measuredOf = (family: TextureFamilyId) =>
    (candidatesBy.get(family) ?? [])
      .filter((candidate) => labs.has(candidate.key))
      .map((candidate) => ({
        id: candidate.key,
        lab: labs.get(candidate.key)!,
        surfaceUse: candidate.surfaceUse,
        condition: candidate.condition,
      }));

  // Each request's texture, then the layer budget: the most used first.
  const chosen = new Map<string, string>();
  const usage = new Map<string, Set<string>>();
  for (const [key, request] of requests) {
    const pick = chooseTexture(measuredOf(request.family.id), request.lab, request.surface);
    if (!pick) continue;
    chosen.set(key, pick.id);
    const users = usage.get(pick.id) ?? new Set<string>();
    for (const asking of request.materials.values()) for (const element of asking) users.add(element);
    usage.set(pick.id, users);
  }
  const ranked = [...usage.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));

  // 4. Download, in that order, until the budget is full.
  const loaded: Array<{ id: string; texture: LoadedTexture }> = [];
  let cursor = 0;
  // A failed download frees its place for the next texture in line.
  while (loaded.length < maxLayers && cursor < ranked.length) {
    const batch = ranked.slice(cursor, cursor + (maxLayers - loaded.length));
    cursor += batch.length;
    const textures = await mapLimit(batch, 4, async ([id]) => {
      abortIfAsked();
      const candidate = candidateByKey.get(id)!;
      const texture = await sourceOf.get(candidate.source)!.load(candidate).catch(() => null);
      tick();
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
    target.setSurfaceTextures(model.modelId, (expressId, rgb) => {
      const element = byElement?.get(expressId);
      if (!element) return -1;
      const id = chosen.get(`${element.family.id}|${element.surface ?? ""}|${quantise(rgb)}`);
      return id === undefined ? -1 : (layerOf.get(id) ?? -1);
    });
  }

  // What was applied, per material name and texture.
  const lines = new Map<string, AppliedTexture>();
  const textured = new Set<string>();
  let skipped = 0;
  for (const [key, request] of requests) {
    const id = chosen.get(key);
    if (id === undefined || !layerOf.has(id)) {
      skipped += 1;
      continue;
    }
    for (const [material, asking] of request.materials) {
      for (const element of asking) textured.add(element);
      const lineKey = `${material}|${id}`;
      const candidate = candidateByKey.get(id)!;
      const line = lines.get(lineKey) ?? {
        material,
        family: request.family.id,
        source: candidate.source,
        textureId: candidate.id,
        textureName: candidate.name,
        page: candidate.page,
        relief: reliefOf.get(id) ?? "estimated",
        elements: 0,
      };
      line.elements += asking.size;
      lines.set(lineKey, line);
    }
  }
  onProgress?.({ done: total, total });
  return {
    applied: [...lines.values()].sort((a, b) => b.elements - a.elements || a.material.localeCompare(b.material)),
    texturedElements: textured.size,
    skipped,
    unmatched,
    unreachable,
  };
}

