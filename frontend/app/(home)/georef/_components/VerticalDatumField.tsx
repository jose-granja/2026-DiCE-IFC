"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2, Search } from "lucide-react";

import { findVerticalCrs, searchVerticalCrs, useCrsIndex } from "@/lib/georef/crs-index";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * `IfcProjectedCRS.VerticalDatum`: the surface `OrthogonalHeight` is measured
 * from (Cascais, NAP, DHHN92, …).
 *
 * Free text, because that is what the IFC attribute is and files in the wild
 * write it every way, with a search over the bundled EPSG vertical systems that
 * fills it with the identifier IFC calls for — `EPSG:5780`, the form
 * `IfcProjectedCRS.Name` takes — not a display name. A filled datum is called out under the
 * field — an unstated one leaves every height in the model without a reference.
 */
export function VerticalDatumField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations("viewer.georefPanel.placementEditor.verticalDatum");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Also load when the value is an EPSG identifier, to name it under the field.
  const isEpsgCode = /^\s*EPSG:\d{4,6}\s*$/i.test(value);
  const ready = useCrsIndex(open || isEpsgCode);
  const results = ready ? searchVerticalCrs(query) : [];
  const filled = value.trim() !== "";
  const named = ready ? findVerticalCrs(value) : null;

  return (
    <div className="space-y-1.5" data-vertical-datum data-filled={filled}>
      <Label htmlFor="georef-vertical-datum" className="text-xs font-normal">
        {t("label")}
      </Label>
      <div className="flex gap-1.5">
        <Input
          id="georef-vertical-datum"
          value={value}
          placeholder={t("placeholder")}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 text-xs"
        />
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0"
              aria-label={t("search")}
              title={t("search")}
            >
              <Search className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-0" align="end">
            <Command shouldFilter={false}>
              <CommandInput
                placeholder={t("searchPlaceholder")}
                value={query}
                onValueChange={setQuery}
              />
              <CommandList>
                <CommandEmpty>{ready ? t("noMatches", { query }) : t("loading")}</CommandEmpty>
                <CommandGroup>
                  {results.map((crs) => (
                    <CommandItem
                      key={crs.code}
                      value={String(crs.code)}
                      onSelect={() => {
                        // The identifier IFC expects, not the display name.
                        onChange(`EPSG:${crs.code}`);
                        setOpen(false);
                      }}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs">{crs.name}</span>
                        <span className="text-muted-foreground block truncate text-[10px]">
                          EPSG:{crs.code}
                          {crs.area ? ` · ${crs.area}` : ""}
                        </span>
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
      {filled ? (
        <p className="text-success flex items-center gap-1 text-[11px]">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {named
            ? t("filledNamed", { datum: value.trim(), name: named.name })
            : t("filled", { datum: value.trim() })}
        </p>
      ) : (
        <p className="text-muted-foreground text-[11px]">{t("empty")}</p>
      )}
    </div>
  );
}

export default VerticalDatumField;
