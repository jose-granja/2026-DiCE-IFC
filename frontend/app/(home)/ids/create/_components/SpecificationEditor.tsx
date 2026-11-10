"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, Plus } from "lucide-react";

import FacetEditor from "@/components/ids/FacetEditor";
import { useBsddSuggestions, type BsddSuggestions } from "@/lib/bsdd/suggestions";
import { useIdsStore } from "@/lib/ids/store";
import {
  CONDITIONAL_CARDINALITIES,
  FACET_SEQUENCE,
  IFC_VERSIONS,
  applicabilityCardinality,
  type Cardinality,
  type FacetKind,
  type IdsIfcVersion,
  type Specification,
} from "@/lib/ids/types";
import type { ModelVocabulary } from "@/lib/ifc/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The detail pane: one specification, its applicability and its requirements.
 *
 * Applicability answers "which entities does this apply to"; requirements
 * answer "and what must they satisfy". They take the same six facets, which is
 * a genuine source of confusion, so each block says what it means rather than
 * relying on the heading.
 */
export function SpecificationEditor({
  specification,
  vocabulary,
}: {
  specification: Specification;
  vocabulary: ModelVocabulary | null;
}) {
  const t = useTranslations("idsCreate.specEditor");
  const tFacetKinds = useTranslations("idsCreate.facetKinds");
  const CARDINALITY_LABELS: Record<Cardinality, string> = {
    required: t("cardinality.required"),
    optional: t("cardinality.optional"),
    prohibited: t("cardinality.prohibited"),
  };
  /* bSDD searches are shared by every facet in this specification. Property
     and predefined-type details stay lazy until their fields actually exist. */
  const bsddContext = useMemo(() => {
    const facets = [
      ...specification.applicability.facets.map((entry) => entry.facet),
      ...specification.requirements.map((entry) => entry.facet),
    ];
    const entities = facets.flatMap((facet) => {
      if (facet.kind === "entity") return [facet];
      if (facet.kind === "partOf") return [facet.entity];
      return [];
    });
    const simpleName = (entity: (typeof entities)[number]) =>
      entity.name.kind === "simple" ? entity.name.value : "";

    return {
      classNames: entities.map(simpleName).filter(Boolean),
      predefinedTypeClasses: entities
        .filter((entity) => entity.predefinedType !== undefined)
        .map(simpleName)
        .filter(Boolean),
      loadProperties: facets.some((facet) => facet.kind === "property"),
    };
  }, [specification.applicability.facets, specification.requirements]);
  const bsdd = useBsddSuggestions(bsddContext.classNames, bsddContext);
  const update = useIdsStore((s) => s.updateSpecification);
  const addFacet = useIdsStore((s) => s.addFacet);
  const updateFacet = useIdsStore((s) => s.updateFacet);
  const removeFacet = useIdsStore((s) => s.removeFacet);
  const setCardinality = useIdsStore((s) => s.setCardinality);
  const setInstructions = useIdsStore((s) => s.setInstructions);
  const setRequirementType = useIdsStore((s) => s.setRequirementType);

  const id = specification.id;
  // The specification's own cardinality, and the starting point for newly
  // added requirements. Each requirement keeps its own cardinality afterwards.
  const requirementType =
    applicabilityCardinality(specification.applicability) ??
    specification.defaultRequirementCardinality ??
    "required";

  return (
    <div className="space-y-5 p-4">
      <section className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="spec-name" className="text-xs font-medium">
            {t("nameLabel")}
          </Label>
          <Input
            id="spec-name"
            value={specification.name}
            onChange={(event) => update(id, { name: event.target.value })}
            className="h-8"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="spec-identifier" className="text-xs font-medium">
              {t("identifierLabel")}
            </Label>
            <Input
              id="spec-identifier"
              value={specification.identifier ?? ""}
              onChange={(event) =>
                update(id, { identifier: event.target.value || undefined })
              }
              className="h-8 font-mono text-xs"
            />
          </div>

          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium">{t("ifcSchemas")}</legend>
            <div className="flex flex-wrap gap-3 pt-1">
              {IFC_VERSIONS.map((version) => (
                <div key={version} className="flex items-center gap-1.5">
                  <Checkbox
                    id={`ifc-${version}`}
                    checked={specification.ifcVersions.includes(version)}
                    onCheckedChange={(checked) =>
                      update(id, {
                        ifcVersions: toggleVersion(
                          specification.ifcVersions,
                          version,
                          checked === true,
                        ),
                      })
                    }
                  />
                  <Label
                    htmlFor={`ifc-${version}`}
                    className="cursor-pointer font-mono text-[11px] font-normal"
                  >
                    {version}
                  </Label>
                </div>
              ))}
            </div>
          </fieldset>
                      <div className="space-y-1.5">
                      <Label htmlFor="spec-requirement-type" className="text-xs font-medium">
                        {t("requirementTypeLabel")}
                      </Label>
                      <Select
                        value={requirementType}
                        onValueChange={(value) => setRequirementType(id, value as Cardinality)}
                      >
                        <SelectTrigger id="spec-requirement-type" className="h-8 w-full text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CONDITIONAL_CARDINALITIES.map((cardinality) => (
                            <SelectItem key={cardinality} value={cardinality}>
                              {CARDINALITY_LABELS[cardinality]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
        </div>

      <div className="flex flex-row items-center gap-2 w-full">
        <div className="space-y-1.5 w-full">
          <Label htmlFor="spec-description" className="text-xs font-medium">
            {t("descriptionLabel")}
          </Label>
          <Textarea
            id="spec-description"
            value={specification.description ?? ""}
            onChange={(event) =>
              update(id, { description: event.target.value || undefined })
            }
            className="min-h-14 text-xs"
          />
        </div>

        <div className="space-y-1.5 w-full">
          <Label htmlFor="spec-instructions" className="text-xs font-medium">
            {t("instructionsLabel")}
          </Label>
          <Textarea
            id="spec-instructions"
            value={specification.instructions ?? ""}
            onChange={(event) =>
              update(id, { instructions: event.target.value || undefined })
            }
            className="min-h-14 text-xs"
          />
        </div>
        </div>

        
      </section>

      <FacetBlock
        title={t("filters")}
        hint={t("appliesToHint")}
        facetLabels={tFacetKinds}
        addFacetLabel={t("addFacet")}
        noFacetsLabel={t("noFacets")}
        facets={specification.applicability.facets}
        onAdd={(kind) => addFacet(id, "applicability", kind)}
        onChange={(facetId, facet) => updateFacet(id, "applicability", facetId, facet)}
        onRemove={(facetId) => removeFacet(id, "applicability", facetId)}
        vocabulary={vocabulary}
        bsdd={bsdd}
      />

      <FacetBlock
        title={t("mustSatisfy")}
        hint={t("mustSatisfyHint")}
        facetLabels={tFacetKinds}
        addFacetLabel={t("addFacet")}
        noFacetsLabel={t("noFacets")}
        facets={specification.requirements.map((requirement) => ({
          id: requirement.id,
          facet: requirement.facet,
          cardinality: requirement.cardinality,
          instructions: requirement.instructions,
        }))}
        onAdd={(kind) => addFacet(id, "requirements", kind)}
        onChange={(facetId, facet) => updateFacet(id, "requirements", facetId, facet)}
        onRemove={(facetId) => removeFacet(id, "requirements", facetId)}
        onCardinalityChange={(facetId, cardinality) =>
          setCardinality(id, facetId, cardinality)
        }
        onInstructionsChange={(facetId, instructions) =>
          setInstructions(id, facetId, instructions)
        }
        vocabulary={vocabulary}
        bsdd={bsdd}
      />
    </div>
  );
}

type BlockFacet = {
  id: string;
  facet: Parameters<typeof FacetEditor>[0]["facet"];
  cardinality?: Parameters<typeof FacetEditor>[0]["cardinality"];
  instructions?: string;
};

function FacetBlock({
  title,
  hint,
  facetLabels,
  addFacetLabel,
  noFacetsLabel,
  facets,
  onAdd,
  onChange,
  onRemove,
  onCardinalityChange,
  onInstructionsChange,
  vocabulary,
  bsdd,
}: {
  title: string;
  hint: string;
  facetLabels: (kind: FacetKind) => string;
  addFacetLabel: string;
  noFacetsLabel: string;
  facets: BlockFacet[];
  onAdd: (kind: FacetKind) => void;
  onChange: (facetId: string, facet: BlockFacet["facet"]) => void;
  onRemove: (facetId: string) => void;
  onCardinalityChange?: (
    facetId: string,
    cardinality: NonNullable<BlockFacet["cardinality"]>,
  ) => void;
  onInstructionsChange?: (facetId: string, instructions: string) => void;
  vocabulary: ModelVocabulary | null;
  bsdd?: BsddSuggestions;
}) {
  const t = useTranslations("idsCreate.specEditor");
  const [open, setOpen] = useState(true);
  // IDs keep an item's disclosure state attached to it when neighbours are
  // removed. New facets are expanded even after "Collapse all".
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section className="space-y-2" data-facet-block>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex flex-row items-center gap-2">
            <h3>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" className="h-7 max-w-full gap-1.5 px-1 text-sm font-medium" aria-label={title}>
                  <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden />
                  <span className="truncate">{title}</span>
                  <Badge variant="secondary" className="tabular-nums" aria-label={t("facetCount", { count: facets.length })}>{facets.length}</Badge>
                </Button>
              </CollapsibleTrigger>
            </h3>
          <p className="text-muted-foreground text-[11px]">{hint}</p>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="sm" className="h-7 shrink-0">
                <Plus className="h-3.5 w-3.5" />
                {addFacetLabel}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {FACET_SEQUENCE.map((kind) => (
                <DropdownMenuItem key={kind} onSelect={() => { setOpen(true); onAdd(kind); }}>
                  {facetLabels(kind)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <CollapsibleContent forceMount className="space-y-2 data-[state=closed]:hidden">
          {facets.length > 1 && (
            <div className="flex flex-wrap justify-end gap-1">
              <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]"
                disabled={facets.every((entry) => !collapsed.has(entry.id))}
                onClick={() => setCollapsed(new Set())}>
                {t("expandAll")}
              </Button>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]"
                disabled={facets.every((entry) => collapsed.has(entry.id))}
                onClick={() => setCollapsed(new Set(facets.map((entry) => entry.id)))}>
                {t("collapseAll")}
              </Button>
            </div>
          )}
          {facets.length === 0 ? (
            <p className="text-muted-foreground rounded border border-dashed p-3 text-center text-xs">
              {noFacetsLabel}
            </p>
          ) : (
            <div className="space-y-2">
              {facets.map((entry) => (
                <FacetEditor
                  key={entry.id}
                  open={!collapsed.has(entry.id)}
                  onOpenChange={(expanded) => setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (expanded) next.delete(entry.id);
                    else next.add(entry.id);
                    return next;
                  })}
                  facet={entry.facet}
                  cardinality={entry.cardinality}
                  instructions={entry.instructions}
                  vocabulary={vocabulary}
                  bsdd={bsdd}
                  onChange={(facet) => onChange(entry.id, facet)}
                  onRemove={() => onRemove(entry.id)}
                  onCardinalityChange={
                    onCardinalityChange
                      ? (cardinality) => onCardinalityChange(entry.id, cardinality)
                      : undefined
                  }
                  onInstructionsChange={
                    onInstructionsChange
                      ? (instructions) => onInstructionsChange(entry.id, instructions)
                      : undefined
                  }
                />
              ))}
            </div>
          )}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

/** Toggle a schema, keeping the canonical order rather than click order. */
function toggleVersion(
  current: IdsIfcVersion[],
  version: IdsIfcVersion,
  checked: boolean,
): IdsIfcVersion[] {
  const next = new Set(current);
  if (checked) next.add(version);
  else next.delete(version);
  return IFC_VERSIONS.filter((v) => next.has(v));
}

export default SpecificationEditor;
