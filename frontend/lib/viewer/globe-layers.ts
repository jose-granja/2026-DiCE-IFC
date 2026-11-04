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

/**
 * The map draped over the terrain: Google Maps 2D, through Cesium ion
 * (ADR 003, amended 2026-11-04). Apart from the layer, so OSM Buildings and a
 * city model can sit on a road map or on satellite imagery alike.
 */
export const GLOBE_IMAGERY = ["roadmap", "satellite", "satellite-labels", "none"] as const;
export type GlobeImageryId = (typeof GLOBE_IMAGERY)[number];

/**
 * Cesium ion's Google Maps 2D assets. Global asset IDs, the same for every
 * ion account — read from `GET /v1/assets/{id}` with this deployment's token:
 * 3830182 "Google Maps 2D Satellite", 3830183 "… Satellite with Labels",
 * 3830184 "… Roadmap". ion proxies the tiles through
 * `assets.ion.cesium.com/proxy/<id>`, so no Google origin is needed.
 */
export const GOOGLE_2D_ASSETS: Record<Exclude<GlobeImageryId, "none">, { assetId: number; mapType: "roadmap" | "satellite" }> = {
  roadmap: { assetId: 3830184, mapType: "roadmap" },
  satellite: { assetId: 3830182, mapType: "satellite" },
  "satellite-labels": { assetId: 3830183, mapType: "satellite" },
};
