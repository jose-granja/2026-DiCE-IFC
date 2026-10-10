import { describe, expect, it } from "vitest";

import {
  compileTextMatcher,
  compileTextMatchers,
  matchesAnyText,
  splitTextList,
  TextPatternError,
} from "../text-match";

describe("compileTextMatcher", () => {
  it("treats plain text as an exact, case-insensitive match", () => {
    const matcher = compileTextMatcher("  IfcWall ");
    expect(matcher.isRegex).toBe(false);
    expect(matcher.test("ifcwall")).toBe(true);
    expect(matcher.test("IfcWallStandardCase")).toBe(false);
  });

  it("reads /pattern/ as a regular expression searched anywhere", () => {
    const matcher = compileTextMatcher("/wall/");
    expect(matcher.isRegex).toBe(true);
    expect(matcher.test("IfcWallStandardCase")).toBe(true);
    expect(matcher.test("IfcSlab")).toBe(false);
  });

  it("anchors when asked to", () => {
    const matcher = compileTextMatcher("/^IfcWall$/");
    expect(matcher.test("IfcWall")).toBe(true);
    expect(matcher.test("IfcWallStandardCase")).toBe(false);
  });

  it("is case-insensitive by default and honours explicit flags", () => {
    expect(compileTextMatcher("/CONCRETE/").test("concrete C30")).toBe(true);
    expect(compileTextMatcher("/CONCRETE/u").test("concrete C30")).toBe(false);
  });

  it("is stable across repeated tests despite a g flag", () => {
    const matcher = compileTextMatcher("/a/g");
    expect([matcher.test("a"), matcher.test("a"), matcher.test("a")]).toEqual([true, true, true]);
  });

  it("explains a bad pattern", () => {
    expect(() => compileTextMatcher("/(/")).toThrow(TextPatternError);
  });

  it("keeps a lone slash or path as fixed text", () => {
    expect(compileTextMatcher("/").test("/")).toBe(true);
    expect(compileTextMatcher("a/b").test("A/B")).toBe(true);
  });
});

describe("matchesAnyText", () => {
  it("is true when any entry matches", () => {
    const matchers = compileTextMatchers(["IfcSlab", "/^IfcWall/", ""]);
    expect(matchesAnyText(matchers, "IfcWallStandardCase")).toBe(true);
    expect(matchesAnyText(matchers, "IfcBeam")).toBe(false);
  });
});

describe("splitTextList", () => {
  it("splits plain entries on commas", () => {
    expect(splitTextList("IfcWall, IfcSlab ,IfcBeam")).toEqual(["IfcWall", "IfcSlab", "IfcBeam"]);
  });

  it("does not cut a regular expression at its commas", () => {
    expect(splitTextList("/^Ifc(Wall|Slab)$/, IfcBeam, /a{1,3}/i")).toEqual([
      "/^Ifc(Wall|Slab)$/",
      "IfcBeam",
      "/a{1,3}/i",
    ]);
  });

  it("copes with empty input and stray commas", () => {
    expect(splitTextList("")).toEqual([]);
    expect(splitTextList(" , IfcWall,, ")).toEqual(["IfcWall"]);
  });
});

describe("wildcards in fixed text", () => {
  it("lets * and ? stand for any characters, matching the whole value", () => {
    const wall = compileTextMatcher("IfcWall*");
    expect(wall.test("IfcWall")).toBe(true);
    expect(wall.test("IfcWallStandardCase")).toBe(true);
    expect(wall.test("ifcwall")).toBe(true);
    expect(wall.test("IfcCurtainWall")).toBe(false);
    expect(compileTextMatcher("*").test("anything at all")).toBe(true);
    expect(compileTextMatcher("Ifc?lab").test("IfcSlab")).toBe(true);
    expect(compileTextMatcher("Ifc?lab").test("IfcSlabs")).toBe(false);
  });

  it("treats the other regex characters in a wildcard as plain text", () => {
    expect(compileTextMatcher("C30/37 (a)*").test("C30/37 (a) wet")).toBe(true);
    expect(compileTextMatcher("a.b*").test("axb")).toBe(false);
  });
});
