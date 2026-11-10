/**
 * Where the sun is, for a date and time at the model's place on the earth.
 *
 * - `solarPosition`: NOAA's solar position equations (the ones behind its
 *   solar calculator): good to a few hundredths of a degree for any year
 *   between 1800 and 2100, far finer than a shadow on a building needs.
 * - `zonedTimeToUtc`: the time is the site's wall-clock time in an IANA time
 *   zone, so summer time is taken care of.
 * - `sunPlaceOf`: where a model is and which way true north points in the
 *   viewer's frame, from its `IfcMapConversion` or else its `IfcSite`
 *   latitude and longitude. A model with neither has no place, and the sun is
 *   set by hand (`lighting.ts`).
 */

import type { CoordinateInfo, GeoreferenceView } from "@/lib/ifc/types";
import { isCrsIndexLoaded } from "@/lib/georef/crs-index";
import { isTrivialMapConversion, resolveEpsgCode } from "@/lib/georef/logeoref";
import { gridConvergence, isSupportedCrs, mapToWgs84 } from "@/lib/georef/transform";
import { gridRotationAngle, ifcToRender, mapPositionOfRenderOrigin } from "./federation";

export { CLOCK_TIME, ISO_DATE, isTimeZone, localTimeZone, timeZones, todayIso, zonedTimeToUtc } from "./sun-time";

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export type SolarPosition = {
  /** Degrees clockwise from true north. */
  azimuth: number;
  /** Degrees above the horizon, with atmospheric refraction; negative once the sun has set. */
  elevation: number;
};

/** The sun's position at instant `when`, seen from `latitude`, `longitude` (degrees, east positive). */
export function solarPosition(when: Date, latitude: number, longitude: number): SolarPosition {
  const julianDay = when.getTime() / 86_400_000 + 2_440_587.5;
  const t = (julianDay - 2_451_545) / 36_525;

  const meanLongitude = (((280.46646 + t * (36_000.76983 + t * 0.0003032)) % 360) + 360) % 360;
  const meanAnomaly = 357.52911 + t * (35_999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const m = meanAnomaly * RAD;
  const centre =
    Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m) * 0.000289;
  const omega = (125.04 - 1934.136 * t) * RAD;
  const apparentLongitude = (meanLongitude + centre - 0.00569 - 0.00478 * Math.sin(omega)) * RAD;
  const meanObliquity = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = (meanObliquity + 0.00256 * Math.cos(omega)) * RAD;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(apparentLongitude));

  // Equation of time, minutes.
  const y = Math.tan(obliquity / 2) ** 2;
  const l0 = meanLongitude * RAD;
  const equationOfTime =
    4 *
    DEG *
    (y * Math.sin(2 * l0) -
      2 * eccentricity * Math.sin(m) +
      4 * eccentricity * y * Math.sin(m) * Math.cos(2 * l0) -
      0.5 * y * y * Math.sin(4 * l0) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * m));

  const minutesUtc = when.getUTCHours() * 60 + when.getUTCMinutes() + when.getUTCSeconds() / 60;
  const solarMinutes = (((minutesUtc + equationOfTime + 4 * longitude) % 1440) + 1440) % 1440;
  const hourAngle = (solarMinutes / 4 - 180) * RAD;

  const phi = latitude * RAD;
  const cosZenith = Math.min(
    1,
    Math.max(-1, Math.sin(phi) * Math.sin(declination) + Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle)),
  );
  const elevation = 90 - Math.acos(cosZenith) * DEG;
  const azimuth =
    ((Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(phi) - Math.tan(declination) * Math.cos(phi)) * DEG +
      180) %
      360 +
      360) %
    360;
  return { azimuth, elevation: elevation + refraction(elevation) };
}

/** Atmospheric refraction near the horizon (Bennett), degrees; it lifts the sun about half a degree at sunset. */
function refraction(elevation: number): number {
  if (elevation < -1) return 0;
  return 1.02 / Math.tan((elevation + 10.3 / (elevation + 5.11)) * RAD) / 60;
}

/** Where a model is on the earth, and which way true north points in the viewer's frame. */
export type SunPlace = {
  latitude: number;
  longitude: number;
  /** True north in the viewer's frame (Y up): its x and z, unit length. */
  north: [number, number];
  /** What the place was read from. */
  source: "mapConversion" | "site";
  modelId: string;
};

export type SunPlaceModel = {
  id: string;
  coordinates: CoordinateInfo;
  georeference: GeoreferenceView;
  /** The model's rotation about the viewer's vertical, radians (`ModelPlacement.rotationY`). */
  rotationY: number;
};

/**
 * Where `model` is and which way is north, or null when it says nothing about
 * either. `"needsCrsIndex"` when it names a CRS outside the bundled list: load
 * the full index (`loadCrsIndex`) and ask again.
 */
export function sunPlaceOf(model: SunPlaceModel): SunPlace | null | "needsCrsIndex" {
  const georeference = model.georeference;
  // In the model's own plan (IFC x, y): the direction of true north.
  let north: [number, number] | null = null;
  let latitude: number | undefined;
  let longitude: number | undefined;
  let source: SunPlace["source"] = "site";

  const conversion = georeference.mapConversion;
  // Eastings = northings = 0 is a placeholder no real site sits on (see GeorefPanels).
  if (conversion && !isTrivialMapConversion(conversion)) {
    const epsg = resolveEpsgCode(georeference.projectedCRS?.name);
    // A CRS not even the full index knows: the site's latitude and longitude, if any.
    if (epsg && !isSupportedCrs(epsg) && !isCrsIndexLoaded()) return "needsCrsIndex";
    const map = epsg && isSupportedCrs(epsg) ? mapPositionOfRenderOrigin({ id: model.id, name: "", coordinates: model.coordinates, georeference }) : null;
    if (epsg && map) {
      try {
        const point = { easting: map[0], northing: map[1] };
        const wgs = mapToWgs84(point, epsg);
        // The map conversion turns the model's plan by θ onto the grid, and
        // grid north is γ clockwise of true north there: true north in the
        // model's plan is at 90° + γ − θ, anticlockwise from its +x.
        const gamma = gridConvergence(point, epsg);
        const theta = gridRotationAngle({ id: model.id, name: "", coordinates: model.coordinates, georeference });
        if (Number.isFinite(wgs.latitude) && Number.isFinite(wgs.longitude) && Number.isFinite(gamma)) {
          latitude = wgs.latitude;
          longitude = wgs.longitude;
          north = [-Math.sin(gamma - theta), Math.cos(gamma - theta)];
          source = "mapConversion";
        }
      } catch {
        // A position the CRS cannot unproject: try the site instead.
      }
    }
  }

  if (!north) {
    latitude = georeference.site?.latitude;
    longitude = georeference.site?.longitude;
    if (latitude === undefined || longitude === undefined || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    // IFC's TrueNorth, which defaults to the model's +y.
    const declared = georeference.context?.trueNorth;
    const length = declared ? Math.hypot(declared[0], declared[1]) : 0;
    north = declared && length > 0 ? [declared[0] / length, declared[1] / length] : [0, 1];
  }
  if (latitude === undefined || longitude === undefined) return null;

  // Into the viewer's frame, then turned with the model about the vertical.
  const [x, , z] = ifcToRender([north[0], north[1], 0]);
  const cos = Math.cos(model.rotationY);
  const sin = Math.sin(model.rotationY);
  return {
    latitude,
    longitude,
    north: [x * cos + z * sin, -x * sin + z * cos],
    source,
    modelId: model.id,
  };
}

/**
 * A solar position as the renderer's sun angles (`lighting.ts`'s
 * `sunDirection`: degrees round the vertical from +Z toward +X, and height).
 */
export function renderSunAngles(position: SolarPosition, north: [number, number]): { azimuth: number; elevation: number } {
  const [nx, nz] = north;
  // East is north turned a quarter clockwise, seen from above (Y up).
  const ex = -nz;
  const ez = nx;
  const a = position.azimuth * RAD;
  const x = Math.sin(a) * ex + Math.cos(a) * nx;
  const z = Math.sin(a) * ez + Math.cos(a) * nz;
  const azimuth = ((Math.atan2(x, z) * DEG) % 360 + 360) % 360;
  return { azimuth, elevation: position.elevation };
}
