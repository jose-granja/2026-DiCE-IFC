"use client";

import { useLocale, useTranslations } from "next-intl";

import type { Facet, IdsValue } from "./types";

/** Shared wording for the preview and the downloadable PDF report. */
export function useSpecificationLanguage() {
  const t = useTranslations("idsCreate.naturalLanguage");
  const locale = useLocale();
  const list = new Intl.ListFormat(locale, { style: "long", type: "conjunction" });
  const quoted = (value: string) => `“${value}”`;

  const describeValue = (value: IdsValue): string => {
    if (value.kind === "simple") {
      return value.value.trim() ? quoted(value.value) : t("notSet");
    }

    const constraints: string[] = [];
    if (value.enumeration?.length) {
      constraints.push(t("oneOf", { values: list.format(value.enumeration.map(quoted)) }));
    }
    if (value.pattern) constraints.push(t("pattern", { value: quoted(value.pattern) }));
    if (value.bounds?.minInclusive !== undefined)
      constraints.push(t("atLeast", { value: value.bounds.minInclusive }));
    if (value.bounds?.minExclusive !== undefined)
      constraints.push(t("greaterThan", { value: value.bounds.minExclusive }));
    if (value.bounds?.maxInclusive !== undefined)
      constraints.push(t("atMost", { value: value.bounds.maxInclusive }));
    if (value.bounds?.maxExclusive !== undefined)
      constraints.push(t("lessThan", { value: value.bounds.maxExclusive }));
    if (value.length?.length !== undefined)
      constraints.push(t("exactLength", { value: value.length.length }));
    if (value.length?.minLength !== undefined)
      constraints.push(t("minLength", { value: value.length.minLength }));
    if (value.length?.maxLength !== undefined)
      constraints.push(t("maxLength", { value: value.length.maxLength }));

    return constraints.length
      ? t("restrictedValue", { type: value.base, constraints: list.format(constraints) })
      : t("anyValueOfType", { type: value.base });
  };

  const describeFacet = (facet: Facet): string => {
    switch (facet.kind) {
      case "entity":
        return facet.predefinedType
          ? t("entityWithType", {
              name: describeValue(facet.name),
              type: describeValue(facet.predefinedType),
            })
          : t("entity", { name: describeValue(facet.name) });
      case "partOf": {
        const parent = describeValue(facet.entity.name);
        const parentType = facet.entity.predefinedType
          ? t("parentWithType", { name: parent, type: describeValue(facet.entity.predefinedType) })
          : parent;
        return facet.relation
          ? t("partOfWithRelation", { parent: parentType, relation: facet.relation })
          : t("partOf", { parent: parentType });
      }
      case "classification":
        return facet.value
          ? t("classificationWithCode", {
              system: describeValue(facet.system),
              code: describeValue(facet.value),
            })
          : t("classification", { system: describeValue(facet.system) });
      case "attribute":
        return facet.value
          ? t("attributeWithValue", {
              name: describeValue(facet.name),
              value: describeValue(facet.value),
            })
          : t("attribute", { name: describeValue(facet.name) });
      case "property": {
        const property = t("property", {
          set: describeValue(facet.propertySet),
          name: describeValue(facet.baseName),
        });
        const details = [
          facet.value && t("propertyValue", { value: describeValue(facet.value) }),
          facet.dataType && t("propertyDataType", { type: facet.dataType }),
        ].filter((detail): detail is string => Boolean(detail));
        return details.length ? t("propertyWithDetails", { property, details: list.format(details) }) : property;
      }
      case "material":
        return facet.value
          ? t("materialWithValue", { value: describeValue(facet.value) })
          : t("material");
    }
  };

  return { t, list, describeFacet };
}

