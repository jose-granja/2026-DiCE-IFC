import { describe, expect, it } from "vitest";

import { blockedBy, customRulesLabel, isOutOfMemory, stagesFor, VALIDATION_STAGES, type StageResult, type ValidatorBuild } from "../stages";

describe("isOutOfMemory", () => {
  it("knows the ways Pyodide and Emscripten say memory ran out", () => {
    for (const message of [
      "PythonError: Traceback (most recent call last):\n  ...\nMemoryError",
      "RuntimeError: Aborted(OOM). Build with -sASSERTIONS for more info.",
      "Aborted(Cannot enlarge memory arrays to size 4294967296 bytes (OOM).)",
      "RangeError: WebAssembly.Memory.grow(): Maximum memory size exceeded",
      "RangeError: Array buffer allocation failed",
      "RuntimeError: memory access out of bounds",
    ]) {
      expect(isOutOfMemory(message), message).toBe(true);
    }
  });

  it("does not mistake a rule's or a parser's own error for it", () => {
    for (const message of [
      "KeyError: 'IfcZone'",
      "JSONDecodeError: Expecting value: line 1 column 1 (char 0)",
      "NotImplementedError: pyproj is not available",
    ]) {
      expect(isOutOfMemory(message), message).toBe(false);
    }
  });
});

describe("blockedBy", () => {
  const result = (stage: StageResult["stage"], status: StageResult["status"]): StageResult => ({ stage, status, outcomes: [], info: {} });

  it("stops what the service stops after a failed syntax or prerequisites stage", () => {
    const blocked = blockedBy({ syntax: result("syntax", "invalid") });
    expect([...blocked.keys()].sort()).toEqual(["dice_rules", "industry_practices", "normative_ia", "normative_ip", "schema"]);
    expect(blocked.get("schema")).toBe("syntax");
    expect(blockedBy({ header: result("header", "invalid") }).size).toBe(0);
    expect(blockedBy({ header_syntax: result("header_syntax", "failed") }).get("header")).toBe("header_syntax");
  });
});

describe("our own rules", () => {
  const build = (customRules: ValidatorBuild["customRules"]): ValidatorBuild => ({ service: {}, pyodide: "0.28.3", packages: [], bytes: 0, customRules });
  const custom = { name: "DiCE-IFC-Rules", source: "github" as const, github: "o/DiCE-IFC-Rules", commit: "c12ec33aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", modified: false, rules: ["DCE001"], docs: null };

  it("run as their own stage, last, only when the build has them", () => {
    expect(stagesFor(build(custom)).at(-1)).toBe("dice_rules");
    expect(stagesFor(build(null))).not.toContain("dice_rules");
    expect(stagesFor(build({ ...custom, rules: [] }))).not.toContain("dice_rules");
    expect(stagesFor(null)).toEqual(VALIDATION_STAGES.filter((s) => s !== "dice_rules"));
  });

  it("are named by repository and commit, a checkout's changes marked", () => {
    expect(customRulesLabel(build(custom))).toBe("DiCE-IFC-Rules c12ec33");
    expect(customRulesLabel(build({ ...custom, source: "local", modified: true }))).toBe("DiCE-IFC-Rules c12ec33+");
    expect(customRulesLabel(build({ ...custom, source: "local", commit: null }))).toBe("DiCE-IFC-Rules (local)");
    expect(customRulesLabel(build(null))).toBeNull();
  });
});
