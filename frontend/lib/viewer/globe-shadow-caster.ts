/**
 * The globe's surface as a shadow caster in the viewer's scene: what lets a
 * hill, or the 3D Tiles' buildings, shade the model and the context.
 *
 * Terrain and 3D Tiles are drawn by Cesium on another canvas, which the
 * viewer's sun cannot see. Their surface is already sampled into this scene
 * twice (the depth occluder over the visible ground, the finer shadow catcher
 * round the models); a copy of each casts into the sun's shadow map and is
 * never drawn. Two changes make it fit for that:
 *
 * - **Lowered**, by a share of its cell (at least `MIN_DROP`). A sampled
 *   surface is a coarse stand-in for the real one, and a stand-in at its own
 *   height shades the ground and the model's foot it is supposed to lie under
 *   (acne). Lowered, it still shades what is below a hill or a roof line, and
 *   only that.
 * - **With a hole where the models stand.** 3D Tiles are photogrammetry of the
 *   site as it is today; cast as they are, the building being replaced would
 *   shade the one replacing it from the inside. Any triangle over a model's
 *   footprint (plus `MARGIN`) is dropped, on terrain too: under the model the
 *   ground is the model's.
 * - **Not where a finer copy casts** (`covered`): the coarse occluder's
 *   triangles span valleys as chords above their floor, and would shade a
 *   model down in one. Round the models the catcher's finer grid casts.
 */

export type SurfaceMesh = { positions: Float32Array; indices: Uint32Array };

/** A model's extent on the ground, in render space (x east, z south). */
export type Footprint = { minX: number; maxX: number; minZ: number; maxZ: number };

/** The least the caster is lowered, in metres. */
export const MIN_DROP = 1.5;
/** Of the grid's cell: on a 10 m grid the caster is 1.5 m down. */
export const DROP_PER_CELL = 0.15;
/** Round each model's footprint, in metres, where the surface does not cast. */
export const MARGIN = 2;

/** The grid's spacing: the shortest horizontal edge of its first triangle. */
export function cellSize({ positions, indices }: SurfaceMesh): number {
  if (indices.length < 3) return 0;
  let shortest = Infinity;
  for (let edge = 0; edge < 3; edge += 1) {
    const a = indices[edge] * 3;
    const b = indices[(edge + 1) % 3] * 3;
    const length = Math.hypot(positions[a] - positions[b], positions[a + 2] - positions[b + 2]);
    if (length > 0) shortest = Math.min(shortest, length);
  }
  return Number.isFinite(shortest) ? shortest : 0;
}

/**
 * The caster for `surface`: lowered, with the models' footprints cut out, and
 * without the triangles whose centre is in `covered`. Null when nothing is left.
 */
export function globeShadowCaster(
  surface: SurfaceMesh,
  footprints: readonly Footprint[],
  covered?: Footprint,
): SurfaceMesh | null {
  const { positions, indices } = surface;
  const drop = Math.max(MIN_DROP, DROP_PER_CELL * cellSize(surface));
  const lowered = positions.slice();
  for (let at = 1; at < lowered.length; at += 3) lowered[at] -= drop;

  const holes = footprints.map((footprint) => ({
    minX: footprint.minX - MARGIN,
    maxX: footprint.maxX + MARGIN,
    minZ: footprint.minZ - MARGIN,
    maxZ: footprint.maxZ + MARGIN,
  }));
  const kept = new Uint32Array(indices.length);
  let count = 0;
  for (let triangle = 0; triangle + 2 < indices.length; triangle += 3) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let corner = 0; corner < 3; corner += 1) {
      const at = indices[triangle + corner] * 3;
      minX = Math.min(minX, positions[at]);
      maxX = Math.max(maxX, positions[at]);
      minZ = Math.min(minZ, positions[at + 2]);
      maxZ = Math.max(maxZ, positions[at + 2]);
    }
    // Its extent, not its corners: a cell of the coarse grid can be wider than
    // the model, and span it without a corner inside.
    const overModel = holes.some((hole) => minX <= hole.maxX && maxX >= hole.minX && minZ <= hole.maxZ && maxZ >= hole.minZ);
    if (overModel) continue;
    if (covered) {
      const centreX = (minX + maxX) / 2;
      const centreZ = (minZ + maxZ) / 2;
      if (centreX >= covered.minX && centreX <= covered.maxX && centreZ >= covered.minZ && centreZ <= covered.maxZ) continue;
    }
    kept[count] = indices[triangle];
    kept[count + 1] = indices[triangle + 1];
    kept[count + 2] = indices[triangle + 2];
    count += 3;
  }
  return count === 0 ? null : { positions: lowered, indices: kept.slice(0, count) };
}
