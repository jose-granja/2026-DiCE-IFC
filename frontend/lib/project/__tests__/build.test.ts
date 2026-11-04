import { DEFAULT_CONTEXT_APPEARANCE } from "@/lib/viewer/context-appearance";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { emptyMatrix, newGroup } from "@/lib/clash/matrix";
import { readClashWorkbook } from "@/lib/clash/workbook";
import { readQuantityWorkbook } from "@/lib/spreadsheets/quantity-workbook";
import { EMPTY_ELEMENT_FILTER } from "@/lib/ifc/types";
import { DEFAULT_DISPLAY_SETTINGS } from "@/lib/viewer/display-settings";
import { DEFAULT_SECTION_CAP_STYLE } from "@/lib/viewer/section-cap";
import { DEFAULT_TYPE_VISIBILITY } from "@/lib/viewer/type-visibility";

import {
  buildProject,
  liveRefs,
  parseLiveRefKey,
  planRestore,
  type SessionSnapshot,
} from "../build";
import type { ProjectSource } from "../folder";
import { PROJECT_FILE, parseProjectManifest } from "../manifest";
import { parseLensFile } from "@/lib/lens/file";

// Reading a workbook parses its XML, which Node needs jsdom for.
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new () => { window: { DOMParser: typeof DOMParser; close(): void } };
};
const dom = new JSDOM();
beforeAll(() => vi.stubGlobal("DOMParser", dom.window.DOMParser));
afterAll(() => {
  vi.unstubAllGlobals();
  dom.window.close();
});

const wall = new File(["ISO-10303-21; wall"], "Wall.ifc");
const wallAgain = new File(["ISO-10303-21; other wall"], "wall.ifc");
const scan = new File(["ply"], "scan.ply");
const city = new File(["{}"], "porto.city.json");

function session(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  const walls = { ...newGroup("Walls"), id: "g1", filter: { ...EMPTY_ELEMENT_FILTER, classes: ["IfcWall*"] } };
  return {
    models: [
      { id: "m-a", name: "Wall.ifc", file: wall, colour: "#1b6ea8", visible: true },
      // Same name ignoring case: must not overwrite the first on macOS.
      { id: "m-b", name: "wall.ifc", file: wallAgain, colour: "#d97706", visible: false, manualOffset: [1, 2, 3] },
      // Its file is gone (opened, then the source went away).
      { id: "m-c", name: "Lost.ifc", file: undefined, colour: "#2f9e6f", visible: true },
    ],
    pointClouds: [{ name: "scan.ply", file: scan, frame: "map", mode: "height", size: 3, visible: true }],
    context: { file: city, visible: false, clipEnabled: true, clipRadius: "250", appearance: DEFAULT_CONTEXT_APPEARANCE },
    validationIds: { xml: "<ids/>", title: "Fire safety", source: "file" },
    editorIds: null,
    bcf: new Uint8Array([80, 75, 3, 4]),
    bcfMarkersVisible: true,
    quantities: [
      {
        id: "q1",
        code: "13.01",
        description: "Walls",
        query: {
          filters: { classes: ["IfcWall"], predefinedTypes: [], objectTypes: [], materials: [], properties: [] },
          sources: [{ id: "s", alias: "count", kind: "count" }],
        },
      },
    ],
    clash: { ...emptyMatrix(), groups: [walls] },
    panel: "measure",
    camera: { position: [10, 20, 30], target: [0, 0, 0], projection: "perspective", fov: 50 },
    display: { ...DEFAULT_DISPLAY_SETTINGS, exposure: 1.1, edgesOn: false },
    typeVisibility: { ...DEFAULT_TYPE_VISIBILITY, spaces: true },
    sectionCapStyle: { ...DEFAULT_SECTION_CAP_STYLE, enabled: true },
    snapTargets: { corner: true, edgeMidpoint: true, edge: false },
    areaMode: "face",
    volumeMode: "box",
    pointCloudEdgeShading: false,
    lenses: {
      saved: [{ id: "lens-1", name: "Slabs", kind: "auto", source: { kind: "class" }, unmatched: "ghost" }],
      activeId: "lens-1",
    },
    globe: { on: true, layer: "google-photorealistic", assetId: "", url: "", imagery: "satellite-labels" },
    worldOrigin: { source: "mapConversion", mapPosition: [100, 200, 0] },
    typeFilter: ["IfcWall"],
    facets: { classes: ["IfcSlab"], materials: [] },
    hidden: [
      { modelId: "m-a", expressId: 71 },
      // On the model that cannot be saved: dropped, since it cannot come back.
      { modelId: "m-c", expressId: 5 },
    ],
    isolated: [{ modelId: "m-b", expressId: 73 }],
    isolationFilterMode: "replace",
    selection: [{ modelId: "m-b", expressId: 73 }],
    sectionPlanes: [{ id: "section-1", axis: "y", position: 2.5, rotation: 15, flipped: true, enabled: true }],
    measurements: [{ id: "measurement-1", start: [0, 0, 0], end: [3, 4, 0] }],
    angleMeasurements: [{ id: "angle-1", a: [1, 0, 0], vertex: [0, 0, 0], c: [0, 1, 0] }],
    areaMeasurements: [
      { id: "area-1", kind: "points", points: [[0, 0, 0], [1, 0, 0], [1, 1, 0]] },
      { id: "area-2", kind: "face", modelId: "m-b", expressId: 73, triangles: [[[0, 0, 0], [1, 0, 0], [0, 1, 0]]] },
      { id: "area-3", kind: "face", modelId: "m-c", expressId: 9, triangles: [[[0, 0, 0], [1, 0, 0], [0, 1, 0]]] },
    ],
    volumeMeasurements: [
      { id: "volume-1", kind: "element", modelId: "m-a", expressId: 71, volume: 1.5, centroid: [0, 1, 0] },
      { id: "volume-2", kind: "box", corner1: [0, 0, 0], corner2: [1, 2, 3] },
    ],
    ...over,
  };
}

/** The folder `buildProject` describes, as `readProjectFromFileList` would present it. */
function folderOf(files: Array<{ path: string; data: Blob }>): ProjectSource & { manifestBlob: Blob } {
  const byPath = new Map(files.map((file) => [file.path.toLocaleLowerCase(), file.data]));
  const manifestBlob = byPath.get(PROJECT_FILE)!;
  return {
    name: "Project",
    manifestBlob,
    manifestText: "",
    file: (path) => {
      const blob = byPath.get(path.toLocaleLowerCase());
      return blob ? new File([blob], path.split("/").pop()!) : undefined;
    },
  };
}

describe("saving a session", () => {
  it("puts every available file in its own folder, without two sharing a name", () => {
    const { files, skipped } = buildProject(session());
    expect(files.map((file) => file.path)).toEqual([
      "project.json",
      "models/Wall.ifc",
      "models/wall (2).ifc",
      "pointclouds/scan.ply",
      "context/porto.city.json",
      "ids/Fire safety.ids",
      "quantities/quantities.xlsx",
      "clash/clash-matrix.xlsx",
      "lenses/lenses.json",
      "bcf/topics.bcf",
    ]);
    // The model files are the originals, by reference, not re-encoded copies.
    expect(files[1].data).toBe(wall);
    // A model whose source is gone is reported, not silently left out.
    expect(skipped).toEqual([{ name: "Lost.ifc", reason: "noSource" }]);
  });

  it("writes the lenses as the list the Lens tab uploads, and records which one was on", async () => {
    const { manifest, files } = buildProject(session());
    expect(manifest.lenses).toEqual({ path: "lenses/lenses.json", activeId: "lens-1" });
    const list = files.find((file) => file.path === "lenses/lenses.json")!;
    expect(parseLensFile(await list.data.text()).lenses).toEqual([
      { id: "lens-1", name: "Slabs", kind: "auto", source: { kind: "class" }, unmatched: "ghost" },
    ]);
  });

  it("writes no lens list without lenses of the user's own, but keeps a built-in that was on", () => {
    const { manifest, files } = buildProject(
      session({ lenses: { saved: [], activeId: "builtin:by-class" } }),
    );
    expect(manifest.lenses).toEqual({ path: null, activeId: "builtin:by-class" });
    expect(files.some((file) => file.path.startsWith("lenses/"))).toBe(false);
  });

  it("records whether the point clouds were edge-shaded", () => {
    expect(buildProject(session()).manifest.viewer.pointCloudEdgeShading).toBe(false);
  });

  it("records the BCF file with whether its 3D markers were shown", () => {
    expect(buildProject(session()).manifest.bcf).toEqual({ path: "bcf/topics.bcf", markersVisible: true });
    expect(buildProject(session({ bcfMarkersVisible: false })).manifest.bcf).toEqual({
      path: "bcf/topics.bcf",
      markersVisible: false,
    });
  });

  it("records the 3D world context as it was, switched on or not", () => {
    expect(buildProject(session()).manifest.viewer.globe).toEqual({
      on: true,
      layer: "google-photorealistic",
      assetId: "",
      url: "",
      imagery: "satellite-labels",
    });
  });

  it("reads a project from before the map choice as a road map", () => {
    const manifest = buildProject(session()).manifest;
    const older = { ...manifest.viewer.globe!, imagery: undefined };
    const parsed = parseProjectManifest(JSON.stringify({ ...manifest, viewer: { ...manifest.viewer, globe: older } }));
    // Absent, and restored as a road map (`session.ts`).
    expect(parsed.viewer.globe?.imagery).toBeUndefined();
    expect(parsed.viewer.globe?.layer).toBe("google-photorealistic");
  });

  it("names elements by model position, and drops those on a model it could not save", () => {
    const { manifest } = buildProject(session());
    expect(manifest.models.map((model) => model.name)).toEqual(["Wall.ifc", "wall.ifc"]);
    expect(manifest.filters.hidden).toEqual([{ model: 0, expressId: 71 }]);
    expect(manifest.filters.isolated).toEqual([{ model: 1, expressId: 73 }]);
    expect(manifest.measurements.areas.map((area) => area.id)).toEqual(["area-1", "area-2"]);
    expect(manifest.measurements.areas[1]).toMatchObject({ kind: "face", element: { model: 1, expressId: 73 } });
    expect(manifest.measurements.volumes[0]).toMatchObject({ kind: "element", element: { model: 0, expressId: 71 } });
  });
});

describe("files the browser can reopen", () => {
  it("are listed by their path, so a copy kept in the browser can hold a reference instead", () => {
    const handle = { kind: "file", name: "Wall.ifc" } as unknown as FileSystemFileHandle;
    const cloudHandle = { kind: "file", name: "scan.ply" } as unknown as FileSystemFileHandle;
    const base = session();
    const { handles, files } = buildProject(
      session({
        models: [{ ...base.models[0], handle }, base.models[1]],
        pointClouds: [{ ...base.pointClouds[0], handle: cloudHandle }],
      }),
    );
    expect(handles).toEqual([
      { path: "models/Wall.ifc", handle },
      { path: "pointclouds/scan.ply", handle: cloudHandle },
    ]);
    // The folder still holds every file; whoever writes it decides what to copy.
    expect(files.map((file) => file.path)).toContain("models/Wall.ifc");
  });
});

describe("the quantity list and the clash matrix", () => {
  it("go in as Excel workbooks, with only their paths in project.json", () => {
    const { manifest } = buildProject(session());
    expect(manifest.quantities).toEqual({ path: "quantities/quantities.xlsx" });
    expect(manifest.clash).toEqual({ path: "clash/clash-matrix.xlsx" });
  });

  it("are the workbooks the panels import, holding the same list and matrix", async () => {
    const { files } = buildProject(session());
    const bytes = async (path: string) =>
      new Uint8Array(await files.find((file) => file.path === path)!.data.arrayBuffer());

    const [query] = readQuantityWorkbook(await bytes("quantities/quantities.xlsx"));
    expect(query).toMatchObject({
      code: "13.01",
      description: "Walls",
      query: { filters: { classes: ["IfcWall"] }, sources: [{ kind: "count" }] },
    });
    const matrix = readClashWorkbook(await bytes("clash/clash-matrix.xlsx"));
    expect(matrix.groups.map((group) => [group.name, group.filter.classes])).toEqual([["Walls", ["IfcWall*"]]]);
  });

  it("are left out when there is nothing in them", () => {
    const { manifest, files } = buildProject(
      session({ quantities: [], clash: emptyMatrix() }),
    );
    expect(manifest.quantities).toBeNull();
    expect(manifest.clash).toBeNull();
    expect(files.some((file) => file.path.endsWith(".xlsx"))).toBe(false);
  });
});

describe("a saved project read back", () => {
  it("parses as the manifest that was written", async () => {
    const built = buildProject(session(), new Date("2026-10-13T12:00:00Z"));
    const manifest = parseProjectManifest(await built.files[0].data.text());
    expect(manifest).toEqual(built.manifest);
    expect(manifest.savedAt).toBe("2026-10-13T12:00:00.000Z");
  });

  it("matches each manifest path to the folder's file, restoring the original names", async () => {
    const built = buildProject(session());
    const folder = folderOf(built.files);
    const manifest = parseProjectManifest(await folder.manifestBlob.text());
    const plan = planRestore(manifest, folder);

    expect(plan.missing).toEqual([]);
    expect(plan.models.map((model) => [model.index, model.file.name])).toEqual([
      [0, "Wall.ifc"],
      // Saved as "wall (2).ifc" so the two could share a folder; opened as itself.
      [1, "wall.ifc"],
    ]);
    expect(await plan.models[1].file.text()).toBe("ISO-10303-21; other wall");
    expect(plan.pointClouds[0].entry).toMatchObject({ frame: "map", mode: "height", size: 3 });
    expect(plan.context?.entry).toMatchObject({ visible: false, clipRadius: "250", appearance: DEFAULT_CONTEXT_APPEARANCE });
    expect(plan.validationIds).toMatchObject({ title: "Fire safety", source: "file" });
    expect(plan.quantities?.name).toBe("quantities.xlsx");
    expect(plan.clash?.name).toBe("clash-matrix.xlsx");
    expect(plan.lenses?.name).toBe("lenses.json");
  });

  it("still reads the lenses a first project carried inline", () => {
    const built = buildProject(session());
    const legacy = {
      ...built.manifest,
      lenses: {
        saved: [{ id: "old", name: "Old", kind: "auto", source: { kind: "storey" } }],
        activeId: "old",
      },
    };
    const manifest = parseProjectManifest(JSON.stringify(legacy));
    expect(manifest.lenses).toEqual({
      path: null,
      activeId: "old",
      saved: [{ id: "old", name: "Old", kind: "auto", source: { kind: "storey" }, unmatched: "ghost" }],
    });
  });

  it("lists what the folder is missing rather than failing the whole restore", async () => {
    const built = buildProject(session());
    const folder = folderOf(built.files.filter((file) => file.path !== "models/Wall.ifc"));
    const plan = planRestore(parseProjectManifest(await folder.manifestBlob.text()), folder);
    expect(plan.missing).toEqual(["models/Wall.ifc"]);
    expect(plan.models.map((model) => model.index)).toEqual([1]);
  });

  it("maps saved elements onto the models as they were reloaded", () => {
    // Model 0 reloaded as "new-a"; model 1 failed and has no id.
    const ids = new Map([[0, "new-a"]]);
    expect(
      liveRefs(
        [
          { model: 0, expressId: 71 },
          { model: 1, expressId: 73 },
        ],
        ids,
      ),
    ).toEqual([{ modelId: "new-a", expressId: 71 }]);
  });
});

describe("ref keys", () => {
  it("splits at the last #, since a model id may contain one", () => {
    expect(parseLiveRefKey("model#7#42")).toEqual({ modelId: "model#7", expressId: 42 });
    expect(parseLiveRefKey("nohash")).toBeNull();
    expect(parseLiveRefKey("m#x")).toBeNull();
  });
});

it("carries context edges, property colour overrides and hidden values through a project round trip", async () => {
  const appearance = { edgesOn: false, edgeWidth: 2.5, colouring: { property: "height", overrides: { "number:12": "#123456" }, hiddenValues: ["number:12"] } };
  const result = await buildProject(session({ context: { file: city, visible: true, clipEnabled: true, clipRadius: "100", appearance } }));
  const folder = folderOf(result.files);
  const manifest = parseProjectManifest(await folder.manifestBlob.text());
  const plan = await planRestore(manifest, folder);
  expect(plan.context?.entry.appearance).toEqual(appearance);
});
