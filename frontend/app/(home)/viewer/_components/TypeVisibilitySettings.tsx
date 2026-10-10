"use client";

import type { ComponentType } from "react";
import { useTranslations } from "next-intl";
import {
  Box,
  Boxes,
  Grid3X3,
  Map,
  Pencil,
  Settings2,
  Square,
  SquareDashed,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { useViewerStore } from "@/lib/viewer/store";
import {
  TYPE_VISIBILITY_CATEGORIES,
  type TypeVisibilityCategory,
} from "@/lib/viewer/type-visibility";

type Icon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

const CATEGORY_ICONS: Record<TypeVisibilityCategory, Icon> = {
  spaces: Box,
  spatialZones: Boxes,
  openings: Square,
  virtualElements: SquareDashed,
  site: Map,
  annotations: Pencil,
  grids: Grid3X3,
};

/** Semantic IFC visibility controls, kept separate from manual hide/isolate. */
export function TypeVisibilitySettings() {
  const t = useTranslations("viewer.typeVisibility");
  const visibility = useViewerStore((state) => state.typeVisibility);
  const setVisibility = useViewerStore((state) => state.setTypeVisibility);
  const reset = useViewerStore((state) => state.resetTypeVisibility);
  const enabled = TYPE_VISIBILITY_CATEGORIES.filter(
    (category) => visibility[category],
  ).length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={t("buttonAriaLabel")}>
          <Settings2 className="h-4 w-4" aria-hidden />
          {t("button")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <h2 className="flex-1 text-sm font-semibold uppercase tracking-wide">
            {t("title")}
          </h2>
          <span className="text-muted-foreground text-xs tabular-nums">
            {t("enabled", {
              enabled,
              total: TYPE_VISIBILITY_CATEGORIES.length,
            })}
          </span>
          <Button variant="ghost" size="xs" onClick={reset}>
            {t("reset")}
          </Button>
        </div>

        <div className="space-y-0.5 p-2">
          {TYPE_VISIBILITY_CATEGORIES.map((category) => {
            const CategoryIcon = CATEGORY_ICONS[category];
            return (
              <label
                key={category}
                className="hover:bg-accent flex cursor-pointer items-center gap-3 rounded-md px-2 py-2"
              >
                <CategoryIcon
                  className="text-muted-foreground h-5 w-5 shrink-0"
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">
                    {t(`${category}.label`)}
                  </span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {t(`${category}.description`)}
                  </span>
                </span>
                <Switch
                  checked={visibility[category]}
                  onCheckedChange={(checked) =>
                    setVisibility(category, checked)
                  }
                  aria-label={t(`${category}.toggle`)}
                />
              </label>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default TypeVisibilitySettings;
