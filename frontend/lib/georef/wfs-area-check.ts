import type { AreaLayerResult, Point2 } from "./area-check";
import type { ContextGeometry } from "./context-geometry";
import { checkFeatureResponse, featureSnapshotFile, readFeatureSnapshot, type FeatureSnapshot } from "./context-features";
import { fetchOgc, layerRequest, OgcError, type OgcService } from "./ogc-service";
import { mapToWgs84 } from "./transform";

type CheckAreas = (geometry: ContextGeometry, footprint: Point2[], signal: AbortSignal) => Promise<{ areas: number[]; matches: number[] }>;

/** One explicit action checks every advertised layer, with bounded requests. */
export async function checkWfsAreas(
  service: OgcService,
  epsg: number,
  footprint: Point2[],
  signal: AbortSignal,
  checkAreas: CheckAreas,
  onLayer: (index: number, result: AreaLayerResult) => void,
) {
  const xs = footprint.map((p) => p[0]), ys = footprint.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const reference = mapToWgs84({ easting: (minX + maxX) / 2, northing: (minY + maxY) / 2 }, epsg);
  // Cover the full model footprint, irrespective of the single-layer load radius.
  const radius = Math.max(maxX - minX, maxY - minY) / 2 + 1;
  for (const [index, layer] of service.layers.entries()) {
    signal.throwIfAborted();
    const result: AreaLayerResult = { name: layer.name, title: layer.title, status: "noMatches", matches: [] };
    try {
      const request = layerRequest(service, layer, epsg, reference, radius);
      const text = await (await fetchOgc(request.url, signal)).text();
      signal.throwIfAborted();
      checkFeatureResponse(text);
      const snapshot: FeatureSnapshot = {
        type: "DiCEContextFeatures", version: 1, name: layer.title,
        attribution: layer.attribution, crs: request.crs, body: text,
      };
      const geometry = readFeatureSnapshot(JSON.stringify(snapshot), epsg);
      const checked = await checkAreas(geometry, footprint, signal);
      result.matches = checked.matches.map((i) => ({ ...geometry.features![i], layer: layer.name }));
      if (result.matches.length) result.view = { file: featureSnapshotFile(snapshot), featureIndices: checked.matches };
      result.status = result.matches.length ? "matched" : checked.areas.length ? "noMatches" : "noAreas";
      // Parsing omissions can hide an intersecting area; never call that complete.
      if (geometry.skippedObjects) { result.status = "error"; result.error = "skippedGeometry"; }
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof OgcError && error.code === "noFeatures")) {
        result.status = "error";
        result.error = error instanceof OgcError ? error.code : "invalidFeatureFile";
      }
    }
    onLayer(index, result);
  }
}
