/**
 * Light conditions for the viewer: a few lighting rigs, and where the sun is.
 *
 * Intensities are in IFC Lite's convention (its shader multiplies the light
 * term directly); the renderer multiplies them by π for three's, which divides
 * by it. `studio` is IFC Lite's own rig and the default: even light from every
 * side, so no face of a model reads as black whichever way it is turned. The
 * others trade some of that for a look nearer the outdoors: one sun and the
 * sky, with the sun's shadows when they are on.
 */

export const LIGHT_PRESETS = ["studio", "clearSky", "overcast", "goldenHour"] as const;
export type LightPreset = (typeof LIGHT_PRESETS)[number];

type Rgb = [number, number, number];

export type LightRig = {
  /** Hemisphere light: the sky's colour above, the ground's below, and its strength. */
  sky: Rgb;
  ground: Rgb;
  hemisphere: number;
  /** Light from every direction alike. */
  ambient: number;
  sun: { colour: Rgb; intensity: number };
  /** A second sun opposite the first, so faces turned away are never left dark (studio only). */
  counterSun: number;
  /** Weak fixed lights that model faces the sun misses: a fill, its opposite, and a rim from behind. */
  fill: number;
  counterFill: number;
  rim: number;
  /** How dark the sun's shadows are: 1 blocks all of it, 0 shows none. */
  shadowStrength: number;
  /** The sun's height above the horizon this rig is set for, in degrees. */
  elevation: number;
};

// IFC Lite wraps its sun by 0.3: the wrapped part reaches every face, as ambient.
const STUDIO_SUN = 0.55 / 1.3;

export const LIGHT_RIGS: Record<LightPreset, LightRig> = {
  studio: {
    sky: [0.3, 0.35, 0.4],
    ground: [0.15, 0.1, 0.08],
    hemisphere: 0.25,
    ambient: 0.3 * STUDIO_SUN,
    sun: { colour: [1, 1, 1], intensity: STUDIO_SUN },
    counterSun: STUDIO_SUN,
    fill: 0.15,
    counterFill: 0.15,
    rim: 0.15,
    shadowStrength: 0.6,
    elevation: 60,
  },
  // A sunny day: a strong, slightly warm sun and a blue sky lighting the shade.
  clearSky: {
    sky: [0.55, 0.7, 1],
    ground: [0.4, 0.36, 0.3],
    hemisphere: 0.42,
    ambient: 0.04,
    sun: { colour: [1, 0.96, 0.9], intensity: 0.75 },
    counterSun: 0,
    fill: 0.06,
    counterFill: 0.04,
    rim: 0,
    shadowStrength: 0.85,
    elevation: 55,
  },
  // Cloud cover: nearly all the light from the sky, soft and even, faint shadows.
  overcast: {
    sky: [0.9, 0.92, 0.95],
    ground: [0.38, 0.36, 0.34],
    hemisphere: 0.55,
    ambient: 0.1,
    sun: { colour: [0.95, 0.97, 1], intensity: 0.12 },
    counterSun: 0,
    fill: 0.05,
    counterFill: 0,
    rim: 0,
    shadowStrength: 0.35,
    elevation: 65,
  },
  // Early morning or evening: a low, warm sun, long shadows and a cooler sky.
  goldenHour: {
    sky: [0.45, 0.55, 0.8],
    ground: [0.35, 0.25, 0.2],
    hemisphere: 0.35,
    ambient: 0.04,
    sun: { colour: [1, 0.72, 0.45], intensity: 0.85 },
    counterSun: 0,
    fill: 0.05,
    counterFill: 0,
    rim: 0,
    shadowStrength: 0.9,
    elevation: 12,
  },
};

export const DEFAULT_LIGHT_PRESET: LightPreset = "studio";
/** Degrees round the vertical from +Z toward +X; with the studio's 60° height, IFC Lite's own sun. */
export const DEFAULT_SUN_AZIMUTH = 60;
export const SUN_ELEVATION_RANGE = { min: 5, max: 90 } as const;

export function isLightPreset(value: unknown): value is LightPreset {
  return typeof value === "string" && (LIGHT_PRESETS as readonly string[]).includes(value);
}

/**
 * Unit vector toward the sun in the viewer's frame (Y up): `azimuth` degrees
 * round the vertical from +Z toward +X, `elevation` degrees above the horizon.
 */
export function sunDirection(azimuth: number, elevation: number): [number, number, number] {
  const a = (azimuth * Math.PI) / 180;
  const e = (Math.min(90, Math.max(-90, elevation)) * Math.PI) / 180;
  return [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)];
}
