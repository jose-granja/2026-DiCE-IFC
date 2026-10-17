"use client";

import { useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import type { ContextGeometry } from "@/lib/georef/context-geometry";
import { useContextModelStore } from "@/lib/viewer/context-model-store";
import { contextColourGroups, type ContextColourGroup } from "@/lib/viewer/context-appearance";

export function ContextAppearanceControls({ geometry, disabled }: { geometry: ContextGeometry; disabled: boolean }) {
  const t = useTranslations("viewer.contextModel.appearance");
  const appearance = useContextModelStore((s) => s.appearance);
  const setSettings = useContextModelStore((s) => s.setSettings);
  const properties = useMemo(() => [...new Set((geometry.features ?? []).flatMap((feature) => Object.keys(feature.properties)))].sort(), [geometry]);
  const groups = useMemo(() => appearance.colouring ? contextColourGroups(geometry.features ?? [], appearance.colouring) : [], [geometry, appearance.colouring]);
  const change = (patch: Partial<typeof appearance>) => setSettings({ appearance: { ...useContextModelStore.getState().appearance, ...patch } });

  return <div className="space-y-2 rounded border p-2" data-context-appearance>
    <div className="flex items-center justify-between gap-2">
      <Label htmlFor="context-edges" className="text-[11px]">{t("edges")}</Label>
      <Switch id="context-edges" disabled={disabled} checked={appearance.edgesOn} onCheckedChange={(edgesOn) => change({ edgesOn })} />
    </div>
    {appearance.edgesOn && <div className="flex items-center gap-2">
      <span className="text-muted-foreground shrink-0 text-[11px]">{t("edgeWidth")}</span>
      <Slider min={0.5} max={3} step={0.5} value={[appearance.edgeWidth]} disabled={disabled}
        aria-label={t("edgeWidth")} onValueChange={([edgeWidth]) => change({ edgeWidth })} />
      <span className="w-10 shrink-0 text-right text-[11px]">{appearance.edgeWidth.toFixed(1)} px</span>
    </div>}
    <div className="space-y-1">
      <Label htmlFor="context-colour-property" className="text-[11px]">{t("colourBy")}</Label>
      <Select disabled={disabled || !properties.length} value={appearance.colouring ? `property:${appearance.colouring.property}` : "original"}
        onValueChange={(value) => change({ colouring: value === "original" ? null : { property: value.slice(9), overrides: {} } })}>
        <SelectTrigger id="context-colour-property" size="sm" className="h-7 w-full text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="original">{t("original")}</SelectItem>
          {properties.map((property) => <SelectItem key={property} value={`property:${property}`}>{property}</SelectItem>)}
        </SelectContent>
      </Select>
      {!properties.length && <p className="text-muted-foreground text-[11px]">{t("noProperties")}</p>}
    </div>
    {appearance.colouring && <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-[11px]">{t("values", { count: groups.length })}</span>
        {!!appearance.colouring.hiddenValues?.length && <Button className="h-6 px-1 text-[11px]" variant="ghost" disabled={disabled}
          onClick={() => change({ colouring: { ...appearance.colouring!, hiddenValues: [] } })}>{t("showAll")}</Button>}
        <Button className="h-6 px-1 text-[11px]" variant="ghost" disabled={disabled || !Object.keys(appearance.colouring.overrides).length}
          onClick={() => change({ colouring: { ...appearance.colouring!, overrides: {} } })}>{t("reset")}</Button>
      </div>
      <ColourLegend key={appearance.colouring.property} groups={groups} disabled={disabled} hiddenValues={appearance.colouring.hiddenValues ?? []}
        onToggleVisibility={(key) => {
          const current = useContextModelStore.getState().appearance.colouring;
          if (!current) return;
          const hidden = new Set(current.hiddenValues);
          if (hidden.has(key)) hidden.delete(key); else hidden.add(key);
          change({ colouring: { ...current, hiddenValues: [...hidden] } });
        }} onColour={(key, colour) => {
        const current = useContextModelStore.getState().appearance.colouring;
        if (current) change({ colouring: { ...current, overrides: { ...current.overrides, [key]: colour } } });
      }} />
    </>}
  </div>;
}

function ColourLegend({ groups, disabled, hiddenValues, onToggleVisibility, onColour }: {
  groups: ContextColourGroup[]; disabled: boolean; onColour: (key: string, colour: string) => void;
  hiddenValues: string[]; onToggleVisibility: (key: string) => void;
}) {
  "use no memo"; // TanStack Virtual reads a mutable instance on each render.
  const t = useTranslations("viewer.contextModel.appearance");
  const [filter, setFilter] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const hidden = new Set(hiddenValues);
  const rows = groups.map((group) => ({ ...group, label: group.value === undefined ? t("missingValue")
    : group.value === null ? t("nullValue") : group.value === "" ? t("emptyValue")
      : typeof group.value === "boolean" ? t(group.value ? "yes" : "no")
        : typeof group.value === "object" ? JSON.stringify(group.value) : String(group.value) }))
    .filter((group) => group.label.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
  // Local to this non-memoized component, as in the IDS result lists.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current, estimateSize: () => 32, overscan: 4 });
  return <div className="space-y-1">
    <Input value={filter} disabled={disabled} aria-label={t("filterValues")} placeholder={t("filterValues")} className="h-7 text-xs"
      onChange={(event) => { setFilter(event.target.value); if (scroll.current) scroll.current.scrollTop = 0; }} />
    <div ref={scroll} className="overflow-auto" style={{ height: Math.min(160, rows.length * 32) }} data-context-colour-legend>
      <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
        {virtual.getVirtualItems().map((item) => {
          const row = rows[item.index];
          const isHidden = hidden.has(row.key);
          return <div key={row.key} className="absolute top-0 left-0 flex w-full items-center gap-2 text-[11px]"
            style={{ height: item.size, transform: `translateY(${item.start}px)` }}>
            <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" disabled={disabled}
              aria-label={t(isHidden ? "showValue" : "hideValue", { value: row.label })}
              title={t(isHidden ? "showValue" : "hideValue", { value: row.label })}
              onClick={() => onToggleVisibility(row.key)}>
              {isHidden ? <EyeOff className="size-3.5 text-muted-foreground" /> : <Eye className="size-3.5" />}
            </Button>
            <input type="color" value={row.colour} disabled={disabled} aria-label={t("valueColour", { value: row.label })}
              className="h-6 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
              onChange={(event) => onColour(row.key, event.target.value)} />
            <span className={`min-w-0 flex-1 truncate${isHidden ? " text-muted-foreground line-through" : ""}`} title={row.label}>{row.label}</span>
            <span className="text-muted-foreground tabular-nums">{row.count}</span>
          </div>;
        })}
      </div>
    </div>
    {!rows.length && <p className="text-muted-foreground text-[11px]">{t("noValues")}</p>}
  </div>;
}
