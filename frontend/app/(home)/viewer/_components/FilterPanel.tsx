"use client";

/**
 * Filter the federation by any of five dimensions at once.
 *
 * Replaces the class-only filter. The dimensions answer different questions —
 * where a thing is, what kind it is, which of that kind, what it is made of,
 * what it belongs to — and a coordinator usually has a question that spans two
 * of them ("the concrete walls on level 1", "everything in the fire
 * compartment that is not a slab").
 *
 * Union within a dimension, intersection across them; see `lib/viewer/facets.ts`,
 * where that rule is unit-tested. This component is the UI over it: the ticks
 * live in `facet-selection-store.ts`, and `FacetFilterSync` applies them, so a
 * filter stays on when this panel closes.
 */

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronRight, Eye, EyeOff, Filter, Loader2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFacetSelectionStore } from "@/lib/viewer/facet-selection-store";
import { useModelFacets } from "@/lib/viewer/use-model-facets";
import { useViewerStore, type EntityRef } from "@/lib/viewer/store";
import {
  FACET_DIMENSIONS,
  emptySelection,
  selectionIsEmpty,
  type FacetDimension,
} from "@/lib/viewer/facets";
import { cn } from "@/lib/utils";

/** Long lists get a search box; short ones do not need one. */
const SEARCHABLE_AT = 8;

export function FilterPanel() {
  const t = useTranslations("viewer.filterPanel");
  const models = useViewerStore((s) => s.models);
  const hidden = useViewerStore((s) => s.hidden);
  const hide = useViewerStore((s) => s.hide);
  const show = useViewerStore((s) => s.show);

  // `FACET_LABELS` in `lib/viewer/facets.ts` stays English: it is a plain,
  // non-component module (other consumers use it for IDS logic, not just
  // display), so it cannot call `useTranslations`. This is the display-only,
  // translated equivalent — one per dimension, shown wherever `FACET_LABELS`
  // used to be.
  const FACET_LABELS: Record<FacetDimension, string> = {
    hierarchy: t("dimensions.hierarchy"),
    classes: t("dimensions.classes"),
    types: t("dimensions.types"),
    materials: t("dimensions.materials"),
    groups: t("dimensions.groups"),
  };

  const ready = useMemo(
    () => models.filter((model) => model.load.status === "ready"),
    [models],
  );

  const selection = useFacetSelectionStore((s) => s.selection);
  const setSelection = useFacetSelectionStore((s) => s.setSelection);
  const [open, setOpen] = useState<Set<FacetDimension>>(
    () => new Set<FacetDimension>(["classes"]),
  );
  const [search, setSearch] = useState<Partial<Record<FacetDimension, string>>>({});

  const { facets, loading } = useModelFacets();

  /**
   * Every value offered, per dimension, with how many elements carry it.
   *
   * Merged across models: a federation is filtered as one thing, and a
   * material that appears in two models should be one tickbox, not two.
   */
  const { options, refsByDimension } = (() => {
    const merged: Record<FacetDimension, Map<string, number>> = {
      hierarchy: new Map(),
      classes: new Map(),
      types: new Map(),
      materials: new Map(),
      groups: new Map(),
    };
    const refs: Record<FacetDimension, Map<string, EntityRef[]>> = {
      hierarchy: new Map(),
      classes: new Map(),
      types: new Map(),
      materials: new Map(),
      groups: new Map(),
    };

    for (const model of facets) {
      const sources = {
        hierarchy: model.hierarchy,
        classes: model.facets.classes,
        types: model.facets.types,
        materials: model.facets.materials,
        groups: model.facets.groups,
      };
      for (const dimension of FACET_DIMENSIONS) {
        for (const entry of sources[dimension]) {
          merged[dimension].set(
            entry.value,
            (merged[dimension].get(entry.value) ?? 0) + entry.expressIds.length,
          );
          // Visibility actions need the actual members, not only the count
          // shown in the badge. Keep model ids here because the same value can
          // occur in several files in a federation.
          const current = refs[dimension].get(entry.value) ?? [];
          current.push(
            ...entry.expressIds.map((expressId) => ({
              modelId: model.modelId,
              expressId,
            })),
          );
          refs[dimension].set(entry.value, current);
        }
      }
    }

    return { options: merged, refsByDimension: refs };
  })();

  const toggle = (dimension: FacetDimension, value: string) => {
    setSelection((current) => {
      const next = { ...current, [dimension]: new Set(current[dimension]) };
      if (next[dimension].has(value)) next[dimension].delete(value);
      else next[dimension].add(value);
      return next;
    });
  };

  const chosen = FACET_DIMENSIONS.reduce(
    (total, dimension) => total + selection[dimension].size,
    0,
  );

  if (ready.length === 0) {
    return (
      <p className="text-muted-foreground p-3 text-xs">
        {t("loadModel")}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-filter-panel>
      <div className="flex items-center justify-between gap-2 border-b p-2">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          <Filter className="h-3.5 w-3.5" aria-hidden />
          {t("filters")}
          {loading && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
        </span>
        {chosen > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() => setSelection(emptySelection())}
          >
            <X className="h-3 w-3" />
            {t("clearCount", { count: chosen })}
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {FACET_DIMENSIONS.map((dimension) => {
          const values = [...options[dimension].entries()].sort(
            (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
          );
          const term = (search[dimension] ?? "").toLowerCase();
          const shown = term
            ? values.filter(([value]) => value.toLowerCase().includes(term))
            : values;
          const picked = selection[dimension].size;
          const isOpen = open.has(dimension);

          return (
            <section key={dimension} className="border-b" data-facet={dimension}>
              <button
                type="button"
                className="hover:bg-accent/50 flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs font-medium"
                aria-expanded={isOpen}
                onClick={() =>
                  setOpen((current) => {
                    const next = new Set(current);
                    if (next.has(dimension)) next.delete(dimension);
                    else next.add(dimension);
                    return next;
                  })
                }
              >
                <ChevronRight
                  className={cn("h-3.5 w-3.5 transition-transform", isOpen && "rotate-90")}
                  aria-hidden
                />
                {FACET_LABELS[dimension]}
                <span className="text-muted-foreground ml-auto text-[11px] font-normal">
                  {picked > 0 ? t("pickedOfTotal", { picked, total: values.length }) : values.length}
                </span>
              </button>

              {isOpen && (
                <div className="space-y-1 px-2 pb-2">
                  {values.length === 0 ? (
                    <p className="text-muted-foreground text-[11px]">
                      {loading
                        ? t("readingModel")
                        : t("recordsNone", { dimension: FACET_LABELS[dimension].toLowerCase() })}
                    </p>
                  ) : (
                    <>
                      {values.length >= SEARCHABLE_AT && (
                        <Input
                          value={search[dimension] ?? ""}
                          onChange={(event) =>
                            setSearch((current) => ({
                              ...current,
                              [dimension]: event.target.value,
                            }))
                          }
                          placeholder={t("searchDimension", {
                            dimension: FACET_LABELS[dimension].toLowerCase(),
                          })}
                          aria-label={t("searchDimension", {
                            dimension: FACET_LABELS[dimension].toLowerCase(),
                          })}
                          className="h-7 text-xs"
                        />
                      )}

                      <ul className="max-h-56 space-y-0.5 overflow-auto">
                        {shown.map(([value, count]) => {
                          const id = `facet-${dimension}-${value}`;
                          const refs = refsByDimension[dimension].get(value) ?? [];
                          const valueIsHidden =
                            refs.length > 0 &&
                            refs.every((ref) =>
                              hidden.has(`${ref.modelId}#${ref.expressId}`),
                            );
                          return (
                            <li key={value} className="flex items-center gap-2">
                              <Checkbox
                                id={id}
                                checked={selection[dimension].has(value)}
                                onCheckedChange={() => toggle(dimension, value)}
                              />
                              <Label
                                htmlFor={id}
                                className="min-w-0 flex-1 truncate text-[11px] font-normal"
                                title={value}
                              >
                                {value}
                              </Label>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                className="text-muted-foreground"
                                aria-label={t(
                                  valueIsHidden ? "showValue" : "hideValue",
                                  { name: value },
                                )}
                                title={t(
                                  valueIsHidden ? "showValue" : "hideValue",
                                  { name: value },
                                )}
                                onClick={() =>
                                  valueIsHidden ? show(refs) : hide(refs)
                                }
                              >
                                {valueIsHidden ? (
                                  <EyeOff aria-hidden />
                                ) : (
                                  <Eye aria-hidden />
                                )}
                              </Button>
                              <Badge
                                variant="secondary"
                                className="h-4 px-1 text-[10px] font-normal"
                              >
                                {count}
                              </Badge>
                            </li>
                          );
                        })}
                      </ul>

                      {shown.length === 0 && (
                        <p className="text-muted-foreground text-[11px]">
                          {t("nothingMatches", { search: search[dimension] ?? "" })}
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {!selectionIsEmpty(selection) && (
        <p className="text-muted-foreground border-t p-2 text-[11px]">
          {t.rich("combineRule", {
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
      )}
    </div>
  );
}

export default FilterPanel;
