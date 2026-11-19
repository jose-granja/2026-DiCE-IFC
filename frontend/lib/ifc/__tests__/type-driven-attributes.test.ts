// @vitest-environment jsdom

/**
 * A door's OperationType and a window's PartitioningType, which their type
 * dictates (buildingSMART's BLT001/BLT002), on a real file through the real
 * engine: what the properties panel shows, and what IDS validation does with it.
 *
 * `fixtures/ifc/door-window-types-ifc4.ifc` has one element per case, each
 * named D1…D4 / W1…W4 and described in its Description. buildingSMART's rules
 * (`npm run validator:check -- fixtures/ifc/door-window-types-ifc4.ifc
 * normative_ia`) report BLT001 on #13, #14, #16 and BLT002 on #23, #24, #26,
 * and pass the rest.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ifcLiteAdapter, resetIfcLiteAdapter } from "../ifc-lite-adapter";
import { parseIdsForEngine } from "../ids-document";

const FIXTURES = path.resolve(__dirname, "../../../fixtures");

const buffer = await readFile(path.join(FIXTURES, "ifc/door-window-types-ifc4.ifc"));
const model = await ifcLiteAdapter.loadModel({
  name: "door-window-types-ifc4.ifc",
  bytes: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
});

afterAll(() => {
  resetIfcLiteAdapter();
});

const shown = async (expressId: number) => (await ifcLiteAdapter.getElementInfo(model.id, expressId)).typeDrivenAttributes;

describe("getElementInfo: attributes the type dictates", () => {
  it("shows the type's OperationType on a door that leaves it empty", async () => {
    expect(await shown(10)).toEqual([
      { name: "OperationType", value: "SINGLE_SWING_LEFT", enumValue: "SINGLE_SWING_LEFT", source: "type" },
    ]);
  });

  it("shows the type's, not the door's own, when a typed door overrides it", async () => {
    expect(await shown(13)).toEqual([
      { name: "OperationType", value: "SINGLE_SWING_LEFT", enumValue: "SINGLE_SWING_LEFT", source: "type", overridden: "SINGLE_SWING_RIGHT" },
    ]);
  });

  it("shows an untyped door's own, a USERDEFINED one by its name", async () => {
    expect(await shown(14)).toEqual([
      { name: "OperationType", value: "SINGLE_SWING_LEFT", enumValue: "SINGLE_SWING_LEFT", source: "occurrence" },
    ]);
    expect(await shown(15)).toEqual([
      { name: "OperationType", value: "Pivot", enumValue: "USERDEFINED", source: "occurrence", userDefinedIn: "UserDefinedOperationType" },
    ]);
  });

  it("shows the type's PartitioningType on a window that leaves it empty", async () => {
    expect(await shown(20)).toEqual([
      { name: "PartitioningType", value: "DOUBLE_PANEL_VERTICAL", enumValue: "DOUBLE_PANEL_VERTICAL", source: "type" },
    ]);
    expect(await shown(23)).toEqual([
      { name: "PartitioningType", value: "DOUBLE_PANEL_VERTICAL", enumValue: "DOUBLE_PANEL_VERTICAL", source: "type", overridden: "SINGLE_PANEL" },
    ]);
  });
});

describe("IDS: an attribute facet reads the occurrence's own value", () => {
  // IDS 1.0 (and ifctester): attributes are not inherited from the type; only
  // the entity facet's predefinedType is. So a door that follows BLT001 —
  // OperationType left to its type — fails a requirement that it have one.
  // That is the standard's answer, and the engine gives it; an IDS that means
  // "every door's type states it" should apply to IFCDOORTYPE instead.
  it("fails the typed door and window that leave it to their type, and passes the rest", async () => {
    const document = parseIdsForEngine(await readFile(path.join(FIXTURES, "ids/door-operation-type.ids"), "utf8"));
    const report = await ifcLiteAdapter.validateIds(model.id, document);
    const failing = (index: number) =>
      report.specifications[index].entities.filter((entity) => !entity.passed).map((entity) => entity.expressId).sort((a, b) => a - b);

    expect(failing(0)).toEqual([10]);
    expect(failing(1)).toEqual([20]);
  });
});
