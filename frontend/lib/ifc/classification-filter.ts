/**
 * Selecting elements by their classification — a system, a code, or both.
 *
 * A classified model is how a quantity surveyor actually works: "every
 * Ss_25_10_30 in Uniclass", not "every IfcWall whose ObjectType contains
 * something". The IFC class says what an element *is*; the classification says
 * what the project calls it, and that is what a bill of quantities is indexed by.
 *
 * ## The one rule that is easy to get wrong
 *
 * An element can carry several classification references, from several systems
 * at once (Uniclass **and** OmniClass **and** a national one — see the engine's
 * `extractClassificationSystemsOnDemand`). So system and code must match **the
 * same reference**. Testing them independently would select an element that is
 * `Ss_25_10_30` in OmniClass and merely *present* in Uniclass, which is not what
 * "Uniclass Ss_25_10_30" means and would quietly inflate a quantity.
 *
 * Codes are hierarchical (`Ss_25_10_30` sits under `Ss_25_10`), and no special
 * prefix handling is needed for that: every value here goes through
 * `text-match.ts`, so `Ss_25*` is a glob and `/^Ss_25/` is a regular expression.
 *
 * Pure, and engine-free: the adapter extracts the references, this decides.
 */

import {
  compileTextMatcher,
  compileTextMatchers,
  matchesAnyText,
  type TextMatcher,
} from "./text-match";

/** One classification reference on an element, as the engine reports it. */
export type ClassificationFact = {
  /** `IfcClassification.Name`, e.g. "Uniclass 2015". */
  system?: string;
  /** `IfcClassificationReference.Identification`, e.g. "Ss_25_10_30". */
  identification?: string;
  /**
   * The engine proved the element is classified but could not read by what.
   * Only happens for a store parsed without its source bytes, which this
   * application never produces — but "classified, unknown how" must not be
   * reported as a match for a specific code.
   */
  unresolved?: boolean;
};

export type ClassificationFilter = {
  /** One system, not a list: it is the context the codes are read in, not an alternative. */
  system?: string;
  /** Codes within that system. Any of them matches — they are alternatives. */
  codes?: string[];
};

export type CompiledClassificationFilter = {
  system: TextMatcher | null;
  codes: TextMatcher[];
};

const filled = (value: string | undefined) => Boolean(value && value.trim() !== "");

export function isEmptyClassificationFilter(filter: ClassificationFilter): boolean {
  return !filled(filter.system) && !(filter.codes ?? []).some(filled);
}

/**
 * Compile the patterns, or return `null` when the filter asks for nothing.
 *
 * `null` is the signal to the caller that it need not read classifications at
 * all: that read walks a reference chain per element, and most queries never
 * mention a classification.
 */
export function compileClassificationFilter(
  filter: ClassificationFilter,
): CompiledClassificationFilter | null {
  if (isEmptyClassificationFilter(filter)) return null;
  return {
    system: filled(filter.system) ? compileTextMatcher(filter.system!) : null,
    codes: compileTextMatchers((filter.codes ?? []).filter(filled)),
  };
}

/** Does any one reference satisfy both halves of the filter? */
export function matchesClassification(
  compiled: CompiledClassificationFilter,
  classifications: readonly ClassificationFact[],
): boolean {
  return classifications.some((entry) => {
    if (entry.unresolved) return false;
    if (compiled.system && !compiled.system.test(entry.system ?? "")) return false;
    if (
      compiled.codes.length > 0 &&
      !matchesAnyText(compiled.codes, entry.identification ?? "")
    ) {
      return false;
    }
    return true;
  });
}
