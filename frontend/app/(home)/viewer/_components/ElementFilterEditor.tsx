"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";

import { splitTextList } from "@/lib/ifc/text-match";
import type {
  ElementFilter,
  QuantityQueryOperator,
  QuantityQueryPropertyCondition,
} from "@/lib/ifc/types";
import { classificationCodesFor, type MergedVocabulary } from "@/lib/viewer/use-model-vocabulary";
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

const OPERATORS: QuantityQueryOperator[] = [
  "equals",
  "notEquals",
  "contains",
  "greaterThan",
  "greaterOrEqual",
  "lessThan",
  "lessOrEqual",
  "exists",
];

type ListKey =
  | "classes"
  | "names"
  | "predefinedTypes"
  | "objectTypes"
  | "materials"
  | "materialCategories";

/**
 * A comma-separated field holding a list. Edited as text and split on every
 * keystroke would lose a trailing comma while typing, so the text is kept as
 * typed until the field changes from outside.
 */
function ListField({
  id,
  label,
  values,
  suggestions,
  onChange,
}: {
  id: string;
  label: string;
  values: string[];
  suggestions: string[];
  onChange: (values: string[]) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px]">
        {label}
      </Label>
      <Input
        id={id}
        list={`${id}-options`}
        defaultValue={values.join(", ")}
        // Re-mount when the stored value changes from elsewhere (import, undo).
        key={values.join("\u0000")}
        onBlur={(event) => onChange(splitTextList(event.target.value))}
        onKeyDown={(event) => {
          if (event.key === "Enter") onChange(splitTextList(event.currentTarget.value));
        }}
        className="h-8 text-xs"
      />
      <datalist id={`${id}-options`}>
        {suggestions.map((suggestion) => (
          <option key={suggestion} value={suggestion} />
        ))}
      </datalist>
    </div>
  );
}

/** One value rather than a list: a classification system is the context its codes are read in, not an alternative. */
function TextField({
  id,
  label,
  value,
  suggestions,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  suggestions: string[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px]">
        {label}
      </Label>
      <Input
        id={id}
        list={`${id}-options`}
        defaultValue={value}
        key={value}
        onBlur={(event) => onChange(event.target.value.trim())}
        onKeyDown={(event) => {
          if (event.key === "Enter") onChange(event.currentTarget.value.trim());
        }}
        className="h-8 text-xs"
      />
      <datalist id={`${id}-options`}>
        {suggestions.map((suggestion) => (
          <option key={suggestion} value={suggestion} />
        ))}
      </datalist>
    </div>
  );
}

/**
 * The filter of one clash group: the same selectors as the quantity query —
 * class, name, predefined type, object type, material, material category,
 * classification and properties in property sets — written so a clash matrix can
 * say "all concrete walls with FireRating REI 60", or "everything the project
 * classified as Ss_25_10_30".
 */
export function ElementFilterEditor({
  filter,
  vocabulary,
  onChange,
}: {
  filter: ElementFilter;
  vocabulary: MergedVocabulary;
  onChange: (filter: ElementFilter) => void;
}) {
  const t = useTranslations("viewer.clash");
  const tq = useTranslations("viewer.quantityQuery");
  const base = useId();

  const setList = (key: ListKey) => (values: string[]) => onChange({ ...filter, [key]: values });
  const patchCondition = (index: number, patch: Partial<QuantityQueryPropertyCondition>) =>
    onChange({
      ...filter,
      properties: filter.properties.map((condition, i) => (i === index ? { ...condition, ...patch } : condition)),
    });

  const setNames = [...vocabulary.propertySets.keys()];

  return (
    <div className="space-y-2">
      <ListField id={`${base}-classes`} label={t("filter.classes")} values={filter.classes} suggestions={vocabulary.classes} onChange={setList("classes")} />
      <ListField id={`${base}-names`} label={t("filter.names")} values={filter.names} suggestions={[]} onChange={setList("names")} />
      <ListField id={`${base}-predefined`} label={t("filter.predefinedTypes")} values={filter.predefinedTypes} suggestions={vocabulary.predefinedTypes} onChange={setList("predefinedTypes")} />
      <ListField id={`${base}-object`} label={t("filter.objectTypes")} values={filter.objectTypes} suggestions={vocabulary.objectTypes} onChange={setList("objectTypes")} />
      <ListField id={`${base}-material`} label={t("filter.materials")} values={filter.materials} suggestions={vocabulary.materials} onChange={setList("materials")} />
      <ListField id={`${base}-category`} label={t("filter.materialCategories")} values={filter.materialCategories} suggestions={[]} onChange={setList("materialCategories")} />
      <TextField
        id={`${base}-classification-system`}
        label={t("filter.classificationSystem")}
        value={filter.classificationSystem ?? ""}
        suggestions={vocabulary.classificationSystems}
        onChange={(value) => onChange({ ...filter, classificationSystem: value })}
      />
      <ListField
        id={`${base}-classification-code`}
        label={t("filter.classificationCode")}
        values={filter.classificationCodes ?? []}
        suggestions={classificationCodesFor(vocabulary.classificationCodes, filter.classificationSystem ?? "")}
        onChange={(values) => onChange({ ...filter, classificationCodes: values })}
      />
      <p className="text-muted-foreground text-[10px] leading-snug">{t("filter.hint")}</p>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-[11px]">{t("filter.properties")}</Label>
          <div className="flex items-center gap-1">
            {filter.properties.length > 1 && (
              <Select
                value={filter.propertyCombination ?? "all"}
                onValueChange={(value) =>
                  onChange({ ...filter, propertyCombination: value as "all" | "any" })
                }
              >
                <SelectTrigger size="sm" className="h-7 w-20 text-[11px]" aria-label={t("filter.combination")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("filter.all")}</SelectItem>
                  <SelectItem value="any">{t("filter.any")}</SelectItem>
                </SelectContent>
              </Select>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() =>
                onChange({
                  ...filter,
                  properties: [
                    ...filter.properties,
                    { setName: "", propertyName: "", operator: "equals", value: "" },
                  ],
                })
              }
            >
              <Plus className="h-3 w-3" />
              {t("filter.addCondition")}
            </Button>
          </div>
        </div>

        {filter.properties.map((condition, index) => {
          const propertyNames = vocabulary.propertySets.get(condition.setName) ?? [];
          return (
            <div key={index} className="space-y-1 rounded border p-1.5">
              <div className="grid grid-cols-2 gap-1">
                <Input
                  aria-label={t("filter.set")}
                  placeholder={t("filter.set")}
                  list={`${base}-sets`}
                  value={condition.setName}
                  onChange={(event) => patchCondition(index, { setName: event.target.value })}
                  className="h-8 text-xs"
                />
                <Input
                  aria-label={t("filter.property")}
                  placeholder={t("filter.property")}
                  list={`${base}-props-${index}`}
                  value={condition.propertyName}
                  onChange={(event) => patchCondition(index, { propertyName: event.target.value })}
                  className="h-8 text-xs"
                />
                <datalist id={`${base}-props-${index}`}>
                  {propertyNames.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </div>
              <div className="flex items-center gap-1">
                <Select
                  value={condition.operator}
                  onValueChange={(value) =>
                    patchCondition(index, { operator: value as QuantityQueryOperator })
                  }
                >
                  <SelectTrigger size="sm" className="h-8 w-28 shrink-0 text-[11px]" aria-label={t("filter.operator")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OPERATORS.map((operator) => (
                      <SelectItem key={operator} value={operator}>
                        {tq(`operators.${operator}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {condition.operator !== "exists" && (
                  <Input
                    aria-label={t("filter.value")}
                    placeholder={t("filter.value")}
                    value={condition.value}
                    onChange={(event) => patchCondition(index, { value: event.target.value })}
                    className="h-8 min-w-0 flex-1 text-xs"
                  />
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="ml-auto h-8 w-8 shrink-0"
                  aria-label={t("filter.removeCondition")}
                  onClick={() =>
                    onChange({
                      ...filter,
                      properties: filter.properties.filter((_, i) => i !== index),
                    })
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          );
        })}
        <datalist id={`${base}-sets`}>
          {setNames.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </div>
    </div>
  );
}

export default ElementFilterEditor;
