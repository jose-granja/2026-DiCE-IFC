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

  it("a hidden model hides its entities regardless of isolation", () => {
    const ref = { modelId: "a", expressId: 1 };
    useViewerStore.getState().isolate([ref]);
    useViewerStore.getState().setModelVisible("a", false);
    expect(useViewerStore.getState().isVisible(ref)).toBe(false);
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
