import { describe, expect, it } from "vitest";
import { layoutTopicMarkers, locateTopicMarker, type MarkerBounds, type TopicMarker } from "../markers";
import { createTopic, type BcfViewpoint } from "../types";
import { IDENTITY_FRAME } from "../viewpoint";

const camera: BcfViewpoint["camera"] = {
  kind: "perspective", viewPoint: [100, 190, 5], direction: [0, 1, 0], upVector: [0, 0, 1], fieldOfView: 60,
};
function viewpoint(patch: Partial<BcfViewpoint> = {}): BcfViewpoint {
  return { guid: "view", fileName: "view.bcfv", camera, components: null, clippingPlanes: [], lines: [], bitmaps: [], ...patch };
}
function locate(views: BcfViewpoint[], bounds: MarkerBounds | null = null) {
  const topic = { ...createTopic({ title: "Issue", author: "tester" }), viewpoints: views };
  return locateTopicMarker(topic, () => bounds, { originShift: [100, 5, -200], placementOffset: [10, 0, 20] }, 10);
}

describe("BCF marker locations", () => {
  it("anchors above the selected element in its already-transformed federation frame", () => {
    const marker = locate([viewpoint({ components: { selection: [{ ifcGuid: "wall" }], defaultVisibility: true, exceptions: [], coloring: [] } })], { min: [10, 20, 30], max: [14, 30, 36] });
    expect(marker).toMatchObject({ anchor: [12, 30, 33], position: [12, 33, 33], source: "component" });
  });

  it("uses visible exceptions for isolated components, not hidden exceptions", () => {
    const components = { selection: [], defaultVisibility: false, exceptions: [{ ifcGuid: "wall" }], coloring: [] };
    const bounds: MarkerBounds = { min: [0, 0, 0], max: [2, 1, 2] };
    expect(locate([viewpoint({ components })], bounds)).toMatchObject({ source: "component", position: [1, 1.5, 1] });
    expect(locate([viewpoint({ components: { ...components, defaultVisibility: true } })], bounds)?.source).toBe("camera");
  });

  it("transforms a camera fallback from Z-up with RTC shift and federation offset", () => {
    expect(locate([viewpoint()])).toMatchObject({ position: [10, 0, 20], source: "camera" });
  });

  it("finds the next usable viewpoint and preserves its identity for opening", () => {
    expect(locate([viewpoint({ camera: null }), viewpoint({ guid: "second" })])?.viewpointGuid).toBe("second");
    expect(locate([viewpoint({ camera: null })])).toBeNull();
  });

  it("does not emit NaN locations and falls back to a camera position for a zero direction", () => {
    expect(locate([viewpoint({ camera: { ...camera!, viewPoint: [NaN, 0, 0] } })])).toBeNull();
    expect(locate([viewpoint({ camera: { ...camera!, direction: [0, 0, 0] } })])?.position).toEqual([10, 0, 30]);
  });

  it("uses the orthographic scale for a stable camera target", () => {
    const topic = { ...createTopic({ title: "Ortho", author: "tester" }), viewpoints: [viewpoint({ camera: { kind: "orthogonal", viewPoint: [0, -40, 2], direction: [0, 1, 0], upVector: [0, 0, 1], viewToWorldScale: 40 } })] };
    expect(locateTopicMarker(topic, () => null, IDENTITY_FRAME, 999)?.position).toEqual([0, 2, 0]);
  });
});

describe("marker projection layout", () => {
  const marker: TopicMarker = { topicGuid: "one", viewpointGuid: "view", position: [100, 100, 0], anchor: [100, 150, 0], source: "component" };
  const project = ([x, y, z]: number[]) => ({ x, y, visible: z >= 0 });

  it("separates coincident pins while keeping both connectors on the element", () => {
    const points = layoutTopicMarkers([marker, { ...marker, topicGuid: "two" }], project);
    expect(points.map((point) => point.y)).toEqual([100, 62]);
    expect(points.map((point) => [point.anchorX, point.anchorY])).toEqual([[100, 150], [100, 150]]);
  });

  it("hides pins behind the camera or with invalid projected coordinates", () => {
    expect(layoutTopicMarkers([{ ...marker, position: [100, 100, -1] }], project)).toEqual([]);
    expect(layoutTopicMarkers([marker], () => ({ x: Infinity, y: 0, visible: true }))).toEqual([]);
  });
});
