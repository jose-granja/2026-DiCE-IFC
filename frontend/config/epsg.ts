/**
 * The CRS registry.
 *
 * Bundled rather than fetched: looking a CRS up must work offline, and asking a
 * remote registry "which CRS is this model in" would leak roughly where the
 * project is — the one inference the privacy line exists to prevent.
 *
 * Portuguese systems come first and are complete, because this app is built for
 * PT practice and those are the ones that will actually be picked. The rest is a
 * short list of systems a Portuguese office plausibly receives files in.
 *
 * `proj4` strings are given explicitly. proj4js only knows WGS84 and a couple of
 * others out of the box; everything else has to be defined or it silently fails
 * to transform.
 */

export type CrsDefinition = {
  /** EPSG numeric code. */
  code: number;
  /** Short name, as it should appear in `IfcProjectedCRS.Name`. */
  name: string;
  /** Human label for the picker. */
  label: string;
  /** proj4 definition string. */
  proj4: string;
  /** Datum name, for `IfcProjectedCRS.GeodeticDatum`. */
  geodeticDatum: string;
  /** Region, used to group the picker. */
  region: "Portugal (mainland)" | "Azores" | "Madeira" | "Global" | "Europe";
  /** Rough validity area, so the UI can warn when a model lands far outside it. */
  bounds?: { west: number; south: number; east: number; north: number };
  /** Extra words to match on when searching. */
  aliases?: string[];
};

export const WGS84 = "EPSG:4326";
export const WGS84_PROJ4 = "+proj=longlat +datum=WGS84 +no_defs";

/**
 * Portugal's current official system. If a model has no CRS and the user is in
 * Portugal, this is the right default — hence `DEFAULT_EPSG` in `config/index.ts`.
 */
export const CRS_DEFINITIONS: CrsDefinition[] = [
  {
    code: 3763,
    name: "EPSG:3763",
    label: "ETRS89 / Portugal TM06",
    proj4:
      "+proj=tmerc +lat_0=39.6682583333333 +lon_0=-8.13310833333333 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
    geodeticDatum: "ETRS89",
    region: "Portugal (mainland)",
    bounds: { west: -9.56, south: 36.95, east: -6.19, north: 42.16 },
    aliases: ["PT-TM06", "TM06", "Portugal continental"],
  },
  {
    code: 27493,
    name: "EPSG:27493",
    label: "Datum 73 / Modified Portuguese Grid",
    proj4:
      "+proj=tmerc +lat_0=39.6666666666667 +lon_0=-8.13190611111111 +k=1 +x_0=180.598 +y_0=-86.98999999999999 +ellps=intl +towgs84=-223.237,110.193,36.649,0,0,0,0 +units=m +no_defs",
    geodeticDatum: "Datum 73",
    region: "Portugal (mainland)",
    bounds: { west: -9.56, south: 36.95, east: -6.19, north: 42.16 },
    aliases: ["Datum73", "D73", "Hayford-Gauss"],
  },
  {
    code: 20790,
    name: "EPSG:20790",
    label: "Lisbon (Lisbon) / Portuguese National Grid",
    proj4:
      "+proj=tmerc +lat_0=39.6666666666667 +lon_0=1 +k=1 +x_0=0 +y_0=0 +ellps=intl +towgs84=-304.046,-60.576,103.64,0,0,0,0 +pm=lisbon +units=m +no_defs",
    geodeticDatum: "Lisbon",
    region: "Portugal (mainland)",
    bounds: { west: -9.56, south: 36.95, east: -6.19, north: 42.16 },
    aliases: ["Hayford-Gauss", "Lisboa", "Datum Lisboa"],
  },
  {
    code: 5018,
    name: "EPSG:5018",
    label: "Lisbon / Portuguese Grid New",
    proj4:
      "+proj=tmerc +lat_0=39.6666666666667 +lon_0=-8.13190611111111 +k=1 +x_0=0 +y_0=0 +ellps=intl +towgs84=-304.046,-60.576,103.64,0,0,0,0 +units=m +no_defs",
    geodeticDatum: "Lisbon",
    region: "Portugal (mainland)",
    bounds: { west: -9.56, south: 36.95, east: -6.19, north: 42.16 },
    aliases: ["Hayford-Gauss Militar", "IgeoE"],
  },
  {
    code: 5013,
    name: "EPSG:5013",
    label: "PTRA08 / UTM zone 25N — Azores Western",
    proj4:
      "+proj=utm +zone=25 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
    geodeticDatum: "PTRA08",
    region: "Azores",
    bounds: { west: -31.34, south: 39.3, east: -31.02, north: 39.76 },
    aliases: ["Flores", "Corvo", "Acores ocidental"],
  },
  {
    code: 5014,
    name: "EPSG:5014",
    label: "PTRA08 / UTM zone 26N — Azores Central",
    proj4:
      "+proj=utm +zone=26 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
    geodeticDatum: "PTRA08",
    region: "Azores",
    bounds: { west: -28.9, south: 38.3, east: -26.97, north: 39.15 },
    aliases: ["Faial", "Pico", "Terceira", "Acores central"],
  },
  {
    code: 5015,
    name: "EPSG:5015",
    label: "PTRA08 / UTM zone 28N — Madeira",
    proj4:
      "+proj=utm +zone=28 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
    geodeticDatum: "PTRA08",
    region: "Madeira",
    bounds: { west: -17.31, south: 32.35, east: -16.23, north: 33.15 },
    aliases: ["Funchal", "Porto Santo"],
  },
  {
    code: 4326,
    name: "EPSG:4326",
    label: "WGS 84 — latitude / longitude",
    proj4: WGS84_PROJ4,
    geodeticDatum: "WGS84",
    region: "Global",
    aliases: ["GPS", "lat lon", "geographic"],
  },
  {
    code: 3857,
    name: "EPSG:3857",
    label: "WGS 84 / Pseudo-Mercator — web maps",
    proj4:
      "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs",
    geodeticDatum: "WGS84",
    region: "Global",
    aliases: ["web mercator", "google", "slippy"],
  },
  {
    code: 25829,
    name: "EPSG:25829",
    label: "ETRS89 / UTM zone 29N",
    proj4:
      "+proj=utm +zone=29 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
    geodeticDatum: "ETRS89",
    region: "Europe",
    bounds: { west: -12, south: 34.93, east: -6, north: 63.89 },
    aliases: ["UTM29", "Iberia"],
  },
  {
    code: 25830,
    name: "EPSG:25830",
    label: "ETRS89 / UTM zone 30N",
    proj4:
      "+proj=utm +zone=30 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
    geodeticDatum: "ETRS89",
    region: "Europe",
    bounds: { west: -6, south: 35.26, east: 0, north: 80.49 },
    aliases: ["UTM30", "Spain"],
  },
];

const BY_CODE = new Map(CRS_DEFINITIONS.map((crs) => [crs.code, crs]));

export function findCrs(code: number | null | undefined): CrsDefinition | null {
  return code === null || code === undefined ? null : (BY_CODE.get(code) ?? null);
}

/**
 * Search the registry. Matches the code, the label, the datum and the aliases,
 * so "TM06", "3763" and "Portugal" all find the same entry.
 */
export function searchCrs(query: string): CrsDefinition[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return CRS_DEFINITIONS;

  return CRS_DEFINITIONS.filter((crs) =>
    [
      String(crs.code),
      crs.name,
      crs.label,
      crs.geodeticDatum,
      crs.region,
      ...(crs.aliases ?? []),
    ].some((field) => field.toLowerCase().includes(needle)),
  );
}

/**
 * Resolve `IfcProjectedCRS.Name` to a registry EPSG code by its known name,
 * label or alias, for when the name carries no parseable EPSG number (see
 * `parseEpsgCode` in `lib/georef/logeoref.ts`, which tries that first).
 *
 * Matches in the opposite direction from `searchCrs`: here the *name* is the
 * long free-text field and a registry entry's `name`/`label`/alias is the
 * short thing to find inside it — "ETRS89 / Portugal TM06" (the exact label
 * IFC authoring tools write) must resolve, not just an exact equal string.
 * `region`/`geodeticDatum` are deliberately excluded — several entries share
 * a region or a datum, and matching on those would resolve an ambiguous name
 * to an arbitrary one of them. A name matching zero or more than one entry
 * returns null rather than guessing.
 */
export function resolveCrsByName(name: string | undefined): number | null {
  if (!name) return null;
  const haystack = name.trim().toLowerCase();
  if (!haystack) return null;

  const matches = CRS_DEFINITIONS.filter((crs) =>
    [crs.name, crs.label, ...(crs.aliases ?? [])].some((field) =>
      haystack.includes(field.toLowerCase()),
    ),
  );
  return matches.length === 1 ? matches[0].code : null;
}

/** Grouped for a picker, keeping the registry's deliberate ordering. */
export function groupCrsByRegion(
  list: CrsDefinition[] = CRS_DEFINITIONS,
): Array<{ region: CrsDefinition["region"]; items: CrsDefinition[] }> {
  const groups: Array<{ region: CrsDefinition["region"]; items: CrsDefinition[] }> = [];

  for (const crs of list) {
    const existing = groups.find((g) => g.region === crs.region);
    if (existing) existing.items.push(crs);
    else groups.push({ region: crs.region, items: [crs] });
  }
  return groups;
}

/**
 * Is a WGS84 position plausibly inside this CRS's area of use?
 *
 * Used to warn rather than to block: a model can legitimately sit just outside a
 * published validity area, but landing in the wrong hemisphere almost always
 * means the wrong CRS was chosen, and that is worth saying out loud.
 */
export function isWithinBounds(
  crs: CrsDefinition,
  longitude: number,
  latitude: number,
): boolean {
  if (!crs.bounds) return true;
  const { west, south, east, north } = crs.bounds;
  return (
    longitude >= west && longitude <= east && latitude >= south && latitude <= north
  );
}
