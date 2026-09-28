"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Loader2, Plus, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { listDictionaries } from "@/lib/bsdd/client";
import { useBsddStore } from "@/lib/bsdd/store";

/**
 * Choosing which bSDD dictionaries to author against.
 *
 * IFC 4.3 is the useful default for IDS authoring. Authors can remove it or add
 * national and project dictionaries, and that explicit choice is persisted.
 * Merely selecting a dictionary performs no request; searches stay driven by
 * the facet fields below.
 */
export function DictionaryPicker() {
  const t = useTranslations("idsCreate.dictionaryPicker");
  const selected = useBsddStore((s) => s.selected);
  const hydrated = useBsddStore((s) => s.hydrated);
  const hydrate = useBsddStore((s) => s.hydrate);
  const add = useBsddStore((s) => s.add);
  const remove = useBsddStore((s) => s.remove);

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Only when the popover is open: the list is a few hundred entries, and
  // nobody who never opens this should pay for it.
  const { data, isLoading, error } = useQuery({
    queryKey: ["bsdd-dictionaries"],
    queryFn: listDictionaries,
    enabled: open,
    staleTime: Infinity,
    retry: false,
  });

  const matches = useMemo(() => {
    const all = data ?? [];
    const needle = search.trim().toLowerCase();
    const chosen = new Set(selected.map((entry) => entry.uri));

    return all
      .filter((entry) => !chosen.has(entry.uri))
      .filter(
        (entry) =>
          !needle ||
          entry.name.toLowerCase().includes(needle) ||
          entry.organizationNameOwner.toLowerCase().includes(needle),
      )
      .slice(0, 60);
  }, [data, search, selected]);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {hydrated &&
        selected.map((dictionary) => (
          <Badge key={dictionary.uri} variant="secondary" className="gap-1 text-[10px]">
            {dictionary.name} {dictionary.version}
            <button
              type="button"
              onClick={() => remove(dictionary.uri)}
              aria-label={t("stopUsing", { name: dictionary.name })}
              className="hover:text-destructive"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
            <BookOpen className="h-3.5 w-3.5" />
            {selected.length === 0 ? t("useDictionary") : t("add")}
          </Button>
        </PopoverTrigger>

        <PopoverContent align="end" className="w-80 p-2">
          <p className="text-muted-foreground mb-2 text-[11px]">
            {t("description")}
          </p>

          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("searchPlaceholder")}
            className="h-7 text-xs"
            aria-label={t("searchAriaLabel")}
          />

          <div className="mt-2 max-h-72 overflow-auto">
            {isLoading && (
              <p className="text-muted-foreground flex items-center gap-1.5 p-2 text-xs">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                {t("loading")}
              </p>
            )}

            {error && (
              <p className="text-destructive p-2 text-xs">
                {(error as Error).message} {t("worksWithoutThis")}
              </p>
            )}

            {data && matches.length === 0 && (
              <p className="text-muted-foreground p-2 text-xs">
                {t("noMatches", { search })}
              </p>
            )}

            <ul>
              {matches.map((dictionary) => (
                <li key={dictionary.uri}>
                  <button
                    type="button"
                    onClick={() => add(dictionary)}
                    className="hover:bg-accent flex w-full items-start gap-1.5 rounded px-2 py-1.5 text-left"
                  >
                    <Plus className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium">
                        {dictionary.name}{" "}
                        <span className="text-muted-foreground font-normal">
                          {dictionary.version}
                        </span>
                      </span>
                      <span className="text-muted-foreground block truncate text-[11px]">
                        {dictionary.organizationNameOwner}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export default DictionaryPicker;
