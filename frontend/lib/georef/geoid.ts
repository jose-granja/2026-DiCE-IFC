/**
 * EGM96 geoid undulation.
 *
 * `IfcSite.RefElevation` and `IfcMapConversion.OrthogonalHeight` are
 * "orthogonal height relative to the vertical datum specified" (IFC4x3
 * §8.18.3.6) — height above local mean sea level, in whatever vertical
 * datum the file's `IfcProjectedCRS.VerticalDatum` names (Cascais, NAP,
 * DHHN92, …). Cesium's globe wants the opposite: `Cartesian3.fromDegrees`
 * and its terrain providers both measure height above the **WGS84
 * ellipsoid**. The two surfaces are tens of metres apart almost everywhere
 * on land — the geoid grid below reads +53 m for mainland Portugal, meaning
 * a file's true ellipsoidal height is *higher* than its declared orthometric
 * one by that much.
 *
 * Skip this and the model still lands at the right latitude/longitude — only
 * the vertical axis is wrong — which is exactly the "position is fine, height
 * is off" symptom a plain map (2D, or one whose terrain tiles happen to be
 * sea-level-referenced already) never shows.
 *
 * The grid is NGA's public-domain EGM96 (`WW15MGH.GRD`, 15' spacing),
 * resampled here to 1° by keeping only the points that land on a whole
 * degree — every value is a real NGA-computed sample, not a re-interpolated
 * one. That keeps correction error within a metre or two almost everywhere
 * (worse only in the steepest mountain geoid gradients) for a 130 KB same-
 * origin asset, no network dependency beyond the app's own build.
 */

const GRID_URL = "/geoid/egm96-1deg.bin";
const ROWS = 181; // latitude 90° .. -90°, step -1°
const COLS = 360; // longitude 0° .. 359°, step 1°, wraps at 360°

export type Egm96Grid = Int16Array;

let gridPromise: Promise<Egm96Grid | null> | null = null;

async function fetchGrid(): Promise<Egm96Grid | null> {
  try {
    const response = await fetch(GRID_URL);
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== ROWS * COLS * 2) return null;
    return new Int16Array(buffer);
  } catch {
    // No grid is a worse correction, not a broken globe — callers treat a
    // null grid as "undulation unknown" and fall back to today's behaviour.
    return null;
  }
}

/** Start (or reuse) the grid fetch. Safe to call more than once. */
export function ensureEgm96Grid(): Promise<Egm96Grid | null> {
  gridPromise ??= fetchGrid();
  return gridPromise;
}

/** Undulation is stored as centimetres to fit one grid point in 2 bytes. */
function sample(grid: Egm96Grid, row: number, col: number): number {
  const wrappedCol = ((col % COLS) + COLS) % COLS;
  return (grid[row * COLS + wrappedCol] ?? 0) / 100;
}

/**
 * Geoid undulation N at (latitude, longitude), in metres — positive where
 * the geoid sits above the WGS84 ellipsoid. Bilinear across the 1° grid;
 * `grid === null` (not yet loaded, or failed to load) reads as 0, which is
 * the same as skipping the correction entirely.
 */
export function egm96Undulation(
  grid: Egm96Grid | null,
  latitude: number,
  longitude: number,
): number {
  if (!grid) return 0;

  const clampedLat = Math.max(-90, Math.min(90, latitude));
  const rowF = 90 - clampedLat; // 0 at the north pole, 180 at the south
  const colF = ((longitude % 360) + 360) % 360;

  const row0 = Math.min(Math.floor(rowF), ROWS - 2);
  const col0 = Math.floor(colF);
  const rowT = rowF - row0;
  const colT = colF - col0;

  const v00 = sample(grid, row0, col0);
  const v01 = sample(grid, row0, col0 + 1);
  const v10 = sample(grid, row0 + 1, col0);
  const v11 = sample(grid, row0 + 1, col0 + 1);

  return (
    v00 * (1 - colT) * (1 - rowT) +
    v01 * colT * (1 - rowT) +
    v10 * (1 - colT) * rowT +
    v11 * colT * rowT
  );
}

/**
 * Convert a height above the vertical datum's geoid (what IFC's
 * `OrthogonalHeight` / `RefElevation` measure) to height above the WGS84
 * ellipsoid (what Cesium measures). A `null` grid makes this the identity —
 * see {@link egm96Undulation}.
 */
export function toEllipsoidalHeight(
  grid: Egm96Grid | null,
  latitude: number,
  longitude: number,
  orthometricHeight: number,
): number {
  return orthometricHeight + egm96Undulation(grid, latitude, longitude);
}
