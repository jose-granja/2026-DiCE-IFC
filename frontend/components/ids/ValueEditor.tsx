"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, X } from "lucide-react";

import {
  RESTRICTION_BASES,
  simple,
  type IdsValue,
  type RestrictionValue,
} from "@/lib/ids/types";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/**
 * The `xs:restriction` editor — `FormRestriction` from the build brief, as a
 * controlled component rather than a form field.
 *
 * IDS values are a choice: a literal, or a restriction. That is a real either/or
 * in the schema, so the UI makes it one too — a tab switch, not a set of fields
 * that might all be filled in at once.
 *
 * The four families (enumeration, pattern, bounds, length) are shown one at a
 * time for the same reason. XSD would allow several in one restriction and
 * treat them conjunctively, but a form offering all four at once invites
 * "minLength 5 and an enumeration of three values", which is almost never what
 * anyone means and is tedious to reason about in a validation report.
 */

type Family = "enumeration" | "pattern" | "bounds" | "length";

export function ValueEditor({
  label,
  value,
  onChange,
  onClear,
  suggestions = [],
  placeholder,
  required,
}: {
  label: string;
  value: IdsValue | undefined;
  onChange: (value: IdsValue) => void;
  /** Present when the field is optional, so it can be removed entirely. */
  onClear?: () => void;
  /** Values from the loaded model, offered as a datalist. */
  suggestions?: string[];
  placeholder?: string;
  required?: boolean;
}) {
  const t = useTranslations("idsCreate.valueEditor");
  const listId = `${label.replace(/\W+/g, "-").toLowerCase()}-suggestions`;
  const current = value ?? simple("");
  const isRestriction = current.kind === "restriction";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs font-medium">
          {label}
          {required && <span aria-hidden> *</span>}
        </Label>

        <div className="flex items-center gap-1">
          <Tabs
            value={isRestriction ? "restriction" : "simple"}
            onValueChange={(next) =>
              onChange(
                next === "restriction"
                  ? { kind: "restriction", base: "xs:string" }
                  : simple(""),
              )
            }
          >
            <TabsList className="h-6">
              <TabsTrigger value="simple" className="h-5 px-2 text-[11px]">
                {t("value")}
              </TabsTrigger>
              <TabsTrigger value="restriction" className="h-5 px-2 text-[11px]">
                {t("restriction")}
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {onClear && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={t("remove", { label })}
              onClick={onClear}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {current.kind === "simple" ? (
        <>
          <Input
            value={current.value}
            list={suggestions.length > 0 ? listId : undefined}
            onChange={(event) => onChange(simple(event.target.value))}
            placeholder={placeholder}
            aria-label={label}
            className="h-8 font-mono text-xs"
          />
          {suggestions.length > 0 && (
            <datalist id={listId}>
              {suggestions.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          )}
        </>
      ) : (
        <RestrictionEditor
          label={label}
          value={current}
          onChange={onChange}
          suggestions={suggestions}
        />
      )}
    </div>
  );
}

function RestrictionEditor({
  label,
  value,
  onChange,
  suggestions,
}: {
  label: string;
  value: RestrictionValue;
  onChange: (value: RestrictionValue) => void;
  suggestions: string[];
}) {
  const t = useTranslations("idsCreate.valueEditor");
  const FAMILY_LABELS: Record<Family, string> = {
    enumeration: t("family.enumeration"),
    pattern: t("family.pattern"),
    bounds: t("family.bounds"),
    length: t("family.length"),
  };
  const [family, setFamily] = useState<Family>(() => activeFamily(value));
  const [draft, setDraft] = useState("");

  const patch = (next: Partial<RestrictionValue>) =>
    onChange({ ...value, ...next });

  /** Switching family clears the others, so only one is ever in play. */
  const switchFamily = (next: Family) => {
    setFamily(next);
    onChange({
      kind: "restriction",
      base: value.base,
      ...(next === "enumeration" ? { enumeration: value.enumeration ?? [] } : {}),
      ...(next === "pattern" ? { pattern: value.pattern ?? "" } : {}),
      ...(next === "bounds" ? { bounds: value.bounds ?? {} } : {}),
      ...(next === "length" ? { length: value.length ?? {} } : {}),
    });
  };

  return (
    <div className="bg-muted/30 space-y-2 rounded border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={value.base}
          onValueChange={(base) =>
            patch({ base: base as RestrictionValue["base"] })
          }
        >
          <SelectTrigger className="h-7 w-32" aria-label={t("baseType", { label })}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RESTRICTION_BASES.map((base) => (
              <SelectItem key={base} value={base}>
                {base}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex gap-0.5">
          {(Object.keys(FAMILY_LABELS) as Family[]).map((option) => (
            <Button
              key={option}
              type="button"
              variant={family === option ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2 text-[11px]"
              aria-pressed={family === option}
              onClick={() => switchFamily(option)}
            >
              {FAMILY_LABELS[option]}
            </Button>
          ))}
        </div>
      </div>

      {family === "enumeration" && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap gap-1">
            {(value.enumeration ?? []).map((item) => (
              <span
                key={item}
                className="bg-background inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px]"
              >
                {item}
                <button
                  type="button"
                  aria-label={t("removeValue", { value: item })}
                  onClick={() =>
                    patch({
                      enumeration: (value.enumeration ?? []).filter(
                        (v) => v !== item,
                      ),
                    })
                  }
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>

          <div className="flex gap-1">
            <Input
              value={draft}
              list={suggestions.length > 0 ? `${label}-enum` : undefined}
              placeholder={t("addAllowedValuePlaceholder")}
              aria-label={t("allowedValue", { label })}
              className="h-7 font-mono text-xs"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                addEnumeration();
              }}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-7"
              onClick={addEnumeration}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          {suggestions.length > 0 && (
            <datalist id={`${label}-enum`}>
              {suggestions.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          )}
        </div>
      )}

      {family === "pattern" && (
        <div className="space-y-1">
          <Input
            value={value.pattern ?? ""}
            onChange={(event) => patch({ pattern: event.target.value })}
            placeholder={t("patternPlaceholder")}
            aria-label={t("patternAriaLabel", { label })}
            className={cn(
              "h-7 font-mono text-xs",
              !isValidRegex(value.pattern) && "border-destructive",
            )}
          />
          {!isValidRegex(value.pattern) && (
            <p className="text-destructive text-[11px]">
              {t("invalidRegex")}
            </p>
          )}
          <p className="text-muted-foreground text-[11px]">
            {t("regexHint")}
          </p>
        </div>
      )}

      {family === "bounds" && (
        <div className="grid grid-cols-2 gap-1.5">
          {(
            [
              ["minInclusive", t("boundsMinInclusive")],
              ["maxInclusive", t("boundsMaxInclusive")],
              ["minExclusive", t("boundsMinExclusive")],
              ["maxExclusive", t("boundsMaxExclusive")],
            ] as const
          ).map(([key, caption]) => (
            <NumberBox
              key={key}
              label={`${label} ${caption}`}
              caption={caption}
              value={value.bounds?.[key]}
              onChange={(next) =>
                patch({ bounds: { ...value.bounds, [key]: next } })
              }
            />
          ))}
        </div>
      )}

      {family === "length" && (
        <div className="grid grid-cols-3 gap-1.5">
          {(
            [
              ["length", t("lengthExactly")],
              ["minLength", t("lengthMinLength")],
              ["maxLength", t("lengthMaxLength")],
            ] as const
          ).map(([key, caption]) => (
            <NumberBox
              key={key}
              label={`${label} ${caption}`}
              caption={caption}
              value={value.length?.[key]}
              onChange={(next) =>
                patch({ length: { ...value.length, [key]: next } })
              }
            />
          ))}
        </div>
      )}
    </div>
  );

  function addEnumeration() {
    const item = draft.trim();
    if (!item) return;
    const existing = value.enumeration ?? [];
    // Duplicates in an xs:enumeration are legal and meaningless.
    if (!existing.includes(item)) patch({ enumeration: [...existing, item] });
    setDraft("");
  }
}

function NumberBox({
  label,
  caption,
  value,
  onChange,
}: {
  label: string;
  caption: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <div>
      <p className="text-muted-foreground mb-0.5 text-[11px]">{caption}</p>
      <Input
        type="text"
        inputMode="decimal"
        aria-label={label}
        value={value === undefined ? "" : String(value)}
        onChange={(event) => {
          const raw = event.target.value.trim();
          if (raw === "") {
            // Clearing a bound removes it, rather than pinning it to 0 — which
            // would silently add a constraint the author just deleted.
            onChange(undefined);
            return;
          }
          const parsed = Number(raw);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
        className="h-7 font-mono text-xs tabular-nums"
      />
    </div>
  );
}

function activeFamily(value: RestrictionValue): Family {
  if (value.pattern !== undefined) return "pattern";
  if (value.bounds) return "bounds";
  if (value.length) return "length";
  return "enumeration";
}

function isValidRegex(pattern: string | undefined): boolean {
  if (!pattern) return true;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

export default ValueEditor;
