import { describe, expect, it } from "vitest";

import { blockedBy, isOutOfMemory, type StageResult } from "../stages";

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
    expect([...blocked.keys()].sort()).toEqual(["industry_practices", "normative_ia", "normative_ip", "schema"]);
    expect(blocked.get("schema")).toBe("syntax");
    expect(blockedBy({ header: result("header", "invalid") }).size).toBe(0);
    expect(blockedBy({ header_syntax: result("header_syntax", "failed") }).get("header")).toBe("header_syntax");
  });
});
