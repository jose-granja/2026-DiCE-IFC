// @vitest-environment jsdom

/**
 * IDS predefinedType checks agree with ifctester, the reference implementation.
 *
 * `fixtures/ifc/predefined-types-ifc4.ifc` holds one element per way a
 * predefined type can be set (on the occurrence, on its type, USERDEFINED with
 * and without a name, ObjectType or ElementType with no PredefinedType, a type
 * object on its own, element assemblies as partOf parents). The IDS files ask
 * each for every value, by simple value, enumeration, pattern and partOf.
 * `ifctester.json` is what ifctester 0.9.0.post1 answered. The scripts that
 * made all of it with IfcOpenShell are beside the IDS files: `make.py` writes
 * the elements and `cases.ids`, `make2.py` adds the partOf parents and
 * `restrictions.ids` (its `cases2.ifc` is the fixture model here).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ifcLiteAdapter, resetIfcLiteAdapter } from "@/lib/ifc/ifc-lite-adapter";
import { parseIdsForEngine } from "@/lib/ifc/ids-document";

const FIXTURES = path.resolve(__dirname, "../../../fixtures");
const DIR = path.join(FIXTURES, "ids/predefined-types");

/**
 * Where ifctester is not followed: it takes any requirement that accepts the
 * word "USERDEFINED" as asking for a user-defined type, so the pattern
 * `[A-Z]+` fails a STANDARD wall (`ifctesterPredefinedType`'s caller says more).
 */
const NOT_FOLLOWED = new Set(["restrictions.ids:C01|pattern[[A-Z]+]"]);

const bytes = await readFile(path.join(FIXTURES, "ifc/predefined-types-ifc4.ifc"));
const model = await ifcLiteAdapter.loadModel({
  name: "predefined-types-ifc4.ifc",
  bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
});
const expected: Record<string, Record<string, "pass" | "fail">> = JSON.parse(await readFile(path.join(DIR, "ifctester.json"), "utf8"));

afterAll(() => {
  resetIfcLiteAdapter();
});

describe("IDS predefinedType, against ifctester", () => {
  for (const file of Object.keys(expected)) {
    it(`gives ifctester's verdict on every specification of ${file}`, async () => {
      const report = await ifcLiteAdapter.validateIds(model.id, parseIdsForEngine(await readFile(path.join(DIR, file), "utf8")));
      const ours = Object.fromEntries(
        report.specifications.map((spec) => [spec.name, spec.applicableCount === 0 ? "n/a" : spec.failedCount === 0 ? "pass" : "fail"]),
      );
      const theirs = Object.fromEntries(
        Object.entries(expected[file]).filter(([name]) => !NOT_FOLLOWED.has(`${file}:${name}`)),
      );
      for (const name of Object.keys(theirs)) expect(ours[name], name).toBe(theirs[name]);
      expect(Object.keys(ours).length).toBe(Object.keys(expected[file]).length);
    }, 60_000);
  }

  it("still matches a value ifctester's quirk would refuse", async () => {
    const report = await ifcLiteAdapter.validateIds(model.id, parseIdsForEngine(await readFile(path.join(DIR, "restrictions.ids"), "utf8")));
    const spec = report.specifications.find((s) => s.name === "C01|pattern[[A-Z]+]")!;
    expect(spec.failedCount).toBe(0);
  });
});
