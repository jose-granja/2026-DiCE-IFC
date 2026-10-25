"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { Eye, EyeOff, Filter } from "lucide-react";

import { getModelHandle } from "@/lib/viewer/loader";
import { useViewerStore, type EntityRef } from "@/lib/viewer/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

/**
 * Filter the federation down to a set of IFC classes.
 *
 * Counts are summed across models, because "how many walls are in this
 * federation" is the question a coordinator actually asks.
 *
 * Applying the filter resolves the chosen classes to express ids and hands them
 * to `isolate`, so the 3D view, the tree and any other consumer of the store
 * agree by construction rather than by each implementing filtering separately.
 */
export function ClassFilter() {
  const t = useTranslations("viewer.classFilter");
  const models = useViewerStore((s) => s.models);
  const typeFilter = useViewerStore((s) => s.typeFilter);
  const toggleTypeFilter = useViewerStore((s) => s.toggleTypeFilter);
  const clearTypeFilter = useViewerStore((s) => s.clearTypeFilter);
  const isolate = useViewerStore((s) => s.isolate);
  const clearIsolation = useViewerStore((s) => s.clearIsolation);

  const [search, setSearch] = useState("");

  const classes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const model of models) {
      for (const { type, count } of model.entityTypes) {
        counts.set(type, (counts.get(type) ?? 0) + count);
      }
    }
    return [...counts.entries()]
      .map(([type, count]) => ({ type, count }))
      .filter((entry) =>
        entry.type.toLowerCase().includes(search.trim().toLowerCase()),
      )
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  }, [models, search]);

  const types = useMemo(() => [...typeFilter].sort(), [typeFilter]);
  const modelIds = useMemo(
    () => models.map((m) => m.summary.id),
    [models],
  );

  // Resolving classes to express ids means a round trip to every worker, so it
  // is a query — keyed on the classes and the loaded models, which is exactly
  // when the answer changes.
  const { data: matches, isFetching } = useQuery({
    queryKey: ["class-filter", types, modelIds],
    enabled: types.length > 0,
    queryFn: async (): Promise<EntityRef[]> => {
      const perModel = await Promise.all(
        modelIds.map(async (modelId) => {
          const handle = getModelHandle(modelId);
          if (!handle) return [] as EntityRef[];
          const entities = await handle.getEntities({ types });
          return entities.map((entity) => ({
            modelId,
            expressId: entity.expressId,
          }));
        }),
      );
      return perModel.flat();
    },
  });

  /**
   * Whether the isolation currently in the store is *ours*.
   *
   * `isolated` is a single shared slot: the IDS validator sets it when you
   * click a failure, and the BCF module sets it when you open a viewpoint.
   * This effect used to clear it whenever no class filter was active — which
   * includes on mount — so navigating back to the viewer silently undid both.
   * The element you had asked to see was simply not isolated any more, and
   * nothing said why.
   */
  const ownsIsolation = useRef(false);

  // Pushing the result into the viewer store is the one thing that genuinely
  // belongs in an effect: it synchronises an external system, and it is what
  // keeps the 3D view, the tree and any other consumer in agreement instead of
  // each implementing filtering separately.
  useEffect(() => {
    if (types.length === 0) {
      if (ownsIsolation.current) {
        ownsIsolation.current = false;
        clearIsolation();
      }
      return;
    }
    if (matches) {
      ownsIsolation.current = true;
      isolate(matches);
    }
  }, [types, matches, isolate, clearIsolation]);

  if (models.length === 0) {
    return (
      <p className="text-muted-foreground p-3 text-xs">
        {t("loadModel")}
      </p>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b p-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("filterPlaceholder")}
          aria-label={t("filterAriaLabel")}
          className="h-8"
        />
        {typeFilter.size > 0 && (
          <Button variant="ghost" size="sm" onClick={clearTypeFilter}>
            {t("clear")}
          </Button>
        )}
      </div>

      {typeFilter.size > 0 && (
        <p className="text-muted-foreground border-b px-3 py-1.5 text-xs">
          <Filter className="mr-1 inline h-3 w-3" />
          {isFetching
            ? t("applying")
            : t("showingOnly", { count: typeFilter.size })}
        </p>
      )}

      <ul className="flex-1 overflow-auto py-1">
        {classes.map(({ type, count }) => {
          const checked = typeFilter.has(type);
          return (
            <li key={type}>
              <label
                className={cn(
                  "hover:bg-accent flex cursor-pointer items-center gap-2 px-3 py-1 text-sm",
                  checked && "bg-accent/60",
                )}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => toggleTypeFilter(type)}
                />
                <span className="flex-1 truncate">{type}</span>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {count.toLocaleString()}
                </span>
              </label>
            </li>
          );
        })}
        {classes.length === 0 && (
          <li className="text-muted-foreground px-3 py-2 text-xs">
            {t("noClassesMatch", { search })}
          </li>
        )}
      </ul>
    </div>
  );
}

/** Hide / isolate / reset for the current selection. */
export function VisibilityActions() {
  const t = useTranslations("viewer.classFilter");
  const selection = useViewerStore((s) => s.selection);
  const hide = useViewerStore((s) => s.hide);
  const isolate = useViewerStore((s) => s.isolate);
  const resetVisibility = useViewerStore((s) => s.resetVisibility);
  const hidden = useViewerStore((s) => s.hidden);
  const isolated = useViewerStore((s) => s.isolated);

  const hasOverrides = hidden.size > 0 || isolated !== null;

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        disabled={selection.length === 0}
        title={t("hide")}
        onClick={() => hide(selection)}
      >
        <EyeOff className="h-4 w-4" />
        <span className="sr-only lg:not-sr-only">{t("hide")}</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={selection.length === 0}
        title={t("isolate")}
        onClick={() => isolate(selection)}
      >
        <Filter className="h-4 w-4" />
        <span className="sr-only lg:not-sr-only">{t("isolate")}</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={!hasOverrides}
        title={t("showAll")}
        onClick={resetVisibility}
      >
        <Eye className="h-4 w-4" />
        <span className="sr-only lg:not-sr-only">{t("showAll")}</span>
      </Button>
    </div>
  );
}

export default ClassFilter;
