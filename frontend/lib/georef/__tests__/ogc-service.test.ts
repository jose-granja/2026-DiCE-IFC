// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { capabilitiesUrl, layerRequest, readCapabilities, type OgcService } from "../ogc-service";
import { checkFeatureResponse, readFeatureSnapshot } from "../context-features";
import { mapGeometry } from "../context-map";
import { parseCityGml } from "../citygml";

const wms = `<WMS_Capabilities version="1.3.0" xmlns:xlink="http://www.w3.org/1999/xlink"><Service><Title>City maps</Title></Service><Capability>
  <Request><GetMap><Format>image/png</Format><DCPType><HTTP><Get><OnlineResource xlink:href="https://maps.example.org/wms?key=demo" /></Get></HTTP></DCPType></GetMap></Request>
  <Layer><CRS>EPSG:4326</CRS><Attribution><Title>© City survey</Title></Attribution><Layer><Name>blocks</Name><Title>Building map</Title></Layer></Layer></Capability></WMS_Capabilities>`;
const reference = {longitude:-8.62,latitude:41.12};

describe("OGC discovery and requests", () => {
  it("reads nested WMS layers with inherited CRS and attribution", () => {
    const service=readCapabilities(wms)!;
    expect(service.layers).toEqual([{name:"blocks",title:"Building map",crs:["EPSG:4326"],attribution:"© City survey"}]);
    expect(service.url).toBe("https://maps.example.org/wms?key=demo");
    expect(readCapabilities('<FeatureCollection/>')).toBeNull();
  });

  it("uses latitude/longitude for WMS 1.3 EPSG:4326, longitude/latitude for 1.1.1 and CRS:84", () => {
    const service=readCapabilities(wms)!;
    for(const [version,crs,swap] of [["1.3.0","EPSG:4326",true],["1.1.1","EPSG:4326",false],["1.3.0","CRS:84",false]] as const) {
      const request=layerRequest({...service,version},{...service.layers[0],crs:[crs]},3763,reference,100);
      const params=new URL(request.url).searchParams;
      const bbox=params.get("BBOX")!.split(",").map(Number);
      expect(bbox[0]).toBeCloseTo(swap ? 41.12 : -8.62,2);
      expect(params.get(version === "1.3.0" ? "CRS" : "SRS")).toBe(crs);
      expect(params.get("key")).toBe("demo");
    }
  });

  it("reads WFS 2.0 operations, layers and JSON output", () => {
    const service=readCapabilities(`<wfs:WFS_Capabilities xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ows="http://www.opengis.net/ows/1.1" xmlns:xlink="http://www.w3.org/1999/xlink" version="2.0.0">
      <ows:ServiceIdentification><ows:Title>Parcels</ows:Title></ows:ServiceIdentification><ows:OperationsMetadata><ows:Operation name="GetFeature"><ows:DCP><ows:HTTP><ows:Get xlink:href="https://maps.example.org/wfs" /></ows:HTTP></ows:DCP><ows:Parameter name="outputFormat"><ows:AllowedValues><ows:Value>application/json</ows:Value></ows:AllowedValues></ows:Parameter></ows:Operation></ows:OperationsMetadata>
      <wfs:FeatureTypeList><wfs:FeatureType><wfs:Name>city:parcels</wfs:Name><wfs:Title>Parcels</wfs:Title><wfs:DefaultCRS>urn:ogc:def:crs:EPSG::3763</wfs:DefaultCRS><wfs:OtherCRS>urn:ogc:def:crs:EPSG::4326</wfs:OtherCRS></wfs:FeatureType></wfs:FeatureTypeList></wfs:WFS_Capabilities>`)!;
    const request=layerRequest(service,service.layers[0],3763,reference,100);
    const params=new URL(request.url).searchParams;
    expect(params.get("TYPENAMES")).toBe("city:parcels");
    expect(params.get("COUNT")).toBe("10001");
    expect(params.get("OUTPUTFORMAT")).toBe("application/json");
    expect(params.get("SRSNAME")).toBe("urn:ogc:def:crs:EPSG::4326");
    expect(Number(params.get("BBOX")!.split(",")[0])).toBeCloseTo(41.12,2);
  });

  it("removes stale request/filter parameters while preserving provider keys", () => {
    const params=new URL(capabilitiesUrl("https://maps.example.org/wms?request=GetMap&LAYERS=old&bbox=1,2,3,4&filter=old&key=demo","WMS")).searchParams;
    expect([...params.entries()]).toEqual([["key","demo"],["SERVICE","WMS"],["REQUEST","GetCapabilities"]]);
  });

  it("uses WFS 1.0 names and bounds in x/y order", () => {
    const service:OgcService={kind:"WFS",version:"1.0.0",title:"Old WFS",url:"https://maps.example.org/wfs",formats:[],layers:[{name:"plots",title:"Plots",crs:["EPSG:4326"],attribution:"City"}]};
    const params=new URL(layerRequest(service,service.layers[0],3763,reference,50).url).searchParams;
    expect(params.get("TYPENAME")).toBe("plots");
    expect(params.get("MAXFEATURES")).toBe("10001");
    expect(Number(params.get("BBOX")!.split(",")[0])).toBeCloseTo(-8.62,2);
  });

  it("refuses service exceptions, unsupported versions and missing endpoints", () => {
    expect(()=>readCapabilities('<ServiceExceptionReport/>')).toThrow("serviceError");
    expect(()=>readCapabilities(wms.replace('version="1.3.0"','version="9.0"'))).toThrow("unsupportedVersion");
    expect(()=>readCapabilities(wms.replace(/<OnlineResource[^>]+\/>/,''))).toThrow("missingEndpoint");
  });
});

it("reads WFS points, lines, 2D polygons and metadata with geographic axis order", () => {
  const xml=`<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:gml="http://www.opengis.net/gml/3.2" srsName="urn:ogc:def:crs:EPSG::4326">
    <wfs:member><Tree gml:id="tree"><name>Oak</name><gml:Point><gml:pos>41.12 -8.62</gml:pos></gml:Point></Tree></wfs:member>
    <wfs:member><Road gml:id="road"><name>Main road</name><gml:LineString><gml:posList>41.12 -8.62 41.1201 -8.6199</gml:posList></gml:LineString></Road></wfs:member>
    <wfs:member><Plot gml:id="plot"><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>41.12 -8.62 41.12 -8.6199 41.1201 -8.6199 41.12 -8.62</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></Plot></wfs:member></wfs:FeatureCollection>`;
  const result=parseCityGml(xml,3763);
  expect(result.features?.map((f)=>f.id).sort()).toEqual(["plot","road","tree"]);
  expect(result.positions.length/9).toBe(5);
  expect(result.origin.easting).toBeLessThan(-30000);
  expect(result.origin.northing).toBeGreaterThan(150000);
  expect(result.sizeMetres).toBeLessThan(20);
  expect(result.features?.find((f)=>f.id === "tree")?.properties.name).toBe("Oak");
  const saved=readFeatureSnapshot(JSON.stringify({type:"DiCEContextFeatures",version:1,name:"Trees",attribution:"City",crs:"EPSG:4326",body:xml}),3763);
  expect(saved.attribution).toBe("City");
  expect(saved.features?.every((f)=>f.source === "WFS")).toBe(true);
});

it("rejects incomplete WFS downloads rather than hiding missing features", () => {
  expect(()=>checkFeatureResponse(JSON.stringify({type:"FeatureCollection",numberMatched:20,features:[{}]}))).toThrow("tooManyFeatures");
  expect(()=>checkFeatureResponse('<FeatureCollection numberMatched="20" numberReturned="10"/>')).toThrow("tooManyFeatures");
  expect(()=>checkFeatureResponse('<FeatureCollection numberReturned="0"/>')).toThrow("noFeatures");
  expect(()=>checkFeatureResponse('<FeatureCollection xmlns:gml="http://www.opengis.net/gml"><gml:featureMembers><Tree/><Tree/></gml:featureMembers></FeatureCollection>')).not.toThrow();
});

it("preserves WFS GeoJSON elevations for polygons, lines and points", () => {
  const body=JSON.stringify({type:"FeatureCollection",features:[
    {type:"Feature",geometry:{type:"Polygon",coordinates:[[[-8.62,41.12,190],[-8.6199,41.12,190],[-8.6199,41.1201,190],[-8.62,41.12,190]]]}},
    {type:"Feature",geometry:{type:"LineString",coordinates:[[-8.62,41.12,190],[-8.6199,41.1201,190]]}},
    {type:"Feature",geometry:{type:"Point",coordinates:[-8.62,41.12,190]}},
  ]});
  const result=readFeatureSnapshot(JSON.stringify({type:"DiCEContextFeatures",version:1,name:"Survey",attribution:"City",crs:"EPSG:4326",body}),3763);
  for(let i=1;i<result.positions.length;i+=3) expect(result.positions[i]+result.origin.height).toBe(190);
});

it("places a WMS grid with north at the top and metre offsets relative to the origin", () => {
  const g=mapGeometry({format:"dice-context-map",version:1,name:"Map",attribution:"Survey",sourceEpsg:3763,box:{minX:-40003,maxX:-39997,minY:179997,maxY:180003},height:190,mimeType:"image/png"},3763);
  expect(g.origin).toEqual({easting:-40000,northing:180000,height:190});
  expect([...g.positions.slice(0,3)]).toEqual([-3,0,-3]);
  expect([...g.uvs.slice(0,2)]).toEqual([0,1]);
  expect(g.sizeMetres).toBe(6);
  expect(g.features?.[0].type).toBe("WMS");
});
