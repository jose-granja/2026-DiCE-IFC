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
