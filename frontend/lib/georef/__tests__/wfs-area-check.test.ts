// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { checkWfsAreas } from "../wfs-area-check";
import { fetchOgc, type OgcService } from "../ogc-service";
import { intersectAreaFeatures, type AreaLayerResult, type Point2 } from "../area-check";
import type { ContextGeometry } from "../context-geometry";

vi.mock("../ogc-service", async (original) => ({ ...await original<typeof import("../ogc-service")>(), fetchOgc:vi.fn() }));
afterEach(()=>vi.resetAllMocks());
const names=["first","empty","broken","points","last","unsupported","partial"];
const service:OgcService={kind:"WFS",version:"2.0.0",title:"Survey",url:"https://maps.example.org/wfs",formats:[],layers:names.map((name)=>({name,title:name,attribution:"City",crs:[name === "unsupported" ? "EPSG:99999" : "EPSG:3763"]}))};
const footprint:Point2[]=[[-40010,179990],[-39990,179990],[-39990,180010],[-40010,180010]];
const xml=(kind="polygon")=>`<FeatureCollection xmlns:gml="http://www.opengis.net/gml" numberMatched="1" numberReturned="1"><member><Plot gml:id="area"><name>Residential</name>${kind === "polygon" ? '<gml:Polygon srsName="EPSG:3763" srsDimension="3"><gml:exterior><gml:LinearRing><gml:posList>-40003 179997 9000 -39997 179997 9000 -39997 180003 9000 -40003 180003 9000 -40003 179997 9000</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon>' : '<gml:Point srsName="EPSG:3763"><gml:pos>-40000 180000</gml:pos></gml:Point>'}</Plot></member></FeatureCollection>`;
const check = async (geometry:ContextGeometry, points:Point2[]) => intersectAreaFeatures(geometry.positions,geometry.featureRanges!,points.map(([x,y])=>[x-geometry.origin.easting,y-geometry.origin.northing]));

it("checks all layers using the entire footprint and reports empty, non-area, failed and truncated layers separately",async()=>{
  const requests:URL[]=[];
  vi.mocked(fetchOgc).mockImplementation(async(url)=>{
    const request=new URL(url); requests.push(request);
    const name=request.searchParams.get("TYPENAMES");
    if(name === "broken")throw new Error("offline");
    const text=name === "empty" ? '<FeatureCollection numberReturned="0"/>' : name === "partial" ? xml().replace('numberMatched="1"','numberMatched="20000"') : xml(name === "points" ? "point" : "polygon");
    return {text:async()=>text} as Blob;
  });
  const results:AreaLayerResult[]=[];
  await checkWfsAreas(service,3763,footprint,new AbortController().signal,check,(_,result)=>results.push(result));
  expect(results.map((layer)=>layer.status)).toEqual(["matched","noMatches","error","noAreas","matched","error","error"]);
  expect(results.at(-1)?.error).toBe("tooManyFeatures");
  expect(results[5].error).toBe("unsupportedCrs");
  expect(results[0].matches[0]).toMatchObject({id:"area",layer:"first",properties:{name:"Residential"}});
  expect(results[0].view?.file.name).toBe("first.context-features");
  expect(results[0].view?.featureIndices).toEqual([0]);
  expect(results[1].view).toBeUndefined();
  expect(requests.map((request)=>request.searchParams.get("TYPENAMES"))).toEqual(names.filter((name)=>name !== "unsupported"));
  for(const request of requests){
    const bbox=request.searchParams.get("BBOX")!.split(",").slice(0,4).map(Number);
    [-40011,179989,-39989,180011].forEach((value,i)=>expect(bbox[i]).toBeCloseTo(value,6));
  }
});

it("stops after cancellation without requesting the remaining layers",async()=>{
  vi.mocked(fetchOgc).mockResolvedValue({text:async()=>xml()} as Blob);
  const controller=new AbortController(), results:AreaLayerResult[]=[];
  await expect(checkWfsAreas(service,3763,footprint,controller.signal,check,(_,result)=>{results.push(result);controller.abort();})).rejects.toThrow();
  expect(results).toHaveLength(1);
  expect(fetchOgc).toHaveBeenCalledTimes(1);
});
