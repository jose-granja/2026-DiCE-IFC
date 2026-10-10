import { beforeEach, describe, expect, it } from "vitest";

import type { GeoreferenceView, ModelSummary } from "@/lib/ifc/types";
import { useViewerStore, type ViewerModel } from "../store";

function summary(id: string): ModelSummary {
  return {
    id,
    name: `${id}.ifc`,
    schema: "IFC4",
    entityCount: 100,
    byteLength: 1000,
    parseTimeMs: 10,
    lengthUnitScale: 1,
  };
}

const GEOREFERENCED: GeoreferenceView = {
  hasGeoreference: true,
  source: "mapConversion",
  mapConversion: { eastings: -40000, northings: 180000, orthogonalHeight: 0 },
  projectedCRS: { name: "EPSG:3763" },
};

function viewerModel(id: string, georeference: GeoreferenceView): ViewerModel {
  return {
    summary: summary(id),
    colour: "#1b6ea8",
    visible: true,
    load: { status: "ready" },
    georeference,
    spatialTree: null,
    entityTypes: [],
    coordinates: {
      originShift: [0, 0, 0],
      originalBounds: { min: [0, 0, 0], max: [10, 5, 10] },
      shiftedBounds: { min: [0, 0, 0], max: [10, 5, 10] },
      hasLargeCoordinates: false,
    },
    hasGeometry: true,
  };
}

beforeEach(() => {
  useViewerStore.getState().reset();
});

describe("models", () => {
  it("assigns a distinct colour per model", () => {
    const store = useViewerStore.getState();
    store.addModel({ ...viewerModel("a", GEOREFERENCED), colour: undefined as never });
    store.addModel({ ...viewerModel("b", GEOREFERENCED), colour: undefined as never });

    const [a, b] = useViewerStore.getState().models;
    expect(a.colour).not.toBe(b.colour);
  });

  it("federates on add, without the caller asking", () => {
    useViewerStore.getState().addModel(viewerModel("a", GEOREFERENCED));
    expect(useViewerStore.getState().worldOrigin?.source).toBe("mapConversion");
    expect(useViewerStore.getState().placements["a"].confidence).toBe("exact");
  });

  it("re-federates when geometry arrives later", () => {
    const store = useViewerStore.getState();
    store.addModel({ ...viewerModel("a", GEOREFERENCED), coordinates: null });

    // Before geometry the model still participates, at its unshifted origin.
    expect(useViewerStore.getState().placements["a"]).toBeDefined();

    useViewerStore.getState().updateModel("a", {
      coordinates: {
        originShift: [100, 0, -200],
        originalBounds: { min: [0, 0, 0], max: [10, 5, 10] },
        shiftedBounds: { min: [0, 0, 0], max: [10, 5, 10] },
        hasLargeCoordinates: true,
      },
    });

    // The origin is derived from this model, so it still sits at zero — but the
    // world origin's map position moved with the shift.
    expect(useViewerStore.getState().worldOrigin?.mapPosition?.[0]).toBeCloseTo(
      -40000 + 100,
      6,
    );
  });

  it("drops selection, visibility and colouring that referred to a removed model", () => {
    const store = useViewerStore.getState();
    store.addModel(viewerModel("a", GEOREFERENCED));
    store.addModel(viewerModel("b", GEOREFERENCED));

    useViewerStore.getState().select([
      { modelId: "a", expressId: 1 },
      { modelId: "b", expressId: 2 },
    ]);
    useViewerStore.getState().hide([{ modelId: "a", expressId: 3 }]);
    useViewerStore
      .getState()
      .setColouring([{ ref: { modelId: "a", expressId: 4 }, colour: "#f00" }]);

    useViewerStore.getState().removeModel("a");

    const state = useViewerStore.getState();
    expect(state.selection).toEqual([{ modelId: "b", expressId: 2 }]);
    expect(state.hidden.size).toBe(0);
    expect(state.colouring.size).toBe(0);
  });
});

describe("selection", () => {
  it("keys by model and express id, so two models can share an express id", () => {
    const store = useViewerStore.getState();
    store.addModel(viewerModel("a", GEOREFERENCED));
    store.addModel(viewerModel("b", GEOREFERENCED));

    useViewerStore.getState().select([{ modelId: "a", expressId: 42 }]);

    expect(
      useViewerStore.getState().isSelected({ modelId: "a", expressId: 42 }),
    ).toBe(true);
    expect(
      useViewerStore.getState().isSelected({ modelId: "b", expressId: 42 }),
    ).toBe(false);
  });

  it("adds and toggles", () => {
    const ref = { modelId: "a", expressId: 1 };
    useViewerStore.getState().select([ref]);
    useViewerStore.getState().select([{ modelId: "a", expressId: 2 }], "add");
    expect(useViewerStore.getState().selection).toHaveLength(2);

    useViewerStore.getState().select([ref], "toggle");
    expect(useViewerStore.getState().selection).toEqual([
      { modelId: "a", expressId: 2 },
    ]);
  });
});

describe("visibility", () => {
  beforeEach(() => {
    useViewerStore.getState().addModel(viewerModel("a", GEOREFERENCED));
  });

  it("hides and shows individual entities", () => {
    const ref = { modelId: "a", expressId: 1 };
    expect(useViewerStore.getState().isVisible(ref)).toBe(true);

    useViewerStore.getState().hide([ref]);
    expect(useViewerStore.getState().isVisible(ref)).toBe(false);

    useViewerStore.getState().show([ref]);
    expect(useViewerStore.getState().isVisible(ref)).toBe(true);
  });

  it("isolation overrides hiding rather than combining with it", () => {
    const kept = { modelId: "a", expressId: 1 };
    const other = { modelId: "a", expressId: 2 };

    useViewerStore.getState().hide([kept]);
    useViewerStore.getState().isolate([kept]);

    // Isolation is a whitelist: the isolated entity shows even though it was
    // hidden, and everything else is hidden even though it was not.
    expect(useViewerStore.getState().isVisible(kept)).toBe(true);
    expect(useViewerStore.getState().isVisible(other)).toBe(false);

    useViewerStore.getState().clearIsolation();
    expect(useViewerStore.getState().isVisible(kept)).toBe(false);
  });

  it("isolating clears a leftover class filter instead of being capped by it", () => {
    const filtered = { modelId: "a", expressId: 1 };
    const isolated = { modelId: "a", expressId: 2 };

    // A class filter (the Classes tab) narrows to `filtered` only — the
    // Structure tree's own Isolate button, on a *different* entity, must not
    // be silently intersected with that leftover filter: it is a fresh
    // "show exactly this" claim of its own.
    useViewerStore.getState().setFacetVisible(new Set(["a#1"]));
    useViewerStore.getState().isolate([isolated]);

    expect(useViewerStore.getState().isVisible(isolated)).toBe(true);
    expect(useViewerStore.getState().isVisible(filtered)).toBe(false);
  });

  it("combines spatial-tree isolation with facet filters", () => {
    const first = { modelId: "a", expressId: 1 };
    const shared = { modelId: "a", expressId: 2 };
    const third = { modelId: "a", expressId: 3 };

    useViewerStore
      .getState()
      .setFacetVisible(new Set(["a#1", "a#2"]));
    useViewerStore
      .getState()
      .isolate([shared, third], "intersect");

    expect(useViewerStore.getState().isVisible(first)).toBe(false);
    expect(useViewerStore.getState().isVisible(shared)).toBe(true);
    expect(useViewerStore.getState().isVisible(third)).toBe(false);

    // Changing the filter after isolation keeps the subtree as the scope.
    useViewerStore.getState().setFacetVisible(new Set(["a#3"]));
    expect(useViewerStore.getState().isVisible(shared)).toBe(false);
    expect(useViewerStore.getState().isVisible(third)).toBe(true);
  });

  it("a hidden model hides its entities regardless of isolation", () => {
    const ref = { modelId: "a", expressId: 1 };
    useViewerStore.getState().isolate([ref]);
    useViewerStore.getState().setModelVisible("a", false);
    expect(useViewerStore.getState().isVisible(ref)).toBe(false);
  });

  it("starts spaces, openings, and virtual elements hidden", () => {
    const refs = {
      space: { modelId: "a", expressId: 10 },
      zone: { modelId: "a", expressId: 11 },
      opening: { modelId: "a", expressId: 12 },
      virtual: { modelId: "a", expressId: 13 },
      wall: { modelId: "a", expressId: 14 },
    };
    useViewerStore.getState().registerEntityTypes("a", [
      { expressId: 10, type: "IfcSpace" },
      { expressId: 11, type: "IfcSpatialZone" },
      { expressId: 12, type: "IfcOpeningElement" },
      { expressId: 13, type: "IfcVirtualElement" },
      { expressId: 14, type: "IfcWall" },
    ]);

    expect(useViewerStore.getState().isVisible(refs.space)).toBe(false);
    expect(useViewerStore.getState().isVisible(refs.zone)).toBe(true);
    expect(useViewerStore.getState().isVisible(refs.opening)).toBe(false);
    expect(useViewerStore.getState().isVisible(refs.virtual)).toBe(false);
    expect(useViewerStore.getState().isVisible(refs.wall)).toBe(true);
  });

  it("updates and resets a semantic visibility setting", () => {
    const space = { modelId: "a", expressId: 20 };
    useViewerStore
      .getState()
      .registerEntityTypes("a", [{ expressId: 20, type: "IFC_SPACE" }]);

    useViewerStore.getState().setTypeVisibility("spaces", true);
    expect(useViewerStore.getState().isVisible(space)).toBe(true);

    useViewerStore.getState().resetTypeVisibility();
    expect(useViewerStore.getState().isVisible(space)).toBe(false);
  });

  it("lets an explicit isolation reveal a normally hidden category", () => {
    const space = { modelId: "a", expressId: 30 };
    useViewerStore
      .getState()
      .registerEntityTypes("a", [{ expressId: 30, type: "IfcSpace" }]);
    useViewerStore.getState().isolate([space]);

    expect(useViewerStore.getState().isVisible(space)).toBe(true);
  });
});

describe("federation bounds", () => {
  it("unions visible models at their placements", () => {
    const store = useViewerStore.getState();
    store.addModel(viewerModel("a", GEOREFERENCED));
    store.addModel(
      viewerModel("b", {
        ...GEOREFERENCED,
        mapConversion: { eastings: -39900, northings: 180000, orthogonalHeight: 0 },
      }),
    );

    const bounds = useViewerStore.getState().federationBounds()!;
    expect(bounds.max[0]).toBeCloseTo(110, 6);
  });

  it("excludes hidden models", () => {
    const store = useViewerStore.getState();
    store.addModel(viewerModel("a", GEOREFERENCED));
    store.addModel(
      viewerModel("b", {
        ...GEOREFERENCED,
        mapConversion: { eastings: -39900, northings: 180000, orthogonalHeight: 0 },
      }),
    );

    useViewerStore.getState().setModelVisible("b", false);
    expect(useViewerStore.getState().federationBounds()!.max[0]).toBeCloseTo(10, 6);
  });
});
