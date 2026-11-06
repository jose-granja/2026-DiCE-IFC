"use client";

import { useTranslations } from "next-intl";
import { Sun, SlidersHorizontal, SquareDashed, ListChecks, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { MAX_PROPERTY_DECIMALS } from "@/lib/viewer/property-format";
import { getActiveRenderer } from "@/lib/viewer/active-renderer";
import {
  DEFAULT_DISPLAY_SETTINGS,
  applyDisplaySettings,
  displaySettingsValues,
  useDisplaySettingsStore,
  type DisplaySettingsValues,
} from "@/lib/viewer/display-settings";
import { SOURCE_NAMES } from "@/lib/viewer/realistic/store";
import { useRealisticStore } from "@/lib/viewer/realistic/store";

const LIGHT_INTENSITY_RANGE = { min: 0.4, max: 2, step: 0.05 };
const EXPOSURE_RANGE = { min: 0.4, max: 1.3, step: 0.05 };
const EDGE_WIDTH_RANGE = { min: 0.5, max: 5, step: 0.1 };

/** Controls render style on the existing scene without adding viewer objects. */
export function DisplaySettings() {
  const t = useTranslations("viewer.displaySettings");
  // The values live in a store so a project folder can save and restore them.
  const lightIntensity = useDisplaySettingsStore((s) => s.lightIntensity);
  const exposure = useDisplaySettingsStore((s) => s.exposure);
  const edgeWidth = useDisplaySettingsStore((s) => s.edgeWidth);
  const edgesOn = useDisplaySettingsStore((s) => s.edgesOn);
  const propertyDecimalPlaces = useDisplaySettingsStore((s) => s.propertyDecimalPlaces);
  const realistic = useRealisticStore();

  const change = (patch: Partial<DisplaySettingsValues>) => {
    const store = useDisplaySettingsStore.getState();
    store.set(patch);
    applyDisplaySettings(
      getActiveRenderer(),
      displaySettingsValues(useDisplaySettingsStore.getState()),
    );
  };

  const applyEdges = (on: boolean, width: number) => change({ edgesOn: on, edgeWidth: width });
  const onLightIntensityChange = (value: number) => change({ lightIntensity: value });
  const onExposureChange = (value: number) => change({ exposure: value });
  const reset = () => change(DEFAULT_DISPLAY_SETTINGS);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={t("buttonAriaLabel")} title={t("buttonAriaLabel")}>
          <SlidersHorizontal className="h-4 w-4" aria-hidden />
          <span className="sr-only lg:not-sr-only">{t("button")}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <h2 className="flex-1 text-sm font-semibold uppercase tracking-wide">
            {t("title")}
          </h2>
          <Button variant="ghost" size="xs" onClick={reset}>
            {t("reset")}
          </Button>
        </div>

        <div className="space-y-4 p-4">
          <div className="space-y-3">
            <h3 className="text-muted-foreground flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide">
              <Sun className="h-3.5 w-3.5" aria-hidden />
              {t("lightingHeading")}
            </h3>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-sm">{t("lightIntensityLabel")}</span>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {lightIntensity.toFixed(2)}×
                </span>
              </div>
              <Slider
                aria-label={t("lightIntensityLabel")}
                min={LIGHT_INTENSITY_RANGE.min}
                max={LIGHT_INTENSITY_RANGE.max}
                step={LIGHT_INTENSITY_RANGE.step}
                value={[lightIntensity]}
                onValueChange={([value]) => onLightIntensityChange(value)}
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-sm">{t("brightnessLabel")}</span>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {exposure.toFixed(2)}
                </span>
              </div>
              <Slider
                aria-label={t("brightnessLabel")}
                min={EXPOSURE_RANGE.min}
                max={EXPOSURE_RANGE.max}
                step={EXPOSURE_RANGE.step}
                value={[exposure]}
                onValueChange={([value]) => onExposureChange(value)}
              />
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-muted-foreground flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide">
                <SquareDashed className="h-3.5 w-3.5" aria-hidden />
                {t("edgesHeading")}
              </h3>
              <Switch
                aria-label={t("edgesToggle")}
                checked={edgesOn}
                onCheckedChange={(on) => applyEdges(on, edgeWidth)}
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-sm">{t("edgeWidthLabel")}</span>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {edgeWidth.toFixed(1)} px
                </span>
              </div>
              <Slider
                aria-label={t("edgeWidthLabel")}
                min={EDGE_WIDTH_RANGE.min}
                max={EDGE_WIDTH_RANGE.max}
                step={EDGE_WIDTH_RANGE.step}
                value={[edgeWidth]}
                disabled={!edgesOn}
                onValueChange={([value]) => applyEdges(true, value)}
              />
            </div>
          </div>

          {/* Not reset with the rest, and not saved in projects: it is the one
              setting here that reaches the network (lib/viewer/realistic/store.ts). */}
          <div className="space-y-2 border-t pt-4" data-realistic-settings>
            <div className="flex items-center justify-between">
              <h3 className="text-muted-foreground flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide">
                <Sparkles className="h-3.5 w-3.5" aria-hidden />
                {t("realisticHeading")}
              </h3>
              <Switch
                aria-label={t("realisticToggle")}
                checked={realistic.on}
                onCheckedChange={realistic.setOn}
              />
            </div>
            <p className="text-muted-foreground text-xs">{t("realisticHint")}</p>
            <p className="text-xs" role="status" data-realistic-summary>
              {realistic.status === "searching" &&
                (realistic.progress
                  ? t("realisticSearchingProgress", realistic.progress)
                  : t("realisticSearching"))}
              {realistic.status === "failed" && (
                <span className="text-destructive">{t("realisticFailed")}</span>
              )}
              {realistic.status === "ready" &&
                (realistic.applied.length
                  ? t("realisticApplied", {
                      textures: new Set(realistic.applied.map((line) => `${line.source}:${line.textureId}`)).size,
                      elements: realistic.texturedElements,
                    })
                  : t("realisticNone"))}
              {realistic.status === "ready" && realistic.unreachable.length > 0 && (
                <span className="text-muted-foreground block" data-realistic-unreachable>
                  {t("realisticUnreachable", { sources: realistic.unreachable.map((id) => SOURCE_NAMES[id]).join(", ") })}
                </span>
              )}
            </p>
            {realistic.status === "ready" && realistic.applied.length > 0 && (
              <ul className="max-h-32 space-y-0.5 overflow-auto text-xs" data-realistic-applied>
                {realistic.applied.map((line) => (
                  <li key={`${line.material}|${line.source}:${line.textureId}`} className="flex gap-1.5" data-relief={line.relief}>
                    <span className="min-w-0 flex-1 truncate" title={line.material}>{line.material}</span>
                    <a
                      href={line.page}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground min-w-0 max-w-[55%] truncate underline"
                      title={`${line.textureName} (${SOURCE_NAMES[line.source]}) · ${t(line.relief === "maps" ? "realisticReliefMaps" : "realisticReliefEstimated")}`}
                      data-texture-source={line.source}
                    >
                      {line.textureName}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-3 border-t pt-4">
            <h3 className="text-muted-foreground flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide">
              <ListChecks className="h-3.5 w-3.5" aria-hidden />
              {t("propertiesHeading")}
            </h3>
            <label className="flex items-center justify-between gap-3 text-sm">
              {t("decimalPlacesLabel")}
              <select
                className="border-input bg-background h-8 rounded-md border px-2 text-sm"
                value={propertyDecimalPlaces}
                onChange={(event) => change({ propertyDecimalPlaces: Number(event.target.value) })}
              >
                {Array.from({ length: MAX_PROPERTY_DECIMALS + 1 }, (_, digits) => <option key={digits} value={digits}>{digits}</option>)}
              </select>
            </label>
            <p className="text-muted-foreground text-xs">{t("decimalPlacesHint")}</p>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default DisplaySettings;
