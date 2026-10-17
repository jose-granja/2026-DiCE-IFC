import { describe, expect, it, vi } from "vitest";

import { wgs84ToMap } from "../transform";
import { parseLargeGml } from "../gml-stream";

const TARGET_EPSG = 3763;
const REFERENCE = { longitude: -8.6226, latitude: 41.1188 };

function documentWith(...rings: string[]) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<core:CityModel xmlns:core="http://www.opengis.net/citygml/2.0"
  xmlns:gml="http://www.opengis.net/gml"
  srsName="EPSG:4326" srsDimension="3">
  ${rings.map((ring) => `<gml:Polygon><gml:exterior><gml:LinearRing>
    <gml:posList srsDimension="3">${ring}</gml:posList>
  </gml:LinearRing></gml:exterior></gml:Polygon>`).join("\n")}
</core:CityModel>`;
}

describe("parseLargeGml", () => {
  it("streams latitude/longitude GML and retains only geometry near the IFC", async () => {
    const progress = vi.fn();
    const result = await parseLargeGml(
      new Blob([documentWith(
        // EPSG:4326 in GML uses latitude, longitude axis order.
        "41.11880 -8.62260 20 41.11880 -8.62250 20 41.11890 -8.62250 20 41.11880 -8.62260 20",
        "42.00000 -7.00000 20 42.00000 -6.99990 20 42.00010 -6.99990 20 42.00000 -7.00000 20",
      )]),
      {
        targetEpsg: TARGET_EPSG,
        reference: REFERENCE,
        radiusMetres: 100,
        onProgress: progress,
      },
    );

    const expected = wgs84ToMap(REFERENCE, TARGET_EPSG);
    expect(result.objectCount).toBe(1);
    expect(result.positions.length).toBe(9);
    expect(Math.abs(result.origin.easting - expected.easting)).toBeLessThan(10);
    expect(Math.abs(result.origin.northing - expected.northing)).toBeLessThan(10);
    expect(result.sizeMetres).toBeGreaterThan(5);
    expect(result.sizeMetres).toBeLessThan(20);
    expect(progress).toHaveBeenLastCalledWith(100);
  });

  it("keeps an unfinished posList across chunk boundaries", async () => {
    const prefix = `<?xml version="1.0"?><core:CityModel
      xmlns:core="http://www.opengis.net/citygml/2.0"
      xmlns:gml="http://www.opengis.net/gml"
      srsName="EPSG:4326" srsDimension="3">
      <gml:Polygon><gml:exterior><gml:LinearRing>
      <gml:posList srsDimension="3">${" ".repeat(4 * 1024 * 1024)}`;
    const suffix =
      "41.11880 -8.62260 0 41.11880 -8.62250 0 41.11890 -8.62250 0 41.11880 -8.62260 0</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></core:CityModel>";

    const result = await parseLargeGml(new Blob([prefix, suffix]), {
      targetEpsg: TARGET_EPSG,
      reference: REFERENCE,
      radiusMetres: 100,
    });

    expect(result.objectCount).toBe(1);
    expect(result.positions.length).toBe(9);
  });

  it("reports when the selected area does not intersect the file", async () => {
    const blob = new Blob([documentWith(
      "42.00000 -7.00000 0 42.00000 -6.99990 0 42.00010 -6.99990 0 42.00000 -7.00000 0",
    )]);

    await expect(parseLargeGml(blob, {
      targetEpsg: TARGET_EPSG,
      reference: REFERENCE,
      radiusMetres: 100,
    })).rejects.toThrow(/No GML geometry was found within 100 m/);
  });
});

it("retains feature metadata after geometry and across split opening tags", async () => {
  const prefix = `<CityModel xmlns:gml="http://www.opengis.net/gml" srsName="EPSG:4326"><cityObjectMember><Building gml:id="A"><gml:name>School &amp; Library</gml:name><lod1Solid><gml:Polygon><gml:exterior><gml:LinearRing>`;
  const padding = " ".repeat(4 * 1024 * 1024 - prefix.length - 8);
  const ring = "41.11880 -8.62260 0 41.11880 -8.62250 0 41.11890 -8.62250 0 41.11880 -8.62260 0";
  const xml = `${prefix}${padding}<gml:posList>${ring}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></lod1Solid><measuredHeight uom="m">12</measuredHeight></Building></cityObjectMember></CityModel>`;
  const result = await parseLargeGml(new Blob([xml]), { targetEpsg: TARGET_EPSG, reference: REFERENCE, radiusMetres: 100 });
  expect(result.features).toEqual([{ id: "A", type: "Building", source: "CityGML / GML", name: "School & Library",
    properties: { name: "School & Library", "measuredHeight.@uom": "m", measuredHeight: "12" } }]);
  expect(result.featureRanges).toEqual([{ firstTriangle: 0, triangleCount: 1, featureIndex: 0 }]);
});

it("groups exterior and interior rings across chunks, clips whole polygons, and ignores lines", async () => {
  const ring = (role: string, points: string) => `<gml:${role}><gml:LinearRing><gml:posList>${points}</gml:posList></gml:LinearRing></gml:${role}>`;
  // The hole lies outside the clip centre but must still be subtracted from
  // the retained polygon. The second polygon has its own hole and metadata.
  const polygon = `<gml:Polygon srsDimension="2">${ring("exterior", "0 0 6 0 6 6 4 6 4 2 2 2 2 6 0 6 0 0")}
    ${" ".repeat(4 * 1024 * 1024)}${ring("interior", "0.5 3 1.5 3 1.5 4 0.5 4 0.5 3")}</gml:Polygon>`;
  const second = `<gml:Polygon srsDimension="2">${ring("interior", "21 1 22 1 22 2 21 2 21 1")}
    ${ring("exterior", "20 0 23 0 23 3 20 3 20 0")}</gml:Polygon>`;
  const xml = `<FeatureCollection xmlns:gml="http://www.opengis.net/gml" srsName="EPSG:3763" srsDimension="3">
    <member><Plot gml:id="A">${polygon}<label>Courtyard</label></Plot></member>
    <member><Plot gml:id="B">${second}</Plot></member>
    <gml:LineString><gml:posList>0 0 0 10 0 0 10 10 0</gml:posList></gml:LineString>
    </FeatureCollection>`;
  const reference = (await import("../transform")).mapToWgs84({ easting: 5, northing: 1 }, 3763);
  const options = { targetEpsg: 3763, reference, radiusMetres: 1 };
  const clipped = await parseLargeGml(new Blob([xml]), options);
  expect(clipped.objectCount).toBe(1);
  expect(clipped.features?.map((f) => f.id)).toEqual(["A"]);
  expect(clipped.features?.[0].properties.label).toBe("Courtyard");
  const all = await parseLargeGml(new Blob([xml]), { ...options, radiusMetres: 100 });
  expect(all.objectCount).toBe(2);
  expect(all.features?.map((f) => f.id)).toEqual(["A", "B"]);
  for (const [geometry, expectedArea] of [[clipped,27], [all,35]] as const) {
    const p = geometry.positions;
    let area = 0;
    for (let i = 0; i < p.length; i += 9) area += Math.abs((p[i+3]-p[i])*(p[i+8]-p[i+2])-(p[i+5]-p[i+2])*(p[i+6]-p[i]))/2;
    expect(area).toBeCloseTo(expectedArea);
  }
});

it("preserves vertical walls in the streamed mesh", async () => {
  const xml = documentWith("0 0 0 0 6 0 0 6 6 0 4 6 0 4 2 0 2 2 0 2 6 0 0 6 0 0 0").replace('EPSG:4326', 'EPSG:3763');
  const reference = (await import("../transform")).mapToWgs84({ easting: 0, northing: 0 }, 3763);
  const { positions: p } = await parseLargeGml(new Blob([xml]), { targetEpsg: 3763, reference, radiusMetres: 100 });
  let area = 0;
  for (let i = 0; i < p.length; i += 9) area += Math.abs((p[i+4]-p[i+1])*(p[i+8]-p[i+2])-(p[i+5]-p[i+2])*(p[i+7]-p[i+1]))/2;
  expect(area).toBeCloseTo(28);
});
