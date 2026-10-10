/** Semantic IFC groups exposed by the viewer's visibility settings. */
export const TYPE_VISIBILITY_CATEGORIES = [
  "spaces",
  "spatialZones",
  "openings",
  "virtualElements",
  "site",
  "annotations",
  "grids",
] as const;

export type TypeVisibilityCategory =
  (typeof TYPE_VISIBILITY_CATEGORIES)[number];

export type TypeVisibilityState = Record<TypeVisibilityCategory, boolean>;

/**
 * IFC Lite-style first-load visibility. Volumes and void helpers obscure the
 * physical model, so they start hidden while spatial zones and context stay on.
 */
export const DEFAULT_TYPE_VISIBILITY: TypeVisibilityState = {
  spaces: false,
  spatialZones: true,
  openings: false,
  virtualElements: false,
  site: true,
  annotations: true,
  grids: true,
};

const IFC_TYPE_TO_CATEGORY: Record<string, TypeVisibilityCategory> = {
  IFCSPACE: "spaces",
  IFCSPATIALZONE: "spatialZones",
  IFCOPENINGELEMENT: "openings",
  IFCVIRTUALELEMENT: "virtualElements",
  IFCSITE: "site",
  IFCANNOTATION: "annotations",
  IFCGRID: "grids",
};

export function typeVisibilityCategory(
  ifcType: string | undefined,
): TypeVisibilityCategory | undefined {
  return ifcType
    ? IFC_TYPE_TO_CATEGORY[ifcType.replaceAll("_", "").toUpperCase()]
    : undefined;
}

export function defaultTypeVisibility(): TypeVisibilityState {
  return { ...DEFAULT_TYPE_VISIBILITY };
}
