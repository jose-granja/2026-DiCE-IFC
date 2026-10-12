import { describe, expect, it } from "vitest";

import {
  compileClassificationFilter,
  isEmptyClassificationFilter,
  matchesClassification,
  type ClassificationFact,
} from "../classification-filter";

/** A wall classified in two systems at once — the case the rule exists for. */
const TWO_SYSTEMS: ClassificationFact[] = [
  { system: "Uniclass 2015", identification: "Ss_25_10_30", },
  { system: "Sistema Nacional", identification: "EF_25_10" },
];

const match = (filter: Parameters<typeof compileClassificationFilter>[0], facts: ClassificationFact[]) => {
  const compiled = compileClassificationFilter(filter);
  expect(compiled, "the filter asked for nothing").not.toBeNull();
  return matchesClassification(compiled!, facts);
};

describe("an empty filter", () => {
  it("is empty whether the fields are missing, blank or whitespace", () => {
    expect(isEmptyClassificationFilter({})).toBe(true);
    expect(isEmptyClassificationFilter({ system: "   ", codes: [" ", ""] })).toBe(true);
    expect(isEmptyClassificationFilter({ codes: ["Ss_25"] })).toBe(false);
    expect(isEmptyClassificationFilter({ system: "Uniclass 2015" })).toBe(false);
  });

  it("compiles to null, so the caller never reads a classification it does not need", () => {
    expect(compileClassificationFilter({})).toBeNull();
    expect(compileClassificationFilter({ system: "", codes: [] })).toBeNull();
  });
});

describe("matching a code within a system", () => {
  it("needs both halves on the same reference", () => {
    // The wall really is Ss_25_10_30, and really is in Sistema Nacional — but
    // not Ss_25_10_30 *in* Sistema Nacional, which is what was asked.
    expect(
      match({ system: "Sistema Nacional", codes: ["Ss_25_10_30"] }, TWO_SYSTEMS),
    ).toBe(false);
    expect(
      match({ system: "Uniclass 2015", codes: ["Ss_25_10_30"] }, TWO_SYSTEMS),
    ).toBe(true);
    expect(
      match({ system: "Sistema Nacional", codes: ["EF_25_10"] }, TWO_SYSTEMS),
    ).toBe(true);
  });

  it("takes a system alone as “classified in this system at all”", () => {
    expect(match({ system: "Uniclass 2015" }, TWO_SYSTEMS)).toBe(true);
    expect(match({ system: "OmniClass" }, TWO_SYSTEMS)).toBe(false);
  });

  it("takes a code alone as “this code in any system”", () => {
    expect(match({ codes: ["EF_25_10"] }, TWO_SYSTEMS)).toBe(true);
    expect(match({ codes: ["Pr_20_93"] }, TWO_SYSTEMS)).toBe(false);
  });

  it("treats several codes as alternatives", () => {
    expect(match({ codes: ["Pr_20_93", "Ss_25_10_30"] }, TWO_SYSTEMS)).toBe(true);
  });

  it("matches a system or code exactly, ignoring case and surrounding space", () => {
    expect(match({ codes: ["ss_25_10_30"] }, TWO_SYSTEMS)).toBe(true);
    expect(match({ codes: ["Ss_25_10"] }, TWO_SYSTEMS)).toBe(false);
    expect(match({ system: " uniclass 2015 " }, TWO_SYSTEMS)).toBe(true);
  });

  it("selects a whole branch with a wildcard, which is how a hierarchy is asked for", () => {
    // Codes nest by prefix: Ss_25_10_30 sits under Ss_25_10 under Ss_25.
    expect(match({ system: "Uniclass 2015", codes: ["Ss_25*"] }, TWO_SYSTEMS)).toBe(true);
    expect(match({ system: "Uniclass 2015", codes: ["Ss_30*"] }, TWO_SYSTEMS)).toBe(false);
    expect(match({ codes: ["/^Ss_25_10_\\d+$/"] }, TWO_SYSTEMS)).toBe(true);
  });

  it("does not match an unclassified element", () => {
    expect(match({ system: "Uniclass 2015" }, [])).toBe(false);
    expect(match({ codes: ["Ss_25_10_30"] }, [])).toBe(false);
  });

  it("does not match a reference whose code the engine could not read", () => {
    // "Classified, but by what is unknown" must not answer a question about a
    // specific code — in either direction.
    const unresolved: ClassificationFact[] = [{ unresolved: true }];
    expect(match({ codes: ["Ss_25_10_30"] }, unresolved)).toBe(false);
    expect(match({ system: "Uniclass 2015" }, unresolved)).toBe(false);
  });

  it("does not match a reference that carries no code when a code was asked for", () => {
    const systemOnly: ClassificationFact[] = [{ system: "Uniclass 2015" }];
    expect(match({ system: "Uniclass 2015" }, systemOnly)).toBe(true);
    expect(match({ system: "Uniclass 2015", codes: ["Ss_25_10_30"] }, systemOnly)).toBe(false);
  });

  it("reports a pattern that will not compile, naming it", () => {
    expect(() => compileClassificationFilter({ codes: ["/([/"] })).toThrow();
  });
});
