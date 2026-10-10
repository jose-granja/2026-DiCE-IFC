// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { CityGmlError, epsgFromSrsName, parseCityGml } from "../citygml";

/**
 * CityGML and plain GML.
 *
 * The traps are namespaces that differ by version, two spellings of the same
 * coordinates, and the tuple size of a `posList` being declared rather than
 * implied.
 */

const EPSG = 3763;

/** A CityGML 2.0 building with one LoD2 wall surface, in PT-TM06. */
function building(options: {
  posList?: string;
  dimension?: number;
  srsName?: string;
  namespace?: string;
} = {}) {
  const ns = options.namespace ?? "http://www.opengis.net/citygml/2.0";
  const srs = options.srsName ?? "urn:ogc:def:crs:EPSG::3763";
  const dimension = options.dimension ?? 3;
  const posList =
    options.posList ??
    "-38000 165000 100 -37990 165000 100 -37990 165010 100 -38000 165000 100";

  return `<?xml version="1.0" encoding="UTF-8"?>
<CityModel xmlns="${ns}"
           xmlns:gml="http://www.opengis.net/gml"
           xmlns:bldg="http://www.opengis.net/citygml/building/2.0"
           srsName="${srs}" srsDimension="${dimension}">
  <gml:boundedBy>
    <gml:Envelope srsName="${srs}" srsDimension="${dimension}"/>
  </gml:boundedBy>
  <cityObjectMember>
    <bldg:Building gml:id="B1">
      <bldg:lod2Solid>
        <gml:Solid><gml:exterior><gml:CompositeSurface>
          <gml:surfaceMember>
            <gml:Polygon>
              <gml:exterior>
                <gml:LinearRing>
                  <gml:posList srsDimension="${dimension}">${posList}</gml:posList>
                </gml:LinearRing>
              </gml:exterior>
            </gml:Polygon>
          </gml:surfaceMember>
        </gml:CompositeSurface></gml:exterior></gml:Solid>
      </bldg:lod2Solid>
    </bldg:Building>
  </cityObjectMember>
</CityModel>`;
}

describe("epsgFromSrsName", () => {
  it("reads every spelling agencies actually publish", () => {
    expect(epsgFromSrsName("urn:ogc:def:crs:EPSG::3763")).toBe(3763);
    expect(epsgFromSrsName("EPSG:3763")).toBe(3763);
    expect(epsgFromSrsName("http://www.opengis.net/def/crs/EPSG/0/3763")).toBe(3763);
    expect(epsgFromSrsName(null)).toBeNull();
    expect(epsgFromSrsName("urn:ogc:def:crs:OGC::CRS84")).toBeNull();
  });
});

describe("parseCityGml", () => {
  it("reads a building's surfaces", () => {
    const result = parseCityGml(building(), EPSG);
    expect(result.objectCount).toBe(1);
    expect(result.types[0]).toEqual({ type: "Building", count: 1 });
    expect(result.positions.length).toBe(9); // one triangle
  });

  it("matches on local names, so any CityGML version reads", () => {
    // 1.0, 2.0 and 3.0 use different namespace URIs, and the GML core moved
    // too. A reader keyed on a namespace fails on half the files in the wild
    // for no useful reason.
    for (const namespace of [
      "http://www.opengis.net/citygml/1.0",
      "http://www.opengis.net/citygml/2.0",
      "http://www.opengis.net/citygml/3.0",
    ]) {
      expect(parseCityGml(building({ namespace }), EPSG).objectCount).toBe(1);
    }
  });

  it("honours the declared tuple size of a posList", () => {
    // `srsDimension` is declared, not implied. Reading 3D numbers as 2D pairs
    // silently produces geometry that is wrong in a way that still renders.
    const flat = parseCityGml(
      building({
        dimension: 2,
        posList: "-38000 165000 -37990 165000 -37990 165010 -38000 165000",
      }),
      EPSG,
    );

    const ys: number[] = [];
    for (let i = 1; i < flat.positions.length; i += 3) ys.push(flat.positions[i]);
    expect(Math.max(...ys)).toBeCloseTo(0, 6);
    expect(flat.sizeMetres).toBeGreaterThan(5);
    expect(flat.sizeMetres).toBeLessThan(30);
  });

  it("reads coordinates written as separate gml:pos elements", () => {
    // Older exporters write one point per element; newer ones run them
    // together. Files in the wild contain both, sometimes in one document.
    const xml = building().replace(
      /<gml:posList[^>]*>[^<]*<\/gml:posList>/,
      `<gml:pos>-38000 165000 100</gml:pos>
       <gml:pos>-37990 165000 100</gml:pos>
       <gml:pos>-37990 165010 100</gml:pos>
       <gml:pos>-38000 165000 100</gml:pos>`,
    );

    expect(parseCityGml(xml, EPSG).positions.length).toBe(9);
  });

  it("reads the legacy gml:coordinates syntax used by GML 2 exports", () => {
    const xml = building().replace(
      /<gml:posList[^>]*>[^<]*<\/gml:posList>/,
      `<gml:coordinates decimal="." cs="," ts=" ">
        -38000,165000,100 -37990,165000,100 -37990,165010,100 -38000,165000,100
      </gml:coordinates>`,
    );

    const result = parseCityGml(xml, EPSG);
    expect(result.positions.length).toBe(9);
    expect(result.sizeMetres).toBeCloseTo(10);
  });

  it("reads the legacy gml:coord X/Y/Z syntax", () => {
    const xml = building().replace(
      /<gml:posList[^>]*>[^<]*<\/gml:posList>/,
      `<gml:coord><gml:X>-38000</gml:X><gml:Y>165000</gml:Y><gml:Z>100</gml:Z></gml:coord>
       <gml:coord><gml:X>-37990</gml:X><gml:Y>165000</gml:Y><gml:Z>100</gml:Z></gml:coord>
       <gml:coord><gml:X>-37990</gml:X><gml:Y>165010</gml:Y><gml:Z>100</gml:Z></gml:coord>
       <gml:coord><gml:X>-38000</gml:X><gml:Y>165000</gml:Y><gml:Z>100</gml:Z></gml:coord>`,
    );

    expect(parseCityGml(xml, EPSG).positions.length).toBe(9);
  });

  it("keeps the GML source CRS when the IFC has no map placement", () => {
    const result = parseCityGml(building());
    expect(result.epsg).toBe(EPSG);
    expect(result.positions.length).toBe(9);
  });

  it("reads PolygonPatch surfaces used by generic GML application schemas", () => {
    const xml = building()
      .replace("<gml:Polygon>", "<gml:PolygonPatch>")
      .replace("</gml:Polygon>", "</gml:PolygonPatch>");
    expect(parseCityGml(xml, EPSG).positions.length).toBe(9);
  });

  it("drops interior rings rather than drawing across the hole", () => {
    const xml = building().replace(
      "</gml:exterior>",
      `</gml:exterior>
       <gml:interior><gml:LinearRing><gml:posList srsDimension="3">
         -37998 165002 100 -37996 165002 100 -37996 165004 100 -37998 165002 100
       </gml:posList></gml:LinearRing></gml:interior>`,
    );

    // Still one triangle: the hole is skipped, not fanned into the exterior.
    expect(parseCityGml(xml, EPSG).positions.length).toBe(9);
  });

  it("reprojects when the file's CRS differs from the model's", () => {
    // Same ground, declared in WGS84 rather than the national grid.
    const wgs = parseCityGml(
      building({
        srsName: "urn:ogc:def:crs:EPSG::4326",
        posList: "-8.6106 41.2882 100 -8.6104 41.2882 100 -8.6104 41.2884 100 -8.6106 41.2882 100",
      }),
      EPSG,
    );

    // Projected into PT-TM06 it must land in Portugal, not near the origin.
    expect(wgs.origin.easting).toBeGreaterThan(-60_000);
    expect(wgs.origin.easting).toBeLessThan(-20_000);
    expect(wgs.origin.northing).toBeGreaterThan(140_000);
    expect(wgs.origin.northing).toBeLessThan(200_000);
  });

  it("refuses a file that does not say what it is in", () => {
    // Guessing a CRS misplaces a city silently.
    const xml = building().replace(/srsName="[^"]*"/g, "");
    expect(() => parseCityGml(xml, EPSG)).toThrow(/does not say which coordinate/);
  });

  it("says what is wrong rather than rendering nothing", () => {
    expect(() => parseCityGml("<not-xml", EPSG)).toThrow(CityGmlError);
    expect(() =>
      parseCityGml('<?xml version="1.0"?><CityModel srsName="EPSG:3763"/>', EPSG),
    ).toThrow(/no gml:Polygon/);
  });
});
