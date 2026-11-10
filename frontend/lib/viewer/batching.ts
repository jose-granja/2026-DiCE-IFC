/**
 * Merging many small meshes into a few large buffers.
 *
 * Pure and three.js-free so it can be tested directly. The arithmetic here —
 * rebasing every mesh's indices onto its offset in the merged buffer, and
 * baking each mesh's `origin` into its vertices — is the kind that fails
 * silently: a wrong offset does not throw, it draws a shredded model.
 */

import type { MeshView } from "@/lib/ifc/types";
import { featureEdgeMasks } from "./edges";

/** Vertices per batch. Keeps one batch's buffers to a few tens of MB. */
export const MAX_BATCH_VERTICES = 500_000;

/** IFC Lite's display opacity multiplier for authored translucent surfaces. */
export const TRANSLUCENT_OPACITY_SCALE = 0.7;

/** Where one entity's vertices live inside a merged batch. */
export type VertexSpan = { start: number; count: number };

export type MergedBatch = {
  positions: Float32Array;
  normals: Float32Array;
  /** Flat RGBA per vertex, 0–1. */
  colours: Float32Array;
  /** Whether this batch needs the transparent material pass. */
  transparent: boolean;
  /** Per-vertex express id, for picking and per-entity updates. */
  entityIds: Uint32Array;
  indices: Uint32Array;
  /**
   * Per vertex, only when merged with `edges`: the feature-edge bits of the
   * triangle the vertex belongs to (see `featureEdgeMasks`).
   */
  edgeMask?: Uint8Array;
  /** expressId → its vertex spans. An entity can contribute several meshes. */
  spans: Map<number, VertexSpan[]>;
  /**
   * The model's own texture, when the batch is textured (`planBatches` keeps
   * one texture per batch), and its coordinates: two floats per vertex.
   */
  texture?: MeshView["texture"];
  uvs?: Float32Array;
};

/** The texture a mesh draws, when it has both a texture and coordinates for it. */
export function meshTextureKey(mesh: MeshView): string | null {
  return mesh.texture && mesh.uvs && mesh.uvs.length > 0 ? mesh.texture.key : null;
}

/**
 * Split meshes into groups that each fit in one batch.
 *
 * A single mesh larger than the cap gets its own group rather than being
 * dropped or split mid-triangle.
 */
export function planBatches(
  meshes: MeshView[],
  maxVertices = MAX_BATCH_VERTICES,
): MeshView[][] {
  const groups: MeshView[][] = [];

  // IFC Lite renders opaque and translucent geometry in separate passes. Keep
  // the same split here: one transparent pane must not force a whole building
  // batch through alpha blending and disable its depth writes.
  //
  // A batch is drawn with one material, so the model's own textures split it
  // too: one batch per texture, after the untextured ones.
  const keys: Array<string | null> = [null];
  for (const mesh of meshes) {
    const key = meshTextureKey(mesh);
    if (key !== null && !keys.includes(key)) keys.push(key);
  }
  for (const transparent of [false, true]) {
    for (const key of keys) {
      let current: MeshView[] = [];
      let vertices = 0;

      for (const mesh of meshes) {
        if ((mesh.color[3] < 0.99) !== transparent) continue;
        if (meshTextureKey(mesh) !== key) continue;

        const meshVertices = mesh.positions.length / 3;
        if (current.length > 0 && vertices + meshVertices > maxVertices) {
          groups.push(current);
          current = [];
          vertices = 0;
        }
        current.push(mesh);
        vertices += meshVertices;
      }
      if (current.length > 0) groups.push(current);
    }
  }

  return groups;
}

export type MergeOptions = {
  /** Linear RGB to blend the authored colours toward, 0–1 each. */
  tint?: [number, number, number];
  /** 0 keeps the authored IFC colours; 1 replaces them with the tint. */
  tintAmount?: number;
  /**
   * Prepare the batch for drawing edges from the material. Every triangle gets
   * three vertices of its own (the shader needs to know which corner it is
   * on) and a feature-edge mask, so the buffers grow with the triangle count
   * rather than the shared-vertex count.
   */
  edges?: boolean;
};

/** Merge one group of meshes into a single set of buffers. */
export function mergeMeshes(
  meshes: MeshView[],
  options: MergeOptions = {},
): MergedBatch {
  const edges = options.edges === true;
  let vertexCount = 0;
  let indexCount = 0;
  for (const mesh of meshes) {
    vertexCount += edges ? mesh.indices.length : mesh.positions.length / 3;
    indexCount += mesh.indices.length;
  }

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colours = new Float32Array(vertexCount * 4);
  const entityIds = new Uint32Array(vertexCount);
  const indices = new Uint32Array(indexCount);
  const spans = new Map<number, VertexSpan[]>();
  const edgeMask = edges ? new Uint8Array(vertexCount) : undefined;
  // `planBatches` gives a textured batch one texture; its coordinates come along.
  const textured = meshes.length > 0 && meshTextureKey(meshes[0]) !== null ? meshes[0].texture : undefined;
  const uvs = textured ? new Float32Array(vertexCount * 2) : undefined;

  const tint = options.tint;
  const amount = options.tintAmount ?? 0;

  let vertexOffset = 0;
  let indexOffset = 0;

  for (const mesh of meshes) {
    const meshVertices = edges ? mesh.indices.length : mesh.positions.length / 3;

    if (edgeMask) {
      // Unshare: vertex k of this mesh is corner k % 3 of triangle k / 3.
      const masks = featureEdgeMasks(mesh.positions, mesh.indices);
      for (let k = 0; k < mesh.indices.length; k += 1) {
        const src = mesh.indices[k] * 3;
        const dst = (vertexOffset + k) * 3;
        positions[dst] = mesh.positions[src] + mesh.origin[0];
        positions[dst + 1] = mesh.positions[src + 1] + mesh.origin[1];
        positions[dst + 2] = mesh.positions[src + 2] + mesh.origin[2];
        normals[dst] = mesh.normals[src];
        normals[dst + 1] = mesh.normals[src + 1];
        normals[dst + 2] = mesh.normals[src + 2];
        edgeMask[vertexOffset + k] = masks[Math.floor(k / 3)];
        if (uvs && mesh.uvs) {
          uvs[(vertexOffset + k) * 2] = mesh.uvs[mesh.indices[k] * 2];
          uvs[(vertexOffset + k) * 2 + 1] = mesh.uvs[mesh.indices[k] * 2 + 1];
        }
      }
    } else {
      // `positions` are element-local; world position is `origin + positions`.
      // Baking the origin in is what lets one buffer be drawn as a unit.
      for (let v = 0; v < meshVertices; v += 1) {
        const src = v * 3;
        const dst = (vertexOffset + v) * 3;
        positions[dst] = mesh.positions[src] + mesh.origin[0];
        positions[dst + 1] = mesh.positions[src + 1] + mesh.origin[1];
        positions[dst + 2] = mesh.positions[src + 2] + mesh.origin[2];
      }
      normals.set(mesh.normals, vertexOffset * 3);
      if (uvs && mesh.uvs) uvs.set(mesh.uvs.subarray(0, meshVertices * 2), vertexOffset * 2);
    }

    const [r, g, b] = mesh.color;
    const cr = tint ? r + (tint[0] - r) * amount : r;
    const cg = tint ? g + (tint[1] - g) * amount : g;
    const cb = tint ? b + (tint[2] - b) * amount : b;

    for (let v = 0; v < meshVertices; v += 1) {
      const dst = (vertexOffset + v) * 4;
      colours[dst] = cr;
      colours[dst + 1] = cg;
      colours[dst + 2] = cb;
      const alpha = Math.min(1, Math.max(0, mesh.color[3]));
      colours[dst + 3] = alpha < 0.99 ? alpha * TRANSLUCENT_OPACITY_SCALE : alpha;
      entityIds[vertexOffset + v] = mesh.expressId;
    }

    // Rebase this mesh's indices onto its position in the merged buffer. When
    // unshared, triangle corners are simply consecutive vertices.
    for (let i = 0; i < mesh.indices.length; i += 1) {
      indices[indexOffset + i] = edges ? vertexOffset + i : mesh.indices[i] + vertexOffset;
    }

    const existing = spans.get(mesh.expressId) ?? [];
    existing.push({ start: vertexOffset, count: meshVertices });
    spans.set(mesh.expressId, existing);

    vertexOffset += meshVertices;
    indexOffset += mesh.indices.length;
  }

  return {
    positions,
    normals,
    colours,
    transparent: meshes.some((mesh) => mesh.color[3] < 0.99),
    entityIds,
    indices,
    edgeMask,
    spans,
    ...(textured && uvs ? { texture: textured, uvs } : {}),
  };
}

/**
 * The subset of `indices` whose triangles belong to visible entities.
 *
 * All three vertices of a triangle come from one mesh, hence one entity, so
 * testing the first vertex is sufficient and two thirds cheaper.
 */
export function visibleIndices(
  indices: Uint32Array,
  entityIds: Uint32Array,
  isVisible: (expressId: number) => boolean,
): Uint32Array {
  const kept = new Uint32Array(indices.length);
  let n = 0;

  // Entity visibility is answered once per entity, not once per triangle: on a
  // 300k-element model the predicate is otherwise called millions of times.
  const decided = new Map<number, boolean>();

  for (let i = 0; i < indices.length; i += 3) {
    const expressId = entityIds[indices[i]];
    let visible = decided.get(expressId);
    if (visible === undefined) {
      visible = isVisible(expressId);
      decided.set(expressId, visible);
    }
    if (visible) {
      kept[n] = indices[i];
      kept[n + 1] = indices[i + 1];
      kept[n + 2] = indices[i + 2];
      n += 3;
    }
  }

  return kept.subarray(0, n);
}
