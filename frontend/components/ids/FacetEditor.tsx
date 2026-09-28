"use client";

import { useTranslations } from "next-intl";
import { Trash2 } from "lucide-react";

import {
  PART_OF_RELATIONS,
  allowedCardinalities,
  simple,
  type Cardinality,
  type Facet,
  type IdsValue,
} from "@/lib/ids/types";
import type { ModelVocabulary } from "@/lib/ifc/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import ValueEditor from "./ValueEditor";
import { merge, type BsddSuggestions } from "@/lib/bsdd/suggestions";
import { idsDataType, isUnmappedNumeric } from "@/lib/bsdd/client";

/**
 * One facet, with the fields its kind actually has.
 *
 * Cardinality is offered from {@link allowedCardinalities} rather than from a
 * fixed list: entity and partOf facets use `ids:simpleCardinality`, which has no
 * `optional`. Showing it would let an author produce a file no validator
 * accepts, and "optionally a wall" means nothing anyway.
 */
export function FacetEditor({
  facet,
  onChange,
  onRemove,
  cardinality,
  onCardinalityChange,
  instructions,
  onInstructionsChange,
  vocabulary,
  bsdd,
}: {
  facet: Facet;
  onChange: (facet: Facet) => void;
  onRemove: () => void;
  /** Present for requirements; applicability facets have no cardinality. */
  cardinality?: Cardinality;
  onCardinalityChange?: (cardinality: Cardinality) => void;
  instructions?: string;
  onInstructionsChange?: (instructions: string) => void;
  vocabulary: ModelVocabulary | null;
  /**
   * What the chosen bSDD dictionaries know, merged in behind the model's own
   * vocabulary. Absent when no dictionary is selected.
   */
  bsdd?: BsddSuggestions;
}) {
  const t = useTranslations("idsCreate.facetEditor");
  const tFacetKinds = useTranslations("idsCreate.facetKinds");
  const tFacetHints = useTranslations("idsCreate.facetHints");
  // Model first, dictionary second: a property this model demonstrably has is
  // a safer suggestion than one a dictionary says it ought to have.
  const entityNames = merge(
    vocabulary?.entityTypes.map((t) => t.type.toUpperCase()) ?? [],
    bsdd?.classes ?? [],
  );
  const predefinedTypes =
    facet.kind === "entity" && facet.name.kind === "simple"
      ? (bsdd?.predefinedTypesFor(facet.name.value) ?? [])
      : [];
  const psetNames = merge(
    vocabulary?.propertySets.map((set) => set.name) ?? [],
    bsdd?.propertySets ?? [],
  );

  /** The property set this facet names, if it names one plainly. */
  const setName =
    facet.kind === "property" && facet.propertySet.kind === "simple"
      ? facet.propertySet.value
      : "";

  /** Property names for whichever property set this facet names. */
  const propertyNames = (() => {
    if (facet.kind !== "property") return [];
    const found = vocabulary?.propertySets.find((set) => set.name === setName);
    // With no set chosen, every property in the model is still better than
    // nothing — the author is often exploring.
    const fromModel = found
      ? found.properties
      : [...new Set(vocabulary?.propertySets.flatMap((s) => s.properties) ?? [])].sort();

    return merge(fromModel, bsdd?.propertiesFor(setName) ?? []);
  })();

  /**
   * The values bSDD says this property accepts.
   *
   * This is the suggestion that a model cannot provide: an enumerated property
   * like `Status` has a fixed vocabulary — NEW, EXISTING, DEMOLISH — and typing
   * one of them from memory is how a specification ends up matching nothing.
   */
  const propertyValues =
    facet.kind === "property" && facet.baseName.kind === "simple"
      ? (bsdd?.valuesFor(setName, facet.baseName.value) ?? [])
      : [];

  /** The bSDD property this facet names, when it names one bSDD knows. */
  const detail =
    facet.kind === "property" && facet.baseName.kind === "simple"
      ? bsdd?.detailFor(setName, facet.baseName.value)
      : undefined;

  /**
   * What bSDD contributes to the two fields an author cannot guess.
   *
   * `dataType` is only offered where the mapping is sound — see
   * `idsDataType`, which deliberately refuses bSDD's `Real`. `uri` is the
   * class-scoped property URI, which is the one that identifies *this*
   * property in *this* set.
   */
  const suggestedType = idsDataType(detail?.dataType);
  const suggestedUri = detail?.uri;
  /** bSDD knows it is numeric but not which IFC measure. Say so. */
  const numericUnknown = isUnmappedNumeric(detail?.dataType);

  /**
   * Take the property name, and whatever bSDD knows to go with it.
   *
   * Filling here rather than in an effect matters: an effect that refills a
   * field whenever the dictionary data is present would undo the author every
   * time they cleared it. This runs once, on the edit that names the property,
   * and only writes fields that are still empty. When the lookup has not
   * resolved yet there is nothing to fill, and the buttons below appear
   * instead.
   */
  const onPropertyName = (baseName: IdsValue) => {
    if (facet.kind !== "property") return;
    const next = { ...facet, baseName };

    if (baseName.kind !== "simple") {
      onChange(next);
      return;
    }

    const found = bsdd?.detailFor(setName, baseName.value);
    if (!found) {
      onChange(next);
      return;
    }

    const type = idsDataType(found.dataType);
    onChange({
      ...next,
      dataType: next.dataType ?? type,
      uri: next.uri ?? found.uri,
    });
  };

  return (
    <div className="space-y-3 rounded border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Badge variant="secondary">{tFacetKinds(facet.kind)}</Badge>
          <p className="text-muted-foreground mt-1 text-[11px]">
            {tFacetHints(facet.kind)}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {cardinality && onCardinalityChange && (
            <Select
              value={cardinality}
              onValueChange={(value) => onCardinalityChange(value as Cardinality)}
            >
              <SelectTrigger className="h-7 w-32" aria-label={t("cardinalityAriaLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {allowedCardinalities(facet.kind).map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t("removeFacet", { label: tFacetKinds(facet.kind) })}
            onClick={onRemove}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {facet.kind === "entity" && (
        <>
          <ValueEditor
            label={t("ifcClass")}
            required
            value={facet.name}
            suggestions={entityNames}
            placeholder="IFCWALL"
            onChange={(name) => onChange({ ...facet, name })}
          />
          <OptionalValue
            label={t("predefinedType")}
            value={facet.predefinedType}
            suggestions={predefinedTypes}
            placeholder="SOLIDWALL"
            onChange={(predefinedType) => onChange({ ...facet, predefinedType })}
          />
        </>
      )}

      {facet.kind === "partOf" && (
        <>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">{t("relationship")}</Label>
            <Select
              value={facet.relation ?? "any"}
              onValueChange={(value) =>
                onChange({
                  ...facet,
                  relation:
                    value === "any"
                      ? undefined
                      : (value as typeof PART_OF_RELATIONS[number]),
                })
              }
            >
              <SelectTrigger className="h-8" aria-label={t("relationship")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* Omitting the attribute means any relationship, which is a
                    meaningfully different check from naming one. */}
                <SelectItem value="any">{t("anyRelationship")}</SelectItem>
                {PART_OF_RELATIONS.map((relation) => (
                  <SelectItem key={relation} value={relation}>
                    {relation}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <ValueEditor
            label={t("parentIfcClass")}
            required
            value={facet.entity.name}
            suggestions={entityNames}
            placeholder="IFCBUILDINGSTOREY"
            onChange={(name) =>
              onChange({ ...facet, entity: { ...facet.entity, name } })
            }
          />
        </>
      )}

      {facet.kind === "classification" && (
        <>
          <ValueEditor
            label={t("system")}
            required
            value={facet.system}
            suggestions={vocabulary?.classificationSystems ?? []}
            placeholder="Uniclass"
            onChange={(system) => onChange({ ...facet, system })}
          />
          <OptionalValue
            label={t("code")}
            value={facet.value}
            placeholder="EF_25_10"
            onChange={(value) => onChange({ ...facet, value })}
          />
          <UriField
            uri={facet.uri}
            onChange={(uri) => onChange({ ...facet, uri })}
          />
        </>
      )}

      {facet.kind === "attribute" && (
        <>
          <ValueEditor
            label={t("attributeName")}
            required
            value={facet.name}
            placeholder="Name"
            onChange={(name) => onChange({ ...facet, name })}
          />
          <OptionalValue
            label={t("value")}
            value={facet.value}
            onChange={(value) => onChange({ ...facet, value })}
          />
        </>
      )}

      {facet.kind === "property" && (
        <>
          <ValueEditor
            label={t("propertySet")}
            required
            value={facet.propertySet}
            suggestions={psetNames}
            placeholder="Pset_WallCommon"
            onChange={(propertySet) => onChange({ ...facet, propertySet })}
          />
          <ValueEditor
            label={t("propertyName")}
            required
            value={facet.baseName}
            suggestions={propertyNames}
            placeholder="FireRating"
            onChange={onPropertyName}
          />
          <OptionalValue
            label={t("value")}
            value={facet.value}
            suggestions={propertyValues}
            onChange={(value) => onChange({ ...facet, value })}
          />
          {propertyValues.length > 0 && (
            <p className="text-muted-foreground text-[11px]">
              {t("valuesFromBsddCount", { count: propertyValues.length })}{" "}
              {propertyValues.slice(0, 6).join(", ")}
              {propertyValues.length > 6 ? "…" : ""}
            </p>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium" htmlFor="facet-datatype">
              {t("dataType")}
            </Label>
            <Input
              id="facet-datatype"
              value={facet.dataType ?? ""}
              placeholder="IFCLABEL"
              // Uppercased on the way in: the XSD's upperCaseName type rejects
              // anything else, and correcting it silently beats a validation
              // error minutes later.
              onChange={(event) =>
                onChange({
                  ...facet,
                  dataType: event.target.value.toUpperCase() || undefined,
                })
              }
              className="h-8 font-mono text-xs"
            />

            {/* The lookup often resolves after the name was typed, so the
                offer stays available rather than being a one-shot fill. */}
            {suggestedType && facet.dataType !== suggestedType && (
              <FromBsdd
                value={suggestedType}
                verb={facet.dataType ? t("replaceWith") : t("use")}
                onApply={() => onChange({ ...facet, dataType: suggestedType })}
              />
            )}

            {numericUnknown && !facet.dataType && (
              <p className="text-muted-foreground text-[11px]">
                {t.rich("numericUnknownHint", {
                  code: (chunks) => <code className="font-mono">{chunks}</code>,
                })}
              </p>
            )}
          </div>

          <UriField
            uri={facet.uri}
            suggestion={suggestedUri}
            onChange={(uri) => onChange({ ...facet, uri })}
          />
        </>
      )}

      {facet.kind === "material" && (
        <>
          <OptionalValue
            label={t("material")}
            value={facet.value}
            suggestions={vocabulary?.materials ?? []}
            placeholder="Concrete"
            hint={t("materialHint")}
            onChange={(value) => onChange({ ...facet, value })}
          />
          <UriField
            uri={facet.uri}
            onChange={(uri) => onChange({ ...facet, uri })}
          />
        </>
      )}

      {onInstructionsChange && (
        <div className="space-y-1.5">
          <Label className="text-xs font-medium" htmlFor="facet-instructions">
            {t("instructionsLabel")}
          </Label>
          <Input
            id="facet-instructions"
            value={instructions ?? ""}
            placeholder={t("requirementInstructionsPlaceholder")}
            onChange={(event) => onInstructionsChange(event.target.value)}
            className="h-8 text-xs"
          />
        </div>
      )}
    </div>
  );
}

/**
 * A one-click offer of something bSDD knows.
 *
 * An offer rather than a silent write: bSDD describes what a class *can* carry,
 * and the author may be specifying something narrower on purpose. Showing the
 * value before applying it also means a wrong suggestion is visible rather than
 * inherited.
 */
function FromBsdd({
  value,
  verb,
  onApply,
}: {
  value: string;
  verb: string;
  onApply: () => void;
}) {
  const t = useTranslations("idsCreate.facetEditor");
  return (
    <button
      type="button"
      onClick={onApply}
      className="text-muted-foreground hover:text-foreground text-left text-[11px] underline decoration-dotted underline-offset-2"
    >
      {verb} <code className="font-mono">{value}</code> {t("fromBsddSuffix")}
    </button>
  );
}

/**
 * The facet's `uri` attribute.
 *
 * IDS lets a classification, property or material facet point at the external
 * definition it means — a bSDD URI, a Uniclass entry, a national dictionary.
 * It is what makes a specification resolvable by a tool that has never seen the
 * author's naming, so it is worth a field even though the XSD makes it
 * optional.
 *
 * Hidden behind a button until it holds something: most facets never need one,
 * and a permanently visible URI box in every facet is noise in a panel that is
 * already dense.
 */
function UriField({
  uri,
  suggestion,
  onChange,
}: {
  uri: string | undefined;
  /** bSDD's URI for this property, when it knows one. */
  suggestion?: string;
  onChange: (uri: string | undefined) => void;
}) {
  const t = useTranslations("idsCreate.facetEditor");
  if (uri === undefined) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px]"
          onClick={() => onChange("")}
        >
          {t("addUri")}
        </Button>
        {suggestion && (
          <FromBsdd value={t("uri")} verb={t("useThe")} onApply={() => onChange(suggestion)} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs font-medium" htmlFor="facet-uri">
          {t("uri")}
        </Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={() => onChange(undefined)}
        >
          {t("clear")}
        </Button>
      </div>
      <Input
        id="facet-uri"
        value={uri}
        placeholder={t("uriPlaceholder")}
        onChange={(event) => onChange(event.target.value || "")}
        className="h-8 font-mono text-xs"
      />
      {suggestion && suggestion !== uri && (
        <FromBsdd
          value={t("bsddUri")}
          verb={t("replaceWithThe")}
          onApply={() => onChange(suggestion)}
        />
      )}
    </div>
  );
}

/**
 * An optional value, which can be absent entirely.
 *
 * Absent and empty are different in IDS: no `<value>` element means "any
 * value", while an empty one means "the empty string". A single text box cannot
 * express that, so the field is added and removed explicitly.
 */
function OptionalValue({
  label,
  value,
  onChange,
  suggestions,
  placeholder,
  hint,
}: {
  label: string;
  value: IdsValue | undefined;
  onChange: (value: IdsValue | undefined) => void;
  suggestions?: string[];
  placeholder?: string;
  hint?: string;
}) {
  if (!value) {
    return (
      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px]"
          onClick={() => onChange(simple(""))}
        >
          + {label}
        </Button>
        {hint && <p className="text-muted-foreground text-[11px]">{hint}</p>}
      </div>
    );
  }

  return (
    <ValueEditor
      label={label}
      value={value}
      suggestions={suggestions}
      placeholder={placeholder}
      onChange={onChange}
      onClear={() => onChange(undefined)}
    />
  );
}

export default FacetEditor;
