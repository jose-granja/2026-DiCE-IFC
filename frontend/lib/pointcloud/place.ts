/**
 * Where a decoded point cloud goes in the viewer's scene.
 *
 * Two readings of a cloud's coordinates are in use, and a file does not say
 * which it is:
 *
 * - **Map** — easting, northing, height in a projected CRS. A LAS from a survey
 *   is nearly always this. It is placed absolutely, the same way a georeferenced
 *   model is: relative to the federation's world origin, which is a position in
 *   that same map frame (`lib/viewer/federation.ts`).
 * - **Model** — the coordinates of an IFC model's own axes. A scan registered
 *   to a building by its authors (a PLY or E57 cut to the model's grid) is
 *   this. It is placed *with* that model, so it follows the model's
 *   placement, rotation and scale instead of sitting at a fixed spot.
 *
 * The frames are not told apart by magnitude with any confidence — a building
 * in a local grid can sit 50 km from its origin — so `suggestFrame` only picks
 * the default and the UI lets the user say.
 */

import { ifcToRender } from "@/lib/viewer/federation";
import type { ModelPlacement, WorldOrigin } from "@/lib/viewer/federation";
import type { Vec3 } from "@/lib/ifc/types";

export type CloudFrame = "map" | "model";

export type CloudTransform = {
  /** Scene position of the cloud's local origin. */
  offset: Vec3;
  /** Rotation about the scene's Y axis, radians. */
  rotationY: number;
  scale: number;
};

export type CloudPlacementResult =
  | { ok: true; transform: CloudTransform }
  | { ok: false; reason: "no-world-origin" | "no-model" };

/** Beyond this from the origin a cloud is almost certainly in a projected CRS. */
const MAP_FRAME_THRESHOLD_METRES = 20_000;

export function suggestFrame(origin: Vec3): CloudFrame {
  const far = Math.hypot(origin[0], origin[1]) > MAP_FRAME_THRESHOLD_METRES;
  // Keep the same interpretation regardless of load order. Until a model
  // supplies the map anchor the list explains the missing placement; once it
  // arrives, the cloud aligns without changing the user's chosen frame.
  return far ? "map" : "model";
}

export function placePointCloud(args: {
  /** The file's own (east, north, up) of the local origin the decoder subtracted. */
  origin: Vec3;
  frame: CloudFrame;
  worldOrigin: WorldOrigin | null;
  /** The model the cloud is registered to — only used in the model frame. */
  model: { originShift: Vec3; placement: ModelPlacement | null } | null;
}): CloudPlacementResult {
  const { origin, frame, worldOrigin, model } = args;

  if (frame === "map") {
    const anchor = worldOrigin?.mapPosition;
    if (!anchor) return { ok: false, reason: "no-world-origin" };
    return {
      ok: true,
      transform: {
        // Map (E, N, H) → scene (x, y, z) = (E, H, −N), as for models.
        offset: [origin[0] - anchor[0], origin[2] - anchor[2], -(origin[1] - anchor[1])],
        rotationY: 0,
        scale: 1,
      },
    };
  }

  if (!model) return { ok: false, reason: "no-model" };

  // The same transform the model's own group gets, applied to the cloud's
  // origin in the model's render frame (IFC axes swapped, RTC shift removed).
  const placement = model.placement;
  const rotationY = placement?.rotationY ?? 0;
  const scale = placement?.scale ?? 1;
  const [ox, oy, oz] = placement?.offset ?? [0, 0, 0];

  const render = ifcToRender(origin);
  const local: Vec3 = [
    render[0] - model.originShift[0],
    render[1] - model.originShift[1],
    render[2] - model.originShift[2],
  ];
  const cos = Math.cos(rotationY);
  const sin = Math.sin(rotationY);
  return {
    ok: true,
    transform: {
      offset: [
        ox + scale * (local[0] * cos + local[2] * sin),
        oy + scale * local[1],
        oz + scale * (-local[0] * sin + local[2] * cos),
      ],
      rotationY,
      scale,
    },
  };
}
