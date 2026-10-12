/**
 * Picking elements by what they are, what they are called and what they are
 * made of — the part of a clash group (or any future selection) that does not
 * depend on the engine. The adapter extracts the facts; this decides.
 */

import type { ElementFilter, PropertySetView } from "./types";
import { findSetValue, matchesPropertyCondition } from "./quantity-query";
import {
  compileClassificationFilter,
  matchesClassification,
  isEmptyClassificationFilter,
  type ClassificationFact,
  type CompiledClassificationFilter,
} from "./classification-filter";
import {
  compileTextMatcher,
  compileTextMatchers,
  matchesAnyText,
  type TextMatcher,
} from "./text-match";

export type CompiledElementFilter = {
  filter: ElementFilter;
  classes: TextMatcher[];
  names: TextMatcher[];
  predefinedTypes: TextMatcher[];
  objectTypes: TextMatcher[];
  materials: TextMatcher[];
  materialCategories: TextMatcher[];
  /** Null when the filter names no classification, so none is ever read. */
  classification: CompiledClassificationFilter | null;
};

/** A filter with nothing in it matches nothing, rather than everything. */
export function isEmptyElementFilter(filter: ElementFilter): boolean {
  const filled = (values: string[]) => values.some((value) => value.trim() !== "");
  return !(
    filled(filter.classes) ||
    filled(filter.names) ||
    filled(filter.predefinedTypes) ||
    filled(filter.objectTypes) ||
    filled(filter.materials) ||
    filled(filter.materialCategories) ||
    !isEmptyClassificationFilter({
      system: filter.classificationSystem,
      codes: filter.classificationCodes,
    }) ||
    filter.properties.length > 0
  );
}

/** Compile every pattern up front; a bad `/regex/` throws here, naming itself. */
export function compileElementFilter(filter: ElementFilter): CompiledElementFilter {
  for (const condition of filter.properties) {
    compileTextMatcher(condition.setName);
    compileTextMatcher(condition.propertyName);
    if (/^\/.+\/[a-z]*$/.test(condition.value.trim())) compileTextMatcher(condition.value);
  }
  return {
    filter,
    classes: compileTextMatchers(filter.classes),
    names: compileTextMatchers(filter.names),
    predefinedTypes: compileTextMatchers(filter.predefinedTypes),
    objectTypes: compileTextMatchers(filter.objectTypes),
    materials: compileTextMatchers(filter.materials),
    materialCategories: compileTextMatchers(filter.materialCategories),
    classification: compileClassificationFilter({
      system: filter.classificationSystem,
      codes: filter.classificationCodes,
    }),
  };
}

export function matchesClass(compiled: CompiledElementFilter, type: string): boolean {
  return compiled.classes.length === 0 || matchesAnyText(compiled.classes, type);
}

export type ElementFacts = {
  type: string;
  name: string;
  predefinedType: string;
  objectType: string;
  materials: Array<{ name?: string; category?: string }>;
  /**
   * Read only when a property condition needs it: property sets are the
   * expensive part of an element, and most filters never ask.
   */
  properties: () => PropertySetView[];
  /** Read only when the filter names a classification, for the same reason. */
  classifications: () => ClassificationFact[];
};

export function matchesElementFilter(
  compiled: CompiledElementFilter,
  facts: ElementFacts,
): boolean {
  if (!matchesClass(compiled, facts.type)) return false;
  if (compiled.names.length > 0 && !matchesAnyText(compiled.names, facts.name)) return false;
  if (
    compiled.predefinedTypes.length > 0 &&
    !matchesAnyText(compiled.predefinedTypes, facts.predefinedType)
  ) {
    return false;
  }
  if (
    compiled.objectTypes.length > 0 &&
    !matchesAnyText(compiled.objectTypes, facts.objectType)
  ) {
    return false;
  }
  if (
    compiled.materials.length > 0 &&
    !facts.materials.some((material) => material.name && matchesAnyText(compiled.materials, material.name))
  ) {
    return false;
  }
  if (
    compiled.materialCategories.length > 0 &&
    !facts.materials.some(
      (material) => material.category && matchesAnyText(compiled.materialCategories, material.category),
    )
  ) {
    return false;
  }

  // Before the property conditions and after the attribute ones: reading a
  // classification walks a reference chain, which is dearer than an attribute
  // and cheaper than every property set on the element.
  if (
    compiled.classification &&
    !matchesClassification(compiled.classification, facts.classifications())
  ) {
    return false;
  }

  const conditions = compiled.filter.properties;
  if (conditions.length > 0) {
    const sets = facts.properties();
    const results = conditions.map((condition) =>
      matchesPropertyCondition(
        findSetValue(sets, condition.setName, condition.propertyName),
        condition.operator,
        condition.value,
      ),
    );
    const ok =
      compiled.filter.propertyCombination === "any" ? results.some(Boolean) : results.every(Boolean);
    if (!ok) return false;
  }
  return true;
}
