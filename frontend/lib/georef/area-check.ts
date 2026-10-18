import type { CoordinateInfo } from "@/lib/ifc/types";
import type { ContextFeature, ContextFeatureRange, ContextGeometry } from "./context-geometry";
import { localToMap, type Placement } from "./transform";

import type { ContextAppearance, ContextLayerFilter } from "@/lib/viewer/context-appearance";

export type AreaLayerSource = {
  file: File;
  /** Indices in the exact checked snapshot, aligned with matches. */
  featureIndices: number[];
  geometry?: ContextGeometry;
  appearance?: ContextAppearance;
  layer?: ContextLayerFilter;
};

export type Point2 = [number, number];
export type AreaLayerResult = {
  name: string;
  title: string;
  status: "pending" | "matched" | "noMatches" | "noAreas" | "error";
  matches: ContextFeature[];
  error?: string;
  view?: AreaLayerSource;
};
export type AreaReport = {
  model: string;
  source: string;
  epsg: number;
  checkedAt: string;
  scope: "wfs" | "loaded";
  status: "running" | "complete" | "cancelled";
  layers: AreaLayerResult[];
};

/** Four corners of the IFC's horizontal bounds in projected metres; no height. */
export function modelAreaFootprint(coordinates: CoordinateInfo, placement: Placement): Point2[] {
  const { min, max } = coordinates.shiftedBounds;
  return [[min[0], min[2]], [max[0], min[2]], [max[0], max[2]], [min[0], max[2]]].map(([x, z]) => {
    const map = localToMap({
      x: (x + coordinates.originShift[0]) / placement.lengthUnitScale,
      y: -(z + coordinates.originShift[2]) / placement.lengthUnitScale,
    }, placement);
    return [map.easting, map.northing];
  });
}

const cross = (a: Point2, b: Point2, c: Point2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Separating-axis test for convex footprints and triangles, including touches. */
function intersects(a: Point2[], b: Point2[]): boolean {
  for (const polygon of [a, b]) {
    for (let i = 0; i < polygon.length; i++) {
      const from = polygon[i], to = polygon[(i + 1) % polygon.length];
      const nx = from[1] - to[1], ny = to[0] - from[0];
      const length = Math.hypot(nx, ny);
      if (length === 0) continue;
      const project = (points: Point2[]) => points.map(([x, y]) => (x * nx + y * ny) / length);
      const pa = project(a), pb = project(b);
      if (Math.max(...pa) < Math.min(...pb) - 1e-6 || Math.max(...pb) < Math.min(...pa) - 1e-6) return false;
    }
  }
  return true;
}

/** Uses source polygon triangles, never point markers/line ribbons or height. */
export function intersectAreaFeatures(
  positions: Float32Array,
  ranges: ContextFeatureRange[],
  footprint: Point2[],
): { areas: number[]; matches: number[] } {
  if (footprint.length !== 4 || !footprint.flat().every(Number.isFinite)) throw new Error("invalidFootprint");
  const areas = new Set<number>(), matches = new Set<number>();
  const xs = footprint.map((p) => p[0]), ys = footprint.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  for (const range of ranges) {
    if (range.area === false || matches.has(range.featureIndex)) continue;
    for (let face = range.firstTriangle; face < range.firstTriangle + range.triangleCount; face++) {
      const index = face * 9;
      const triangle: Point2[] = [0, 3, 6].map((i) => [positions[index + i], -positions[index + i + 2]]);
      if (!triangle.flat().every(Number.isFinite) || Math.abs(cross(triangle[0], triangle[1], triangle[2])) < 1e-10) continue;
      areas.add(range.featureIndex);
      const tx = triangle.map((p) => p[0]), ty = triangle.map((p) => p[1]);
      if (Math.max(...tx) < minX - 1e-6 || Math.min(...tx) > maxX + 1e-6 || Math.max(...ty) < minY - 1e-6 || Math.min(...ty) > maxY + 1e-6) continue;
      if (intersects(footprint, triangle)) { matches.add(range.featureIndex); break; }
    }
  }
  return { areas: [...areas], matches: [...matches] };
}

export function contextLayerName(feature: ContextFeature, fallback: string): string {
  return feature.layer ?? (/GML|CityJSON/.test(feature.source) ? feature.type : fallback);
}

export function loadedAreaLayers(geometry: ContextGeometry, fallback: string): AreaLayerResult[] {
  return [...new Set([...(geometry.layers ?? []), ...(geometry.features ?? []).map((feature) => contextLayerName(feature, fallback))])].map((name) => ({ name, title: name, status: "pending", matches: [] }));
}

/** UTF-8/Excel-compatible CSV, with quoted metadata and spreadsheet-formula protection. */
export function areaReportCsv(report: AreaReport): string {
  const attributes = [...new Set(report.layers.flatMap((layer) => layer.matches.flatMap((feature) => Object.keys(feature.properties))))].sort();
  const cell = (value: unknown) => {
    let text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    if (typeof value === "string" && /^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const rows: unknown[][] = [["model", "source", "epsg", "checked_at", "report_status", "layer", "layer_title", "result", "error", "feature_id", "feature_name", ...attributes.map((name) => `attribute: ${name}`)]];
  for (const layer of report.layers) {
    for (const feature of layer.matches.length ? layer.matches : [null]) {
      rows.push([report.model, report.source, report.epsg, report.checkedAt, report.status, layer.name, layer.title, layer.status, layer.error ?? "", feature?.id, feature?.name,
        ...attributes.map((name) => feature?.properties[name])]);
    }
  }
  return `\uFEFF${rows.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}
