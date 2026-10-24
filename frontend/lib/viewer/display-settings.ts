"use client";

/**
 * Render style: lighting, exposure and edge lines.
 *
 * A store rather than the popover's own state so a project folder can save it
 * and put it back, and so a renderer created later — after leaving the viewer
 * and coming back — starts with what the controls show instead of the defaults.
 */

import { create } from "zustand";

import { DEFAULT_EDGE_WIDTH } from "./edges";
import { DEFAULT_PROPERTY_DECIMALS } from "./property-format";

export const DEFAULT_LIGHT_INTENSITY = 1;
export const DEFAULT_EXPOSURE = 0.75;

export type DisplaySettingsValues = {
  lightIntensity: number;
  exposure: number;
  edgesOn: boolean;
  edgeWidth: number;
  propertyDecimalPlaces: number;
};

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettingsValues = {
  lightIntensity: DEFAULT_LIGHT_INTENSITY,
  exposure: DEFAULT_EXPOSURE,
  edgesOn: true,
  edgeWidth: DEFAULT_EDGE_WIDTH,
  propertyDecimalPlaces: DEFAULT_PROPERTY_DECIMALS,
};

/** The part of the renderer these settings drive. */
export type DisplaySettingsTarget = {
  setLightIntensityScale(value: number): void;
  setExposure(value: number): void;
  setEdgeStyle(style: { width: number }): void;
};

export function applyDisplaySettings(
  target: DisplaySettingsTarget | null | undefined,
  values: DisplaySettingsValues,
) {
  if (!target) return;
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
    lightIntensity: state.lightIntensity,
    exposure: state.exposure,
    edgesOn: state.edgesOn,
    edgeWidth: state.edgeWidth,
    propertyDecimalPlaces: state.propertyDecimalPlaces,
  };
}
