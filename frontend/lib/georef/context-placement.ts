import type { Vec3 } from "@/lib/ifc/types";
import { ifcToRender, type ModelPlacement } from "@/lib/viewer/federation";
import { effectiveScale } from "./scale";
import { gridRotation, mapToLocal, type MapPoint, type Placement } from "./transform";

export type ContextScenePlacement = Pick<ModelPlacement, "offset" | "rotationY" | "scale">;

/** Map-space metres → the same scene frame as the reference IFC model. */
export function placeContextGeometry(
  origin: MapPoint,
  placement: Placement | null,
  originShift: Vec3,
  model: ContextScenePlacement,
): ContextScenePlacement {
  if (!placement) return { offset: [0, 0, 0], rotationY: 0, scale: 1 };

  // mapToLocal returns project units; both the RTC shift and renderer use metres.
  const local = mapToLocal(origin, placement);
  const unit = placement.lengthUnitScale;
  const render = ifcToRender([local.x * unit, local.y * unit, (local.z ?? 0) * unit]);
  const [x, y, z] = render.map((value, axis) => value - originShift[axis]);
  const cos = Math.cos(model.rotationY);
  const sin = Math.sin(model.rotationY);
  const grid = gridRotation(placement.conversion);

  return {
    offset: [
      model.offset[0] + model.scale * (cos * x + sin * z),
      model.offset[1] + model.scale * y,
      model.offset[2] + model.scale * (-sin * x + cos * z),
    ],
    // Vertex deltas are already in map axes/metres. Undo the map conversion
    // before applying the model group (normally these rotations/scales cancel).
    rotationY: model.rotationY - Math.atan2(grid.sin, grid.cos),
    scale: model.scale / effectiveScale(placement.conversion.scale, unit),
  };
}
