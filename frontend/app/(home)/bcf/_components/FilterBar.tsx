"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { ArrowDownUp, Filter, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isFilterActive, type DueFilter, type SortKey } from "@/lib/bcf/filter";
import { useBcfStore } from "@/lib/bcf/store";

/**
 * The topic filter bar.
 *
 * Facet options come from the file's own extensions unioned with the values its
 * topics actually use, so a project that calls its statuses "Em análise" gets
 * those in the dropdown rather than the standard's examples.
 */
export function FilterBar() {
  const t = useTranslations("bcf.filterBar");
  const filter = useBcfStore((s) => s.filter);
  const setFilter = useBcfStore((s) => s.setFilter);
  const clearFilter = useBcfStore((s) => s.clearFilter);
  const sortKey = useBcfStore((s) => s.sortKey);
  const sortDirection = useBcfStore((s) => s.sortDirection);
  const setSort = useBcfStore((s) => s.setSort);
  const extensions = useBcfStore((s) => s.file.extensions);

  const active = isFilterActive(filter);
  const facetCount =
    filter.statuses.length +
    filter.priorities.length +
    filter.types.length +
    filter.assignees.length +
    filter.labels.length +
    (filter.due === "any" ? 0 : 1);

  const facets = useMemo(
    () =>
      [
        { key: "statuses", label: t("status"), options: extensions.topicStatuses },
        { key: "priorities", label: t("priority"), options: extensions.priorities },
        { key: "types", label: t("type"), options: extensions.topicTypes },
        { key: "assignees", label: t("assignedTo"), options: extensions.users },
        { key: "labels", label: t("label"), options: extensions.topicLabels },
      ] as const,
    [extensions, t],
  );

  const toggle = (key: (typeof facets)[number]["key"], value: string) => {
    const current = filter[key];
    setFilter({
      [key]: current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value],
    });
  };

  return (
    <div className="space-y-2 border-b p-2">
      <Input
        value={filter.search}
        onChange={(event) => setFilter({ search: event.target.value })}
        placeholder={t("searchPlaceholder")}
        className="h-8 text-xs"
        aria-label={t("searchTopics")}
      />

      <div className="flex items-center gap-1.5">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs">
              <Filter className="h-3.5 w-3.5" />
              {t("filters")}
              {facetCount > 0 && (
                <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">
                  {facetCount}
                </Badge>
              )}
            </Button>
          </PopoverTrigger>

          <PopoverContent align="start" className="max-h-96 w-64 overflow-auto p-3">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t("dueDate")}</Label>
                <Select
                  value={filter.due}
                  onValueChange={(value) => setFilter({ due: value as DueFilter })}
                >
                  <SelectTrigger className="h-7 text-xs" aria-label={t("dueDate")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">{t("any")}</SelectItem>
                    <SelectItem value="overdue">{t("overdue")}</SelectItem>
                    <SelectItem value="soon">{t("dueWithinWeek")}</SelectItem>
                    <SelectItem value="none">{t("noDueDate")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {facets.map(({ key, label, options }) =>
                options.length === 0 ? null : (
                  <fieldset key={key} className="space-y-1.5">
                    <legend className="text-xs font-medium">{label}</legend>
                    {options.map((option) => {
                      const id = `${key}-${option}`;
                      return (
                        <div key={option} className="flex items-center gap-2">
                          <Checkbox
                            id={id}
                            checked={filter[key].includes(option)}
                            onCheckedChange={() => toggle(key, option)}
                          />
                          <Label
                            htmlFor={id}
                            className="text-muted-foreground text-xs font-normal"
                          >
                            {option}
                          </Label>
                        </div>
                      );
                    })}
                  </fieldset>
                ),
              )}
            </div>
          </PopoverContent>
        </Popover>

        <Select value={sortKey} onValueChange={(value) => setSort(value as SortKey)}>
          <SelectTrigger className="h-7 flex-1 text-xs" aria-label={t("sortBy")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="created">{t("created")}</SelectItem>
            <SelectItem value="modified">{t("modifiedSort")}</SelectItem>
            <SelectItem value="due">{t("dueDate")}</SelectItem>
            <SelectItem value="priority">{t("priority")}</SelectItem>
            <SelectItem value="status">{t("status")}</SelectItem>
            <SelectItem value="type">{t("type")}</SelectItem>
            <SelectItem value="assignee">{t("assignedTo")}</SelectItem>
            <SelectItem value="title">{t("titleSort")}</SelectItem>
            <SelectItem value="index">{t("index")}</SelectItem>
          </SelectContent>
        </Select>

        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => setSort(sortKey)}
          aria-label={
            sortDirection === "asc" ? t("sortDescending") : t("sortAscending")
          }
        >
          <ArrowDownUp className="h-3.5 w-3.5" />
        </Button>

        {active && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={clearFilter}
            aria-label={t("clearFilters")}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

export default FilterBar;
