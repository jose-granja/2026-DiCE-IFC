"use client";

/**
 * The texture library this app's own server hosts (ADR 016): curated CC0
 * textures from Poly Haven and ambientCG, prepared once by the backend
 * (`backend/`, `build_texture_library`) and served from `/texture-library/`.
 *
 * The browser reads the manifest — every texture's family, surface, size and
 * mean colour — and chooses there, from the model's material names and
 * colours, which never leave it (AGENTS.md §1). Only the chosen textures'
 * files are fetched, from the same origin.
 */

import { z } from "zod";

import type { TextureFamilyId } from "./classify";
import { decodeLayer, type LoadedTexture } from "./source";

export const LIBRARY_MANIFEST_URL = "/texture-library/api/manifest";

/** The libraries the textures were taken from, for credits. */
export type LibrarySourceId = "polyhaven" | "ambientcg";

export const SOURCE_NAMES: Record<LibrarySourceId, string> = { polyhaven: "Poly Haven", ambientcg: "ambientCG" };
export const SOURCE_HOMES: Record<LibrarySourceId, string> = {
  polyhaven: "https://polyhaven.com/textures",
  ambientcg: "https://ambientcg.com/",
};

const FAMILY_IDS = [
  "roofTiles", "tiles", "brick", "block", "stoneMasonry", "stone", "wood", "metal",
  "plaster", "concrete", "asphalt", "gravel", "soil", "grass", "carpet", "vinyl",
] as const satisfies readonly TextureFamilyId[];

/** A file inside the library: a plain relative path, never a URL or a way out of it. */
const libraryPath = z.string().regex(/^[\w.-]+(\/[\w.-]+)*$/).refine((path) => !path.split("/").includes(".."));
const triple = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const maps = z.object({ color: libraryPath, normal: libraryPath, arm: libraryPath });

const textureSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  family: z.enum(FAMILY_IDS),
  surface: z.enum(["wall", "floor", "roof"]),
  source: z.enum(["polyhaven", "ambientcg"]),
  sourceUrl: z.string().url(),
  licence: z.string(),
  tile: z.tuple([z.number().positive(), z.number().positive()]),
  mean: triple,
  lab: triple,
  sizes: z.record(z.string(), maps),
  thumb: libraryPath,
});

const manifestSchema = z.object({
  version: z.number(),
  // Same origin only: a path, not `//host` or a URL.
  files: z.string().regex(/^\/(?!\/)[\w./-]*\/$/),
  textures: z.array(z.unknown()),
});

export type LibraryTexture = z.infer<typeof textureSchema>;
export type LibraryManifest = { version: number; files: string; textures: LibraryTexture[] };

/** The server has no texture library: none installed, or the service is down. */
export class LibraryUnavailableError extends Error {
  constructor(public readonly status: number | null) {
    super(status === 404 ? "This server has no texture library installed." : "The texture library could not be reached.");
    this.name = "LibraryUnavailableError";
  }
}

let manifest: Promise<LibraryManifest> | null = null;

/** The manifest, read once per page; a failure is not kept, so the next try asks again. */
export function fetchManifest(): Promise<LibraryManifest> {
  manifest ??= (async () => {
    let response: Response;
    try {
      response = await fetch(LIBRARY_MANIFEST_URL, { credentials: "omit" });
    } catch {
      throw new LibraryUnavailableError(null);
    }
    if (!response.ok) throw new LibraryUnavailableError(response.status);
    const parsed = manifestSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new LibraryUnavailableError(response.status);
    // A texture the schema refuses is left out, not the whole library.
    const textures = parsed.data.textures.flatMap((item) => {
      const texture = textureSchema.safeParse(item);
      return texture.success && texture.data.sizes["1024"] ? [texture.data] : [];
    });
    return { version: parsed.data.version, files: parsed.data.files, textures };
  })().catch((error: unknown) => {
    manifest = null;
    throw error;
  });
  return manifest;
}

/** Test seam: forget the manifest. */
export function resetLibraryForTests() {
  manifest = null;
}

/** The largest size a texture has up to `size`: 2K for walls and floors, 1K for the rest. */
export function filesAt(texture: LibraryTexture, size: number) {
  const available = Object.keys(texture.sizes).map(Number).filter((n) => n <= size).sort((a, b) => b - a);
  return texture.sizes[String(available[0] ?? 1024)];
}

/**
 * One texture, decoded into a layer of `size` pixels. A texture published at
 * 1K only (a roof) is scaled up when the array is 2K, since every layer of an
 * array is the same size.
 */
export function loadLibraryTexture(files: string, texture: LibraryTexture, size: number): Promise<LoadedTexture> {
  const at = filesAt(texture, size);
  return decodeLayer(
    `${files}${at.color}`,
    texture.tile,
    { credentials: "omit" },
    texture.family,
    { normal: `${files}${at.normal}`, arm: `${files}${at.arm}` },
    size,
  );
}
