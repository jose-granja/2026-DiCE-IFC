import { describe, expect, it } from "vitest";

import {
  adaptPatternsForEngine,
  expandExactRepeats,
  hasQuantifiedGroup,
  patternForEngine,
} from "../ids-patterns";

/** Whole-value match, as IDS patterns are evaluated. */
const matches = (pattern: string, value: string) => new RegExp(`^(?:${pattern})$`, "u").test(value);

describe("expandExactRepeats", () => {
  it("writes an exact repeat of one atom out in full", () => {
    expect(expandExactRepeats(String.raw`(Ss|Pr)_\d{2}(_\d{2}){1,3}`)).toBe(String.raw`(Ss|Pr)_\d\d(_\d\d){1,3}`);
    expect(expandExactRepeats("[A-Z]{3}")).toBe("[A-Z][A-Z][A-Z]");
    expect(expandExactRepeats("x{2,2}")).toBe("xx");
    expect(expandExactRepeats(String.raw`\p{Lu}{2}`)).toBe(String.raw`\p{Lu}\p{Lu}`);
    expect(expandExactRepeats("[a-z-[aeiou]]{2}")).toBe("[a-z-[aeiou]][a-z-[aeiou]]");
  });

  it("keeps ranges, open repeats and repeats of a group", () => {
    for (const pattern of [String.raw`\d{1,2}`, String.raw`\d{2,}`, "(ab){2}", String.raw`C\d{2,3}/\d{2,3}`]) {
      expect(expandExactRepeats(pattern)).toBe(pattern);
    }
  });

  it("does not take escaped braces or braces in a class for a repeat", () => {
    expect(expandExactRepeats(String.raw`\{2}`)).toBe(String.raw`\{2}`);
    expect(expandExactRepeats("[{]{2}")).toBe("[{][{]");
  });

  it("matches exactly the values the original matched", () => {
    const original = String.raw`(Ss|Pr)_\d{2}(_\d{2}){1,3}`;
    const expanded = expandExactRepeats(original);
    for (const value of ["Ss_20_05", "Ss_20_05_15_70", "Pr_20_85_13_32", "Ss_20", "Ss_2_05", "Ef_20_05", "Ss_20_05_15_70_10"]) {
      expect(matches(expanded, value), value).toBe(matches(original, value));
    }
  });
});

describe("patternForEngine", () => {
  it("leaves a pattern with no quantified group as written", () => {
    // What the engine quotes back in a failure stays the author's own text.
    expect(patternForEngine(String.raw`C\d{2,3}/\d{2,3}`)).toBe(String.raw`C\d{2,3}/\d{2,3}`);
    expect(patternForEngine(String.raw`X0|XC[1-4]`)).toBe(String.raw`X0|XC[1-4]`);
  });

  it("rewrites one the regex guard would refuse for an exact repeat", () => {
    expect(patternForEngine(String.raw`(_\d{2}){1,3}`)).toBe(String.raw`(_\d\d){1,3}`);
  });

  it("leaves a genuinely ambiguous pattern for the guard to refuse", () => {
    expect(patternForEngine(String.raw`(\d{1,2})+`)).toBe(String.raw`(\d{1,2})+`);
    expect(patternForEngine("(a+)+")).toBe("(a+)+");
  });
});

describe("hasQuantifiedGroup", () => {
  it("sees a group followed by a quantifier, not a parenthesis inside a class", () => {
    expect(hasQuantifiedGroup("(ab)+")).toBe(true);
    expect(hasQuantifiedGroup("(ab){2}")).toBe(true);
    expect(hasQuantifiedGroup("(ab)?")).toBe(false);
    expect(hasQuantifiedGroup("[)]+")).toBe(false);
    expect(hasQuantifiedGroup(String.raw`\)+`)).toBe(false);
  });
});

describe("adaptPatternsForEngine", () => {
  it("rewrites every pattern constraint in a parsed document, at any depth", () => {
    const document = {
      specifications: [
        {
          requirements: [
            { type: "classification", value: { type: "pattern", pattern: String.raw`(_\d{2}){1,3}` } },
            {
              type: "property",
              value: {
                type: "pattern",
                pattern: "x",
                and: [{ type: "pattern", pattern: String.raw`([A-Z]{2})+` }],
              },
            },
            { type: "attribute", value: { type: "simpleValue", value: String.raw`(_\d{2}){1,3}` } },
          ],
        },
      ],
    };

    adaptPatternsForEngine(document);
    const [classification, property, attribute] = document.specifications[0].requirements;
    expect(classification.value).toEqual({ type: "pattern", pattern: String.raw`(_\d\d){1,3}` });
    expect((property.value as { and: Array<{ pattern: string }> }).and[0].pattern).toBe("([A-Z][A-Z])+");
    // A simple value is literal text, not a pattern: never touched.
    expect(attribute.value).toEqual({ type: "simpleValue", value: String.raw`(_\d{2}){1,3}` });
  });
});
