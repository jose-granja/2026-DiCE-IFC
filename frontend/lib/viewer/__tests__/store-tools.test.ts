import { beforeEach, describe, expect, it } from "vitest";

import type { GeoreferenceView, ModelSummary, Vec3 } from "@/lib/ifc/types";
import { useViewerStore, type ViewerModel } from "../store";
import type { Triangle } from "../tools";

function viewerModel(id: string): ViewerModel {
  const summary: ModelSummary = {
    id,
    name: `${id}.ifc`,
    schema: "IFC4",
    entityCount: 10,
    byteLength: 100,
    parseTimeMs: 1,
    lengthUnitScale: 1,
  };
  const georeference: GeoreferenceView = { hasGeoreference: false };

  return {
    summary,
    colour: "#1b6ea8",
    visible: true,
    load: { status: "ready" },
    georeference,
    spatialTree: null,
    entityTypes: [],
    coordinates: {
      originShift: [0, 0, 0],
      originalBounds: { min: [0, 0, 0], max: [10, 4, 6] },
      shiftedBounds: { min: [0, 0, 0], max: [10, 4, 6] },
      hasLargeCoordinates: false,
    },
    hasGeometry: true,
  };
}

beforeEach(() => {
  useViewerStore.getState().reset();
});

describe("section planes", () => {
  it("places a new plane at the middle of the loaded model", () => {
    useViewerStore.getState().addModel(viewerModel("a"));
    useViewerStore.getState().addSectionPlane("y");

    const [plane] = useViewerStore.getState().sectionPlanes;
    expect(plane.axis).toBe("y");
    expect(plane.position).toBeCloseTo(2, 6); // bounds 0..4
    expect(plane.enabled).toBe(true);
    expect(plane.flipped).toBe(false);
  });

  it("gives each plane a stable id, so removing one does not renumber the rest", () => {
    const store = useViewerStore.getState();
    store.addSectionPlane("x");
    store.addSectionPlane("y");
    store.addSectionPlane("z");

    const before = useViewerStore.getState().sectionPlanes.map((p) => p.id);
    useViewerStore.getState().removeSectionPlane(before[0]);

    const after = useViewerStore.getState().sectionPlanes.map((p) => p.id);
    expect(after).toEqual(before.slice(1));
    expect(new Set(after).size).toBe(2);
  });

  it("updates one plane without touching the others", () => {
    const store = useViewerStore.getState();
    store.addSectionPlane("x");
    store.addSectionPlane("y");

    const [first, second] = useViewerStore.getState().sectionPlanes;
    useViewerStore
      .getState()
      .updateSectionPlane(second.id, { flipped: true, position: 1.5 });

    const planes = useViewerStore.getState().sectionPlanes;
    expect(planes[0]).toEqual(first);
    expect(planes[1].flipped).toBe(true);
    expect(planes[1].position).toBe(1.5);
  });

  it("clears every plane", () => {
    useViewerStore.getState().addSectionPlane("x");
    useViewerStore.getState().clearSectionPlanes();
    expect(useViewerStore.getState().sectionPlanes).toEqual([]);
  });
});

describe("measurement", () => {
  const a: Vec3 = [0, 0, 0];
  const b: Vec3 = [3, 4, 0];

  it("takes two points to make a measurement", () => {
    useViewerStore.getState().addMeasurementPoint(a);
    expect(useViewerStore.getState().pendingPoint).toEqual(a);
    expect(useViewerStore.getState().measurements).toEqual([]);

    useViewerStore.getState().addMeasurementPoint(b);
    expect(useViewerStore.getState().pendingPoint).toBeNull();
    expect(useViewerStore.getState().measurements).toHaveLength(1);
    expect(useViewerStore.getState().measurements[0]).toMatchObject({
      start: a,
      end: b,
    });
  });

  it("starts a fresh measurement after completing one", () => {
    const store = useViewerStore.getState();
    store.addMeasurementPoint(a);
    store.addMeasurementPoint(b);
    useViewerStore.getState().addMeasurementPoint([1, 1, 1]);

    expect(useViewerStore.getState().pendingPoint).toEqual([1, 1, 1]);
    expect(useViewerStore.getState().measurements).toHaveLength(1);
  });

  it("cancels a half-finished measurement", () => {
    useViewerStore.getState().addMeasurementPoint(a);
    useViewerStore.getState().cancelMeasurement();
    expect(useViewerStore.getState().pendingPoint).toBeNull();
    expect(useViewerStore.getState().measurements).toEqual([]);
  });

  it("drops the pending point when leaving measure mode", () => {
    // Otherwise a stray point completes on the next unrelated click, minutes
    // later, producing a measurement the user never asked for.
    useViewerStore.getState().setTool("measureDistance");
    useViewerStore.getState().addMeasurementPoint(a);
    useViewerStore.getState().setTool("select");

    expect(useViewerStore.getState().pendingPoint).toBeNull();
  });

  it("keeps the pending point when re-selecting measure mode", () => {
    useViewerStore.getState().setTool("measureDistance");
    useViewerStore.getState().addMeasurementPoint(a);
    useViewerStore.getState().setTool("measureDistance");

    expect(useViewerStore.getState().pendingPoint).toEqual(a);
  });

  it("drops the pending point when switching to a different measuring tool", () => {
    useViewerStore.getState().setTool("measureDistance");
    useViewerStore.getState().addMeasurementPoint(a);
    useViewerStore.getState().setTool("measureAngle");

    expect(useViewerStore.getState().pendingPoint).toBeNull();
  });

  it("removes one measurement by id", () => {
    const store = useViewerStore.getState();
    store.addMeasurementPoint(a);
    store.addMeasurementPoint(b);
    store.addMeasurementPoint(b);
    store.addMeasurementPoint(a);

    const [first, second] = useViewerStore.getState().measurements;
    useViewerStore.getState().removeMeasurement(first.id);

    expect(useViewerStore.getState().measurements).toEqual([second]);
  });

  it("is cleared by reset, along with the tool mode", () => {
    const store = useViewerStore.getState();
    store.setTool("measureDistance");
    store.addMeasurementPoint(a);
    store.addSectionPlane("y");

    useViewerStore.getState().reset();

    const state = useViewerStore.getState();
    expect(state.tool).toBe("select");
    expect(state.measurements).toEqual([]);
    expect(state.sectionPlanes).toEqual([]);
    expect(state.pendingPoint).toBeNull();
  });
});

describe("angle measurement", () => {
  const a: Vec3 = [1, 0, 0];
  const vertex: Vec3 = [0, 0, 0];
  const c: Vec3 = [0, 1, 0];

  it("takes three points to make an angle measurement", () => {
    const store = useViewerStore.getState();
    store.addAnglePoint(a);
    expect(useViewerStore.getState().pendingAnglePoints).toEqual([a]);

    store.addAnglePoint(vertex);
    expect(useViewerStore.getState().pendingAnglePoints).toEqual([a, vertex]);
    expect(useViewerStore.getState().angleMeasurements).toEqual([]);

    store.addAnglePoint(c);
    expect(useViewerStore.getState().pendingAnglePoints).toEqual([]);
    expect(useViewerStore.getState().angleMeasurements).toHaveLength(1);
    expect(useViewerStore.getState().angleMeasurements[0]).toMatchObject({ a, vertex, c });
  });

  it("cancels a half-finished angle", () => {
    const store = useViewerStore.getState();
    store.addAnglePoint(a);
    store.addAnglePoint(vertex);
    store.cancelAngleMeasurement();

    expect(useViewerStore.getState().pendingAnglePoints).toEqual([]);
    expect(useViewerStore.getState().angleMeasurements).toEqual([]);
  });

  it("drops pending points when switching to a different measuring tool", () => {
    const store = useViewerStore.getState();
    store.setTool("measureAngle");
    store.addAnglePoint(a);
    store.setTool("measureDistance");

    expect(useViewerStore.getState().pendingAnglePoints).toEqual([]);
  });

  it("removes one angle by id, and clears the rest together", () => {
    const store = useViewerStore.getState();
    store.addAnglePoint(a);
    store.addAnglePoint(vertex);
    store.addAnglePoint(c);
    store.addAnglePoint(c);
    store.addAnglePoint(vertex);
    store.addAnglePoint(a);

    const [first, second] = useViewerStore.getState().angleMeasurements;
    useViewerStore.getState().removeAngleMeasurement(first.id);
    expect(useViewerStore.getState().angleMeasurements).toEqual([second]);

    useViewerStore.getState().clearAngleMeasurements();
    expect(useViewerStore.getState().angleMeasurements).toEqual([]);
  });
});

describe("area measurement", () => {
  const points: Vec3[] = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ];

  it("accumulates points without completing on any particular count", () => {
    const store = useViewerStore.getState();
    for (const point of points) store.addAreaPoint(point);

    expect(useViewerStore.getState().pendingAreaPoints).toEqual(points);
    expect(useViewerStore.getState().areaMeasurements).toEqual([]);
  });

  it("finishes into a measurement, and clears the pending points", () => {
    const store = useViewerStore.getState();
    for (const point of points) store.addAreaPoint(point);
    store.finishAreaMeasurement();

    expect(useViewerStore.getState().pendingAreaPoints).toEqual([]);
    expect(useViewerStore.getState().areaMeasurements).toHaveLength(1);
    expect(useViewerStore.getState().areaMeasurements[0]).toMatchObject({ kind: "points", points });
  });

  it("refuses to finish with fewer than three points", () => {
    const store = useViewerStore.getState();
    store.addAreaPoint(points[0]);
    store.addAreaPoint(points[1]);
    store.finishAreaMeasurement();

    expect(useViewerStore.getState().pendingAreaPoints).toEqual([points[0], points[1]]);
    expect(useViewerStore.getState().areaMeasurements).toEqual([]);
  });

  it("cancels a half-finished area", () => {
    const store = useViewerStore.getState();
    store.addAreaPoint(points[0]);
    store.cancelAreaMeasurement();
    expect(useViewerStore.getState().pendingAreaPoints).toEqual([]);
  });

  it("removes one area by id", () => {
    const store = useViewerStore.getState();
    for (const point of points) store.addAreaPoint(point);
    store.finishAreaMeasurement();
    for (const point of points) store.addAreaPoint(point);
    store.finishAreaMeasurement();

    const [first, second] = useViewerStore.getState().areaMeasurements;
    useViewerStore.getState().removeAreaMeasurement(first.id);
    expect(useViewerStore.getState().areaMeasurements).toEqual([second]);
  });

  it("defaults to points mode, and switching modes drops pending points", () => {
    const store = useViewerStore.getState();
    expect(useViewerStore.getState().areaMode).toBe("points");

    store.addAreaPoint(points[0]);
    store.setAreaMode("face");

    expect(useViewerStore.getState().pendingAreaPoints).toEqual([]);
  });

  it("records a face's triangles with a single call — no pending state", () => {
    const store = useViewerStore.getState();
    const triangles: Triangle[] = [[[0, 0, 0], [1, 0, 0], [0, 1, 0]]];
    store.addFaceArea("m1", 71, triangles);

    expect(useViewerStore.getState().areaMeasurements).toHaveLength(1);
    expect(useViewerStore.getState().areaMeasurements[0]).toMatchObject({
      kind: "face",
      modelId: "m1",
      expressId: 71,
      triangles,
    });
  });

  it("survives reset as a preference, unlike the measurements themselves", () => {
    const store = useViewerStore.getState();
    store.setAreaMode("face");
    store.addFaceArea("m1", 1, []);

    store.reset();

    const state = useViewerStore.getState();
    expect(state.areaMode).toBe("face");
    expect(state.areaMeasurements).toEqual([]);
  });
});

describe("volume measurement", () => {
  it("records an element's volume with a single call — no pending state", () => {
    const store = useViewerStore.getState();
    store.addElementVolume("m1", 42, 12.5, [1, 2, 3]);

    expect(useViewerStore.getState().volumeMeasurements).toHaveLength(1);
    expect(useViewerStore.getState().volumeMeasurements[0]).toMatchObject({
      kind: "element",
      modelId: "m1",
      expressId: 42,
      volume: 12.5,
      centroid: [1, 2, 3],
    });
  });

  it("takes two corners to make a box volume", () => {
    const store = useViewerStore.getState();
    const corner1: Vec3 = [0, 0, 0];
    const corner2: Vec3 = [2, 3, 4];

    store.addBoxVolumePoint(corner1);
    expect(useViewerStore.getState().pendingBoxCorner).toEqual(corner1);

    store.addBoxVolumePoint(corner2);
    expect(useViewerStore.getState().pendingBoxCorner).toBeNull();
    expect(useViewerStore.getState().volumeMeasurements).toHaveLength(1);
    expect(useViewerStore.getState().volumeMeasurements[0]).toMatchObject({
      kind: "box",
      corner1,
      corner2,
    });
  });

  it("cancels a half-placed box", () => {
    const store = useViewerStore.getState();
    store.addBoxVolumePoint([0, 0, 0]);
    store.cancelVolumeMeasurement();
    expect(useViewerStore.getState().pendingBoxCorner).toBeNull();
  });

  it("defaults to element mode, and switching modes drops a pending corner", () => {
    const store = useViewerStore.getState();
    expect(useViewerStore.getState().volumeMode).toBe("element");

    store.setVolumeMode("box");
    store.addBoxVolumePoint([0, 0, 0]);
    store.setVolumeMode("element");

    expect(useViewerStore.getState().pendingBoxCorner).toBeNull();
  });

  it("survives reset as a preference, unlike the measurements themselves", () => {
    const store = useViewerStore.getState();
    store.setVolumeMode("box");
    store.addBoxVolumePoint([0, 0, 0]);
    store.addElementVolume("m1", 1, 1, [0, 0, 0]);

    store.reset();

    const state = useViewerStore.getState();
    expect(state.volumeMode).toBe("box");
    expect(state.pendingBoxCorner).toBeNull();
    expect(state.volumeMeasurements).toEqual([]);
  });

  it("removes one volume by id", () => {
    const store = useViewerStore.getState();
    store.addElementVolume("m1", 1, 1, [0, 0, 0]);
    store.addElementVolume("m1", 2, 2, [1, 1, 1]);

    const [first, second] = useViewerStore.getState().volumeMeasurements;
    useViewerStore.getState().removeVolumeMeasurement(first.id);
    expect(useViewerStore.getState().volumeMeasurements).toEqual([second]);
  });
});

describe("snap targets", () => {
  it("defaults to corners only", () => {
    expect(useViewerStore.getState().snapTargets).toEqual({
      corner: true,
      edgeMidpoint: false,
      edge: false,
    });
  });

  it("toggles one target independently of the others", () => {
    useViewerStore.getState().setSnapTarget("edgeMidpoint", true);
    expect(useViewerStore.getState().snapTargets).toEqual({
      corner: true,
      edgeMidpoint: true,
      edge: false,
    });

    useViewerStore.getState().setSnapTarget("corner", false);
    expect(useViewerStore.getState().snapTargets).toEqual({
      corner: false,
      edgeMidpoint: true,
      edge: false,
    });

    useViewerStore.getState().setSnapTarget("edge", true);
    expect(useViewerStore.getState().snapTargets).toEqual({
      corner: false,
      edgeMidpoint: true,
      edge: true,
    });
  });

  it("survives reset — a preference, not part of the loaded model", () => {
    // Set every target explicitly: `reset()` (in `beforeEach`) deliberately
    // leaves this alone, so a value left over from a previous test would
    // otherwise still be sitting here.
    useViewerStore.getState().setSnapTarget("corner", false);
    useViewerStore.getState().setSnapTarget("edgeMidpoint", false);
    useViewerStore.getState().setSnapTarget("edge", true);
    useViewerStore.getState().reset();

    expect(useViewerStore.getState().snapTargets).toEqual({
      corner: false,
      edgeMidpoint: false,
      edge: true,
    });
  });
});
