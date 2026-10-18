// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { areaReportCsv, intersectAreaFeatures, loadedAreaLayers, modelAreaFootprint, type AreaReport, type Point2 } from "../area-check";
import { GeometryBuilder } from "../context-geometry";
import { polygonTriangles } from "../polygon-triangulation";
import { parseGeoJson } from "../geojson";
import { parseCityGml } from "../citygml";
import { parseCityJson, parseCityJsonClipped } from "../cityjson";
import { mapToWgs84 } from "../transform";
import type { CoordinateInfo } from "@/lib/ifc/types";

const box = (x0: number, y0: number, x1: number, y1: number): Point2[] => [[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
function polygon(rings: Point2[][], height = 0) {
  const builder = new GeometryBuilder();
  for (const triangle of polygonTriangles(rings.map((ring) => ring.map(([x,y]) => [x,y,height])))) {
    builder.triangle(...triangle, [1,1,1], {easting:0,northing:0,height:0});
  }
  builder.addFeature({id:"area",source:"GML",type:"Plot",properties:{}},0);
  return builder.finish();
}

describe("horizontal GIS area checks", () => {
  it("ignores elevation, preserves polygon holes, and includes partial overlaps and touches", () => {
    for (const height of [-10000, 0, 10000]) {
      const geometry = polygon([box(-10,-10,10,10), box(-3,-3,3,3)], height);
      const check = (footprint: Point2[]) => intersectAreaFeatures(geometry.positions, geometry.featureRanges, footprint);
      expect(check(box(-1,-1,1,1))).toEqual({areas:[0],matches:[]});
      expect(check(box(4,4,5,5)).matches).toEqual([0]);
      expect(check(box(9,9,12,12)).matches).toEqual([0]);
      expect(check(box(10,0,12,2)).matches).toEqual([0]);
      expect(check(box(11,0,12,2)).matches).toEqual([]);
    }
  });

  it("detects crossing areas even when no model corner is inside the area", () => {
    const geometry = polygon([box(-10,-.1,10,.1)]);
    expect(intersectAreaFeatures(geometry.positions, geometry.featureRanges, box(-1,-1,1,1)).matches).toEqual([0]);
  });

  it("preserves CityJSON courtyard holes in both whole-file and clipped reads", () => {
    for (const type of ["MultiSurface", "Solid"]) {
      const surface = [[0,1,2,3], [4,5,6,7]];
      const text = JSON.stringify({type:"CityJSON",metadata:{referenceSystem:"EPSG:3763"},
        vertices:[...box(-10,-10,10,10), ...box(-3,-3,3,3)].map(([x,y])=>[x-40000,y+180000,200]),
        CityObjects:{plot:{type:"LandUse",geometry:[{type,boundaries:type === "Solid" ? [[surface]] : [surface]}]}},
      });
      const reference=mapToWgs84({easting:-40000,northing:180000},3763);
      const clipped=parseCityJsonClipped(text,{targetEpsg:3763,radiusMetres:100,referenceLongitude:reference.longitude,referenceLatitude:reference.latitude});
      for(const geometry of [parseCityJson(text),clipped]) {
        expect(intersectAreaFeatures(geometry.positions,geometry.featureRanges!,box(-1,-1,1,1)).matches).toEqual([]);
        expect(intersectAreaFeatures(geometry.positions,geometry.featureRanges!,box(4,4,5,5)).matches).toEqual([0]);
      }
    }
  });

  it("does not fill a concave area's notch or use the footprint's axis-aligned envelope", () => {
    const geometry = polygon([[[0,0],[4,0],[4,1],[1,1],[1,4],[0,4]]]);
    expect(intersectAreaFeatures(geometry.positions, geometry.featureRanges, box(2,2,3,3)).matches).toEqual([]);
    const small = polygon([box(.9,.9,1,1)]);
    expect(intersectAreaFeatures(small.positions, small.featureRanges, [[0,-1],[1,0],[0,1],[-1,0]]).matches).toEqual([]);
  });

  it("excludes source points/lines inside mixed GeoJSON and GML features", () => {
    const geometry = parseGeoJson(JSON.stringify({type:"FeatureCollection",features:[{type:"Feature",geometry:{type:"GeometryCollection",geometries:[
      {type:"Point",coordinates:[-8.62,41.12]},
      {type:"LineString",coordinates:[[-8.62001,41.12],[-8.61999,41.12]]},
      {type:"Polygon",coordinates:[[[-8.61,41.12],[-8.609,41.12],[-8.609,41.121],[-8.61,41.12]]]},
    ]}}]}),3763);
    expect(geometry.featureRanges!.map((range) => range.area === false)).toEqual([true,false]);
    // The first vertex belongs to the point marker, far from the real polygon.
    const x=geometry.positions[0], y=-geometry.positions[2];
    expect(intersectAreaFeatures(geometry.positions,geometry.featureRanges!,box(x-.1,y-.1,x+.1,y+.1))).toEqual({areas:[0],matches:[]});
    const gml=parseCityGml(`<FeatureCollection xmlns:gml="http://www.opengis.net/gml"><member><Road><gml:LineString srsName="EPSG:3763"><gml:posList srsDimension="2">0 0 10 0</gml:posList></gml:LineString></Road></member></FeatureCollection>`,3763);
    expect(intersectAreaFeatures(gml.positions,gml.featureRanges!,box(-100,-100,100,100))).toEqual({areas:[],matches:[]});
  });

  it("uses model horizontal bounds with rotation, project units and RTC, independent of heights", () => {
    const coordinates: CoordinateInfo = {
      originShift:[100,7000,-200],hasLargeCoordinates:true,
      shiftedBounds:{min:[0,-9000,-10],max:[10,9000,0]},
      originalBounds:{min:[0,0,0],max:[0,0,0]},
    };
    const footprint=modelAreaFootprint(coordinates,{
      epsg:3763,lengthUnitScale:.001,
      conversion:{eastings:-40000,northings:180000,orthogonalHeight:9999,xAxisAbscissa:0,xAxisOrdinate:1,scale:.001},
    });
    expect(footprint).toEqual([[-40210,180100],[-40210,180110],[-40200,180110],[-40200,180100]]);
  });

  it("retains empty source layers in the loaded-data report", () => {
    const geometry={...polygon([box(0,0,1,1)]),origin:{easting:0,northing:0,height:0},epsg:3763,objectCount:1,types:[],sizeMetres:1,layers:["Empty","Plot"]};
    expect(loadedAreaLayers(geometry,"file").map((layer)=>layer.name)).toEqual(["Empty","Plot"]);
  });

  it("exports all metadata and incomplete statuses with valid, formula-safe CSV", () => {
    const report:AreaReport={model:"model.ifc",source:"City",epsg:3763,checkedAt:"2026-10-18T10:00:00Z",scope:"wfs",status:"cancelled",layers:[
      {name:"plots",title:"Plots",status:"matched",matches:[{id:"A",name:'Área, "A"',source:"WFS",type:"Plot",properties:{name:"=SUM(1,2)",note:"first\nsecond",count:0,active:false,nested:{tag:"x"}}}]},
      {name:"failed",title:"Failed",status:"error",error:"tooManyFeatures",matches:[]},
      {name:"next",title:"Next",status:"pending",matches:[]},
    ]};
    const csv=areaReportCsv(report);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain('"Área, ""A"""');
    expect(csv).toContain('"\'=SUM(1,2)"');
    expect(csv).toContain('"first\nsecond"');
    expect(csv).toContain('"false","0"');
    expect(csv).toContain('"{""tag"":""x""}"');
    expect(csv).toContain('"error","tooManyFeatures"');
    expect(csv).toContain('"pending"');
  });
});
