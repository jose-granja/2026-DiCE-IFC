"use client";

import { useTranslations } from "next-intl";
import { Sun, SlidersHorizontal, SquareDashed } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { getActiveRenderer } from "@/lib/viewer/active-renderer";
import {
  DEFAULT_DISPLAY_SETTINGS,
  applyDisplaySettings,
  displaySettingsValues,
  useDisplaySettingsStore,
  type DisplaySettingsValues,
} from "@/lib/viewer/display-settings";

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
        <Button variant="ghost" size="sm" aria-label={t("buttonAriaLabel")}>
          <SlidersHorizontal className="h-4 w-4" aria-hidden />
          {t("button")}
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
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default DisplaySettings;
