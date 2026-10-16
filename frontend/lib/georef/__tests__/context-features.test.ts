import { describe, expect, it } from "vitest";
import { ContextFeatureIndex, contextFeatureAt, type ContextFeature } from "../context-geometry";
import { parseGeoJson } from "../geojson";
import { parseCityJson, parseCityJsonClipped } from "../cityjson";
import { mapToWgs84 } from "../transform";

const feature = (id: string): ContextFeature => ({ id, type: "Building", source: "CityJSON", properties: {} });

describe("context feature identity", () => {
  it("maps disjoint surfaces to one feature and leaves missing ranges unselectable", () => {
    const index = new ContextFeatureIndex();
    const a = feature("a"), b = feature("b");
    index.add(a, 0, 2);
    index.add(b, 2, 5);
    index.add(a, 7, 9);
    index.add(feature("empty"), 9, 9);
    expect(index.features.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect([0, 1, 2, 4, 5, 6, 7, 8, 9, -1, NaN].map((face) => contextFeatureAt(index.featureRanges, face)))
      .toEqual([0, 0, 1, 1, null, null, 0, 0, null, null, null]);
  });

  it("keeps GeoJSON source ids and all property value types after skipping null geometry", () => {
    const properties = { name: "Parcel A", height: 8, count: 0, occupied: false, owner: null, details: { tags: ["A", "B"] } };
    const geometry = parseGeoJson(JSON.stringify({ type: "FeatureCollection", features: [
      { type: "Feature", id: "empty", geometry: null },
      { type: "Feature", id: 0, properties, geometry: { type: "Polygon", coordinates: [[[-8.61, 41.28], [-8.6099, 41.28], [-8.6099, 41.2801], [-8.61, 41.28]]] } },
    ] }), 3763);
    expect(geometry.features).toEqual([{ id: "0", name: "Parcel A", type: "Polygon", source: "GeoJSON", properties }]);
    expect(geometry.featureRanges).toEqual([{ firstTriangle: 0, triangleCount: geometry.positions.length / 9, featureIndex: 0 }]);
  });

  it("preserves CityObject keys and attributes in whole-file and clipped reads", () => {
    const id = 'building "A"';
    const properties = { name: "Office", year: 2026, active: false };
    const text = JSON.stringify({ type: "CityJSON", metadata: { referenceSystem: "EPSG:3763" },
      vertices: [[-40000, 180000, 0], [-39990, 180000, 0], [-39990, 180010, 0]],
      CityObjects: { [id]: { type: "Building", attributes: properties, geometry: [{ type: "MultiSurface", boundaries: [[[0, 1, 2]]] }] } } });
    const reference = mapToWgs84({ easting: -40000, northing: 180000 }, 3763);
    for (const geometry of [parseCityJson(text), parseCityJsonClipped(text, { referenceLongitude: reference.longitude, referenceLatitude: reference.latitude, radiusMetres: 100, targetEpsg: 3763 })]) {
      expect(geometry.features).toEqual([{ id, name: "Office", type: "Building", source: "CityJSON", properties }]);
      expect(contextFeatureAt(geometry.featureRanges!, 0)).toBe(0);
    }
  });
});
