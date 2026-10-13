/** BCF topic locations in the viewer's shared Y-up frame. */
import type { Vec3 } from "@/lib/ifc/types";
import type { BcfTopic, BcfViewpoint } from "./types";
import { bcfPointToRender, cameraToViewer, type ViewpointFrame } from "./viewpoint";

export type MarkerBounds = { min: Vec3; max: Vec3 };
export type TopicMarker = {
  topicGuid: string;
  viewpointGuid: string;
  position: Vec3;
  anchor: Vec3;
  source: "component" | "camera";
};

/** Hidden exceptions are not issue locations; visible exceptions are. */
export function markerComponentIds(viewpoint: BcfViewpoint): string[] {
  const components = viewpoint.components;
  if (!components) return [];
  return [...components.selection, ...(!components.defaultVisibility ? components.exceptions : [])]
    .flatMap((component) => component.ifcGuid ? [component.ifcGuid] : []);
}

/**
 * Like IFC-lite's overlay, prefer an element's top, then a saved camera target.
 * Bounds already include federation transforms. Only camera coordinates need
 * the BCF frame conversion; applying it twice would move pins off the model.
 */
export function locateTopicMarker(
  topic: BcfTopic,
  boundsFor: (globalId: string) => MarkerBounds | null,
  frame: ViewpointFrame,
  targetDistance: number,
): TopicMarker | null {
  for (const viewpoint of topic.viewpoints) {
    for (const globalId of markerComponentIds(viewpoint)) {
      const bounds = boundsFor(globalId);
      if (!bounds || ![...bounds.min, ...bounds.max].every(Number.isFinite)) continue;
      const anchor: Vec3 = [
        (bounds.min[0] + bounds.max[0]) / 2,
        bounds.max[1],
        (bounds.min[2] + bounds.max[2]) / 2,
      ];
      const position: Vec3 = [...anchor];
      position[1] += Math.max(0.5, (bounds.max[1] - bounds.min[1]) * 0.3);
      return { topicGuid: topic.guid, viewpointGuid: viewpoint.guid, position, anchor, source: "component" };
    }

    const camera = viewpoint.camera;
    if (!camera || !camera.viewPoint.every(Number.isFinite)) continue;
    const usableDirection = camera.direction.every(Number.isFinite) && Math.hypot(...camera.direction) > 1e-6;
    const position = usableDirection
      ? cameraToViewer(camera, frame, Number.isFinite(targetDistance) && targetDistance > 0 ? targetDistance : 10).target
      : bcfPointToRender(camera.viewPoint, frame);
    if (position.every(Number.isFinite)) {
      return { topicGuid: topic.guid, viewpointGuid: viewpoint.guid, position, anchor: position, source: "camera" };
    }
  }
  return null;
}

export type MarkerScreenPoint = { x: number; y: number; visible: boolean };
export type TopicMarkerScreen = { topicGuid: string; x: number; y: number; anchorX: number; anchorY: number };

/** Keep coincident topics independently clickable without moving their anchors. */
export function layoutTopicMarkers(
  markers: TopicMarker[],
  project: (point: Vec3) => MarkerScreenPoint,
): TopicMarkerScreen[] {
  const placed: TopicMarkerScreen[] = [];
  const cells = new Map<string, TopicMarkerScreen[]>();
  const overlaps = (x: number, y: number) => {
    const column = Math.floor(x / 36);
    const row = Math.floor(y / 36);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (cells.get(`${column + dx},${row + dy}`)?.some(
          (other) => Math.abs(other.x - x) < 36 && Math.abs(other.y - y) < 36,
        )) return true;
      }
    }
    return false;
  };
  for (const marker of markers) {
    const pin = project(marker.position);
    const anchor = project(marker.anchor);
    if (!pin.visible || !anchor.visible || ![pin.x, pin.y, anchor.x, anchor.y].every(Number.isFinite)) continue;
    const x = Math.round(pin.x);
    let y = Math.round(pin.y);
    while (overlaps(x, y)) y -= 38;
    const point = { topicGuid: marker.topicGuid, x, y, anchorX: Math.round(anchor.x), anchorY: Math.round(anchor.y) };
    placed.push(point);
    const cell = `${Math.floor(x / 36)},${Math.floor(y / 36)}`;
    const bucket = cells.get(cell) ?? [];
    bucket.push(point);
    cells.set(cell, bucket);
  }
  return placed;
}
