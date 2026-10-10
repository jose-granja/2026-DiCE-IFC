import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useViewerStore, type ViewerModel } from "@/lib/viewer/store";
import { CLASH_COLOUR_A, CLASH_COLOUR_B } from "../colours";
import { clearClashHighlight, showClash, withClashHighlightPaused } from "../highlight";
import type { ClashResultItem } from "../types";

const element = (id: number) => ({
  key: `m#${id}`,
  modelId: "m",
  modelName: "m.ifc",
  expressId: id,
  type: "IfcWall",
  name: `Wall ${id}`,
  globalId: `G${id}`,
});

const clash = (a: number, b: number): ClashResultItem => ({
  id: `c${a}-${b}`,
  taskId: "r0",
  a: `m#${a}`,
  b: `m#${b}`,
  kind: "hard",
  distance: 0,
  depth: 0.1,
  extent: [0.1, 0.1, 0.1],
  point: [0, 0, 0],
  min: [0, 0, 0],
  max: [0.1, 0.1, 0.1],
  elementA: element(a),
  elementB: element(b),
  rule: "A × B",
  toleranceName: "T",
});

const colours = () => Object.fromEntries(useViewerStore.getState().colouring);

describe("showing a clash in the viewer", () => {
  beforeEach(() => {
    useViewerStore.getState().reset();
    useViewerStore.setState({ models: [{ summary: { id: "m" } } as unknown as ViewerModel] });
  });
  afterEach(() => clearClashHighlight());

  it("colours the two elements", () => {
    showClash(clash(1, 2), false);
    expect(colours()).toEqual({ "m#1": CLASH_COLOUR_A, "m#2": CLASH_COLOUR_B });
  });

  it("takes the colours back when everything is shown again", () => {
    showClash(clash(1, 2), false);
    useViewerStore.getState().resetVisibility();
    expect(colours()).toEqual({});
  });

  it("also isolates when asked, and Show all undoes both", () => {
    showClash(clash(1, 2), true);
    expect(useViewerStore.getState().isolated?.size).toBe(2);
    useViewerStore.getState().resetVisibility();
    expect(useViewerStore.getState().isolated).toBeNull();
    expect(colours()).toEqual({});
  });

  it("takes them back when something else is isolated, hidden or filtered", () => {
    showClash(clash(1, 2), false);
    useViewerStore.getState().isolate([{ modelId: "m", expressId: 9 }]);
    expect(colours()).toEqual({});

    showClash(clash(1, 2), false);
    useViewerStore.getState().hide([{ modelId: "m", expressId: 9 }]);
    expect(colours()).toEqual({});

    showClash(clash(1, 2), false);
    useViewerStore.getState().setFacetVisible(new Set(["m#3"]));
    expect(colours()).toEqual({});
  });

  it("keeps them through a selection, which is not a change of view", () => {
    showClash(clash(1, 2), false);
    useViewerStore.getState().select([{ modelId: "m", expressId: 5 }]);
    expect(Object.keys(colours())).toHaveLength(2);
  });

  it("replaces the previous clash's colours with the next one's", () => {
    showClash(clash(1, 2), false);
    showClash(clash(3, 4), false);
    expect(colours()).toEqual({ "m#3": CLASH_COLOUR_A, "m#4": CLASH_COLOUR_B });
  });

  it("leaves colours that were not its own alone", () => {
    useViewerStore.getState().setColouring([{ ref: { modelId: "m", expressId: 7 }, colour: "#123456" }]);
    showClash(clash(1, 2), false);
    useViewerStore.getState().resetVisibility();
    expect(colours()).toEqual({ "m#7": "#123456" });
  });

  it("is not undone by the viewer being moved around on its behalf", async () => {
    showClash(clash(1, 2), false);
    await withClashHighlightPaused(async () => {
      useViewerStore.getState().isolate([{ modelId: "m", expressId: 1 }]);
      useViewerStore.getState().clearIsolation();
    });
    expect(Object.keys(colours())).toHaveLength(2);
    // ...but a change after that is.
    useViewerStore.getState().resetVisibility();
    expect(colours()).toEqual({});
  });
});
