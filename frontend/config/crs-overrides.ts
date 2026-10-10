/**
 * Corrections to the proj4 strings in `public/crs-index.json`, and how much to
 * trust each one.
 *
 * The index is generated from the `epsg-index` package. Its datum shifts are
 * not all fit for use: for Netherlands RD New it carries rotation terms that
 * move the Rotterdam Schiehaven site ~150 m (the same file placed correctly by
 * geo.buildingsmart.nl and ifcgref.bk.tudelft.nl), for Belgian Lambert 72 the
 * rotation signs are reversed, and ~300 systems name a datum-shift *grid file*
 * (`+nadgrids=BETA2007.gsb`, `OSTN15_NTv2_OSGBtoETRS.gsb`, …) that proj4js
 * cannot load here, which makes every transform return NaN.
 *
 * Both fixes live here, used by `scripts/build-crs-index.mts` when it writes the
 * index, so the generated file is right and the rule is visible in review.
 */

/** How well a transform to WGS84 can be trusted. */
export type CrsAccuracy =
  /** No datum shift needed (ETRS89, WGS84, NAD83, …): metre-level or better. */
  | "exact"
  /** A Helmert (seven-parameter) shift: typically within a few metres. */
  | "approximate"
  /** The datum has no shift defined at all: the result can be tens to hundreds of metres out. */
  | "uncertain"
  /** Needs a datum-shift grid file that is not bundled: not usable. */
  | "grid";

/**
 * Seven-parameter shifts to WGS84 (position-vector convention, which is what
 * proj4's `+towgs84` expects), replacing whatever the index has.
 *
 * Each is the standard set published by the national mapping agency / EPSG, and
 * each is pinned by a test against a known point (see
 * `lib/georef/__tests__/crs-index.test.ts`).
 */
export const TOWGS84_OVERRIDES: Record<number, string> = {
  // Amersfoort / RD New. Pinned: the Onze Lieve Vrouwetoren (RD 155000, 463000)
  // is 52.155172 N, 5.387206 E.
  28992: "565.4171,50.3319,465.5524,-0.398957,0.343988,-1.8774,4.0725",
  // BD72 / Belgian Lambert 72.
  31370: "-106.8686,52.2978,-103.7239,0.3366,-0.457,1.8422,-1.2747",
  // OSGB36 / British National Grid. Helmert is good to ~5 m; the OSTN15 grid
  // it replaces is centimetre-level but cannot be loaded here.
  27700: "446.448,-125.157,542.06,0.15,0.247,0.842,-20.489",
  // DHDN / 3-degree Gauss-Kruger zones 2–5 (Germany).
  31466: "598.1,73.7,418.2,0.202,0.045,-2.455,6.7",
  31467: "598.1,73.7,418.2,0.202,0.045,-2.455,6.7",
  31468: "598.1,73.7,418.2,0.202,0.045,-2.455,6.7",
  31469: "598.1,73.7,418.2,0.202,0.045,-2.455,6.7",
};

/** The proj4 string with the datum shift swapped for the override, if there is one. */
export function applyDatumOverride(code: number, proj4: string): string {
  const shift = TOWGS84_OVERRIDES[code];
  if (!shift) return proj4;
  const stripped = proj4
    .replace(/\s*\+towgs84=\S+/g, "")
    .replace(/\s*\+nadgrids=\S+/g, "")
    .replace(/\s*\+no_defs/, "");
  return `${stripped} +towgs84=${shift} +no_defs`.replace(/\s+/g, " ").trim();
}

export function classifyAccuracy(proj4: string): CrsAccuracy {
  if (/\+nadgrids=(?!@null)/.test(proj4)) return "grid";
  if (/\+towgs84=0,0,0,0,0,0,0(?:\s|$)/.test(proj4)) return "exact";
  if (/\+towgs84=/.test(proj4)) return "approximate";
  if (/\+datum=(WGS84|NAD83)/.test(proj4)) return "exact";
  if (/\+datum=/.test(proj4)) return "approximate";
  // GRS80 / WGS84 ellipsoids are the modern datums themselves.
  if (/\+ellps=(GRS80|WGS84)/.test(proj4) || /\+a=6378137 \+b=6378137/.test(proj4)) return "exact";
  return "uncertain";
}

export const ACCURACY_CODES: CrsAccuracy[] = ["exact", "approximate", "uncertain", "grid"];
