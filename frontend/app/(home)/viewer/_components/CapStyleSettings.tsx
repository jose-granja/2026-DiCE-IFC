"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { RotateCcw, Settings2 } from "lucide-react";

import { useViewerStore } from "@/lib/viewer/store";
import {
  DEFAULT_SECTION_CAP_STYLE,
  SECTION_CAP_LIMITS,
  type SectionCapStyle,
} from "@/lib/viewer/section-cap";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type NumericKey = keyof typeof SECTION_CAP_LIMITS;
type ColourKey = "fillColour" | "hatchColour" | "borderColour";

/** Typing "0." must not be rewritten under the cursor, so text is local until blur. */
function NumberField({
  id,
  label,
  value,
  limits,
  step,
  onCommit,
}: {
  id: string;
  label: string;
  value: number;
  limits: { min: number; max: number };
  step: number;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-muted-foreground text-[11px]">
        {label}
      </label>
      <Input
        id={id}
        type="number"
        className="h-8 px-2 text-xs"
        min={limits.min}
        max={limits.max}
        step={step}
        value={text ?? String(value)}
        onChange={(event) => {
          setText(event.target.value);
          const parsed = Number(event.target.value);
          if (event.target.value !== "" && Number.isFinite(parsed)) {
            onCommit(Math.min(limits.max, Math.max(limits.min, parsed)));
          }
        }}
        onBlur={() => setText(null)}
      />
    </div>
  );
}

function ColourField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-2 text-xs">
      <input
        id={id}
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-7 w-9 cursor-pointer rounded border bg-transparent p-0.5"
      />
      {label}
    </label>
  );
}

/** Colours, hatch spacing/width and outline of the section cut fill. */
export function CapStyleSettings() {
  const t = useTranslations("viewer.sectionPanel.capFill.settings");
  const style = useViewerStore((s) => s.sectionCapStyle);
  const setStyle = useViewerStore((s) => s.setSectionCapStyle);

  const colour = (key: ColourKey, label: string) => (
    <ColourField
      id={`cap-${key}`}
      label={label}
      value={style[key]}
      onChange={(value) => setStyle({ [key]: value } as Partial<SectionCapStyle>)}
    />
  );
  const number = (key: NumericKey, label: string, step: number) => (
    <NumberField
      id={`cap-${key}`}
      label={label}
      value={style[key]}
      limits={SECTION_CAP_LIMITS[key]}
      step={step}
      onCommit={(value) => setStyle({ [key]: value } as Partial<SectionCapStyle>)}
    />
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label={t("open")}
          title={t("open")}
          disabled={!style.enabled}
        >
          <Settings2 className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3 p-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold">{t("title")}</p>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-[11px]"
            onClick={() => setStyle({ ...DEFAULT_SECTION_CAP_STYLE, enabled: true, pattern: style.pattern })}
          >
            <RotateCcw className="h-3 w-3" />
            {t("reset")}
          </Button>
        </div>

        <div className="flex gap-4">
          {colour("fillColour", t("fill"))}
          {colour("hatchColour", t("hatch"))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {number("hatchSpacing", t("spacing"), 0.05)}
          {number("hatchWidth", t("width"), 0.01)}
        </div>

        <div className="border-t pt-3">
          <p className="text-muted-foreground mb-2 text-[11px] font-medium uppercase">
            {t("border")}
          </p>
          <div className="grid grid-cols-2 items-end gap-2">
            {colour("borderColour", t("borderColour"))}
            {number("borderWidth", t("borderWidth"), 0.5)}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
