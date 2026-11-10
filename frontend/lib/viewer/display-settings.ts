"use client";

/**
 * Render style: light conditions, shadows, exposure and edge lines.
 *
 * A store rather than the popover's own state so a project folder can save it
 * and put it back, and so a renderer created later — after leaving the viewer
 * and coming back — starts with what the controls show instead of the defaults.
 *
 * The sun: when the models say where they are on the earth (`useSunPlaceStore`,
 * kept by `useSunPlaceSync`), it is where it would be there at `sunDate` and
 * `sunTime` in `sunTimeZone`; otherwise it is set by hand, `sunAzimuth` and
 * `sunElevation`. Both are kept, so a model with no place keeps the hand-set
 * sun whatever date a project carries.
 */

import { create } from "zustand";

import { DEFAULT_EDGE_WIDTH } from "./edges";
import { DEFAULT_LIGHT_PRESET, DEFAULT_SUN_AZIMUTH, LIGHT_RIGS, type LightPreset } from "./lighting";
import { DEFAULT_PROPERTY_DECIMALS } from "./property-format";
import { localTimeZone, renderSunAngles, solarPosition, todayIso, zonedTimeToUtc, type SolarPosition, type SunPlace } from "./sun";

export const DEFAULT_LIGHT_INTENSITY = 1;
export const DEFAULT_EXPOSURE = 0.75;
export const DEFAULT_SUN_TIME = "12:00";

export type DisplaySettingsValues = {
  lightPreset: LightPreset;
  sunAzimuth: number;
  sunElevation: number;
  /** For a model with a place: the site's date ("YYYY-MM-DD"), wall-clock time ("HH:MM") and IANA time zone. */
  sunDate: string;
  sunTime: string;
  sunTimeZone: string;
  shadows: boolean;
  lightIntensity: number;
  exposure: number;
  edgesOn: boolean;
  edgeWidth: number;
  propertyDecimalPlaces: number;
};

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettingsValues = {
  lightPreset: DEFAULT_LIGHT_PRESET,
  sunAzimuth: DEFAULT_SUN_AZIMUTH,
  sunElevation: LIGHT_RIGS[DEFAULT_LIGHT_PRESET].elevation,
  sunDate: todayIso(),
  sunTime: DEFAULT_SUN_TIME,
  sunTimeZone: localTimeZone(),
  shadows: false,
  lightIntensity: DEFAULT_LIGHT_INTENSITY,
  exposure: DEFAULT_EXPOSURE,
  edgesOn: true,
  edgeWidth: DEFAULT_EDGE_WIDTH,
  propertyDecimalPlaces: DEFAULT_PROPERTY_DECIMALS,
};

/** The part of the renderer these settings drive. */
export type DisplaySettingsTarget = {
  setLighting(options: { preset: LightPreset; sunAzimuth: number; sunElevation: number; shadows: boolean }): void;
  setLightIntensityScale(value: number): void;
  setExposure(value: number): void;
  setEdgeStyle(style: { width: number }): void;
};

/** Where the models are on the earth, when they say; see `useSunPlaceSync`. */
export const useSunPlaceStore = create<{ place: SunPlace | null; setPlace: (place: SunPlace | null) => void }>((set) => ({
  place: null,
  setPlace: (place) => set({ place }),
}));

/**
 * Where the sun is: at `place` on the date and time, or by hand without one.
 * `solar` is the true position (bearing from true north), for a place only;
 * `azimuth` and `elevation` are the renderer's (`lighting.ts`).
 */
export function sunFor(
  values: Pick<DisplaySettingsValues, "sunAzimuth" | "sunElevation" | "sunDate" | "sunTime" | "sunTimeZone">,
  place: SunPlace | null,
): { azimuth: number; elevation: number; solar: SolarPosition | null } {
  const when = place ? zonedTimeToUtc(values.sunDate, values.sunTime, values.sunTimeZone) : null;
  if (!place || !when) return { azimuth: values.sunAzimuth, elevation: values.sunElevation, solar: null };
  const solar = solarPosition(when, place.latitude, place.longitude);
  return { ...renderSunAngles(solar, place.north), solar };
}

export function applyDisplaySettings(
  target: DisplaySettingsTarget | null | undefined,
  values: DisplaySettingsValues,
  place: SunPlace | null = useSunPlaceStore.getState().place,
) {
  if (!target) return;
  const sun = sunFor(values, place);
  target.setLighting({
    preset: values.lightPreset,
    sunAzimuth: sun.azimuth,
    sunElevation: sun.elevation,
    shadows: values.shadows,
  });
  target.setLightIntensityScale(values.lightIntensity);
  target.setExposure(values.exposure);
  target.setEdgeStyle({ width: values.edgesOn ? values.edgeWidth : 0 });
}

type DisplaySettingsState = DisplaySettingsValues & {
  set: (patch: Partial<DisplaySettingsValues>) => void;
  reset: () => void;
};

export const useDisplaySettingsStore = create<DisplaySettingsState>((set) => ({
  ...DEFAULT_DISPLAY_SETTINGS,
  set: (patch) => set(patch),
  reset: () => set(DEFAULT_DISPLAY_SETTINGS),
}));

export function displaySettingsValues(state: DisplaySettingsValues): DisplaySettingsValues {
  return {
    lightPreset: state.lightPreset,
    sunAzimuth: state.sunAzimuth,
    sunElevation: state.sunElevation,
    sunDate: state.sunDate,
    sunTime: state.sunTime,
    sunTimeZone: state.sunTimeZone,
    shadows: state.shadows,
    lightIntensity: state.lightIntensity,
    exposure: state.exposure,
    edgesOn: state.edgesOn,
    edgeWidth: state.edgeWidth,
    propertyDecimalPlaces: state.propertyDecimalPlaces,
  };
}
