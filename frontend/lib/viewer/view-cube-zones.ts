/**
 * What each part of the view cube points the camera at, as on ifclite.com.
 *
 * Every face is a 3 × 3 grid: the middle cell is the face, the four cells on
 * its sides are the cube's edges, the four in its corners the cube's corners.
 * A cell looks from the face's normal plus its offset along the face's own
 * right and up, so an edge reached from either of its faces, or a corner from
 * any of its three, is one direction with one key. 6 faces, 12 edges and 8
 * corners: 26 views.
 *
 * Directions are where the camera stands relative to its target, in render
 * space, as `standardViewDirection`: +X right, +Y top, +Z front. Pure, so the
 * mapping is tested without React or a renderer.
 */

import type { Vec3 } from "@/lib/ifc/types";

export type CubeFace = "front" | "back" | "top" | "bottom" | "right" | "left";
export type CubeZoneKind = "face" | "edge" | "corner";

export type CubeZone = {
  /** The same for every cell, on any face, that looks from the same direction. */
  key: string;
  kind: CubeZoneKind;
  direction: Vec3;
  /** The cell on its face: column -1 … 1 left to right, row -1 … 1 top to bottom. */
  column: number;
  row: number;
};

type FaceFrame = { normal: Vec3; right: Vec3; up: Vec3 };

/** Each face as drawn by `ViewCube.tsx`'s CSS transforms, seen from outside. */
export const FACE_FRAMES: Record<CubeFace, FaceFrame> = {
  front: { normal: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0] },
  back: { normal: [0, 0, -1], right: [-1, 0, 0], up: [0, 1, 0] },
  right: { normal: [1, 0, 0], right: [0, 0, -1], up: [0, 1, 0] },
  left: { normal: [-1, 0, 0], right: [0, 0, 1], up: [0, 1, 0] },
  top: { normal: [0, 1, 0], right: [1, 0, 0], up: [0, 0, -1] },
  bottom: { normal: [0, -1, 0], right: [1, 0, 0], up: [0, 0, 1] },
};

export const CUBE_FACES = Object.keys(FACE_FRAMES) as CubeFace[];

/** `-0` and `0` are one key: two faces can derive the same edge with either. */
export function directionKey([x, y, z]: Vec3): string {
  return `${x + 0},${y + 0},${z + 0}`;
}

function kindOf([x, y, z]: Vec3): CubeZoneKind {
  const axes = Math.abs(x) + Math.abs(y) + Math.abs(z);
  return axes === 1 ? "face" : axes === 2 ? "edge" : "corner";
}

/** A face's nine cells, row by row from its top left. */
export function zonesForFace(face: CubeFace): CubeZone[] {
  const { normal, right, up } = FACE_FRAMES[face];
  const zones: CubeZone[] = [];
  for (const row of [-1, 0, 1]) {
    for (const column of [-1, 0, 1]) {
      // Row -1 is the face's top, so it is a step along +up.
      const direction = [0, 1, 2].map((axis) => normal[axis] + column * right[axis] - row * up[axis]) as Vec3;
      zones.push({ key: directionKey(direction), kind: kindOf(direction), direction, column, row });
    }
  }
  return zones;
}

/** The face a direction looks straight at, or null for an edge or a corner. */
export function faceOfDirection(direction: Vec3): CubeFace | null {
  if (kindOf(direction) !== "face") return null;
  const key = directionKey(direction);
  return CUBE_FACES.find((face) => directionKey(FACE_FRAMES[face].normal) === key) ?? null;
}

/** The faces a direction touches (one to three), in `CUBE_FACES` order. */
export function facesOfDirection(direction: Vec3): CubeFace[] {
  return CUBE_FACES.filter((face) => {
    const normal = FACE_FRAMES[face].normal;
    return normal[0] * direction[0] + normal[1] * direction[1] + normal[2] * direction[2] > 0;
  });
}

/**
 * Whether a cell of `face` lights up while `hovered` is: the hovered zone on
 * every face that shows it (an edge on both its faces, a corner on all three),
 * and the whole face when the face itself is hovered.
 */
export function isZoneLit(zone: CubeZone, face: CubeFace, hovered: string | null): boolean {
  if (hovered === null) return false;
  return zone.key === hovered || directionKey(FACE_FRAMES[face].normal) === hovered;
}
