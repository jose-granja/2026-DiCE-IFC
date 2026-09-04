"use client";

import { applicabilityCardinality, type Specification } from "@/lib/ids/types";
import { useSpecificationLanguage } from "@/lib/ids/use-natural-language";

/** A live, local-language reading of the selected IDS rule. */
export default function SpecificationSummary({ specification }: { specification: Specification }) {
  const { t, list, describeFacet } = useSpecificationLanguage();
  const occurrence = specification.applicability;
  const applicabilityType = applicabilityCardinality(occurrence);
  const hasOccurrence = occurrence.minOccurs !== undefined || occurrence.maxOccurs !== undefined;

  return (
    <div className="space-y-4 p-3 text-sm leading-relaxed">
      <div>
        <h3 className="font-semibold">{specification.name || t("unnamed")}</h3>
        {specification.description && (
          <p className="text-muted-foreground mt-1">{specification.description}</p>
        )}
        <p className="mt-2">{t("schemas", { versions: list.format(specification.ifcVersions) || t("notSet") })}</p>
      </div>

      <section className="space-y-2">
        <h4 className="font-medium">{t("appliesTo")}</h4>
        {occurrence.facets.length ? (
          <>
            <p>{t("allConditions")}</p>
            <ul className="list-disc space-y-1 pl-5">
              {occurrence.facets.map(({ id, facet }) => (
                <li key={id}>{describeFacet(facet)}</li>
              ))}
            </ul>
          </>
        ) : (
          <p>{t("allEntities")}</p>
        )}
        {applicabilityType ? (
          <p className="text-muted-foreground text-xs">
            {t(`applicability.${applicabilityType}`)}
          </p>
        ) : hasOccurrence && (
          <p className="text-muted-foreground text-xs">
            {t("occurrence", {
              min: occurrence.minOccurs ?? 0,
              max: occurrence.maxOccurs === "unbounded"
                ? t("unbounded")
                : String(occurrence.maxOccurs ?? t("unbounded")),
            })}
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h4 className="font-medium">{t("mustSatisfy")}</h4>
        {applicabilityType === "prohibited" ? (
          <p className="text-muted-foreground">{t("requirementsIgnored")}</p>
        ) : specification.requirements.length ? (
          <ul className="list-disc space-y-2 pl-5">
            {specification.requirements.map((requirement) => (
              <li key={requirement.id}>
                {t(`cardinality.${requirement.cardinality}`, {
                  condition: describeFacet(requirement.facet),
                })}
                {requirement.instructions && (
                  <p className="text-muted-foreground text-xs">{requirement.instructions}</p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">{t("noRequirements")}</p>
        )}
      </section>

      {specification.instructions && (
        <p className="text-muted-foreground border-t pt-3 text-xs">
          {t("instructions", { text: specification.instructions })}
        </p>
      )}
    </div>
  );
}
