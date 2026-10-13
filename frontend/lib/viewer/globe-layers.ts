/**
 * The 3D world context's layers, apart from the store so the project format can
 * name them without importing the globe.
 */
export const GLOBE_LAYERS = [
  "terrain",
  "osm-buildings",
  "google-photorealistic",
  "ion-asset",
  "tileset-url",
] as const;
export type GlobeLayerId = (typeof GLOBE_LAYERS)[number];
