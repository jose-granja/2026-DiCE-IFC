"use client";

import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { findCrs, groupCrsByRegion, indexedCrsCount, searchCrs } from "@/config/epsg";
import { useCrsIndex } from "@/lib/georef/crs-index";
import { Button } from "../ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { FormBase, FormControlProps } from "./FormBase";
import { useFieldContext } from "./hooks";
import Loading from "../Loading";

/**
 * Searchable CRS picker.
 *
 * The registry is bundled and grouped by region, mainland Portugal first,
 * because that is what will actually be chosen — see `config/epsg.ts` for why
 * it is not fetched.
 *
 * The field value is the **numeric EPSG code**, not the display name:
 * `IfcProjectedCRS.Name` is free text and round-tripping a label would lose the
 * one unambiguous thing about a CRS.
 */
export function FormSelectEPSG(
  props: FormControlProps & { placeholder?: string },
) {
  const field = useFieldContext<number | null>();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useCrsIndex(open || (field.state.value != null && !findCrs(field.state.value)));
  const selected = findCrs(field.state.value);
  const groups = groupCrsByRegion(searchCrs(query));
  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

  return (
    <FormBase {...props}>
      {props.isLoading ? (
        <Loading className="h-[36px] w-full" />
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              role="combobox"
              id={field.name}
              aria-expanded={open}
              aria-invalid={isInvalid}
              disabled={props.readOnly}
              onBlur={field.handleBlur}
              className="w-full justify-between font-normal"
            >
              {selected ? (
                <span className="truncate">
                  <span className="font-mono text-xs">{selected.name}</span>
                  {" — "}
                  {selected.label}
                </span>
              ) : (
                <span className="text-muted-foreground">
                  {props.placeholder ?? "Choose a coordinate reference system"}
                </span>
              )}
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>

          <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
            <Command shouldFilter={false}>
              <CommandInput
                placeholder="Search by code, name or datum…"
                value={query}
                onValueChange={setQuery}
              />
              <CommandList>
                <CommandEmpty>
                  No coordinate system matches “{query}”.
                </CommandEmpty>
                {!query.trim() && indexedCrsCount() > 0 && (
                  <p className="text-muted-foreground px-3 pt-2 text-[11px]">
                    Type to search all {indexedCrsCount().toLocaleString()} EPSG
                    systems.
                  </p>
                )}

                {groups.map((group) => (
                  <CommandGroup key={group.region} heading={group.region}>
                    {group.items.map((crs) => (
                      <CommandItem
                        key={crs.code}
                        value={String(crs.code)}
                        onSelect={() => {
                          field.handleChange(crs.code);
                          setOpen(false);
                        }}
                      >
                        <Check
                          className={cn(
                            "mr-2 h-4 w-4",
                            field.state.value === crs.code
                              ? "opacity-100"
                              : "opacity-0",
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-mono text-xs">{crs.name}</span>
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
      )}
    </FormBase>
  );
}

export default FormSelectEPSG;
