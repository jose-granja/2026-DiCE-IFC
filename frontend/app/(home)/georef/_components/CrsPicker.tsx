"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Check, ChevronsUpDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { findCrs, groupCrsByRegion, searchCrs } from "@/config/epsg";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * The CRS picker, outside a form.
 *
 * `FormSelectEPSG` is the registered TanStack Form control and is what IDS
 * authoring and any future form will use. The georeferencing editor is not a
 * form — every keystroke updates a live draft that redraws the map — so it
 * drives the same picker directly. Both render the same bundled registry,
 * grouped the same way; only the plumbing differs.
 */
export function CrsPicker({
  id,
  value,
  onChange,
}: {
  id?: string;
  value: number | null;
  onChange: (code: number) => void;
}) {
  const t = useTranslations("viewer.georefPanel.crsPicker");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = findCrs(value);
  const groups = groupCrsByRegion(searchCrs(query));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          id={id}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-8 w-full justify-between font-normal"
        >
          {selected ? (
            <span className="truncate text-xs">
              <span className="font-mono">{selected.name}</span>
              {" — "}
              {selected.label}
            </span>
          ) : (
            <span className="text-muted-foreground text-xs">
              {t("choosePlaceholder")}
            </span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t("searchPlaceholder")}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>
              {t("noMatches", { query })}
            </CommandEmpty>

            {groups.map((group) => (
              <CommandGroup key={group.region} heading={group.region}>
                {group.items.map((crs) => (
                  <CommandItem
                    key={crs.code}
                    value={String(crs.code)}
                    onSelect={() => {
                      onChange(crs.code);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        value === crs.code ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs">
                      <span className="font-mono">{crs.name}</span>
                      {" — "}
                      {crs.label}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default CrsPicker;
