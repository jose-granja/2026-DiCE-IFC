import path from "node:path";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const IFC=path.resolve(__dirname,"../fixtures/ifc/georeferenced-wall-ifc4.ifc");
const GPKG=path.resolve(__dirname,"../fixtures/geopackage/curved-map.gpkg");
const names=["high-area","hole","lines","failed","partial"];
const capabilities=`<WFS_Capabilities version="2.0.0" xmlns:ows="http://www.opengis.net/ows/1.1" xmlns:xlink="http://www.w3.org/1999/xlink"><ows:ServiceIdentification><ows:Title>Planning survey</ows:Title></ows:ServiceIdentification><ows:OperationsMetadata><ows:Operation name="GetFeature"><ows:DCP><ows:HTTP><ows:Get xlink:href="https://maps.example.org/wfs"/></ows:HTTP></ows:DCP></ows:Operation></ows:OperationsMetadata><FeatureTypeList>${names.map((name)=>`<FeatureType><Name>${name}</Name><Title>${name}</Title><DefaultCRS>EPSG:3763</DefaultCRS></FeatureType>`).join("")}</FeatureTypeList></WFS_Capabilities>`;
const ring=(size:number)=>`<gml:LinearRing><gml:posList>${-40000-size} ${180000-size} 9000 ${-40000+size} ${180000-size} 9000 ${-40000+size} ${180000+size} 9000 ${-40000-size} ${180000+size} 9000 ${-40000-size} ${180000-size} 9000</gml:posList></gml:LinearRing>`;
const features=(kind:string)=>`<FeatureCollection xmlns:gml="http://www.opengis.net/gml" numberMatched="${kind === "partial" ? "99" : "1"}" numberReturned="1"><member><Area gml:id="parcel-A"><name>Planning zone</name><category>Residential</category><note>comma, and &quot;quote&quot;</note>${kind === "lines" ? '<gml:LineString srsName="EPSG:3763" srsDimension="2"><gml:posList>-40010 180000 -39990 180000</gml:posList></gml:LineString>' : `<gml:Polygon srsName="EPSG:3763" srsDimension="3"><gml:exterior>${ring(20)}</gml:exterior>${kind === "hole" ? `<gml:interior>${ring(10)}</gml:interior>` : ""}</gml:Polygon>`}</Area></member></FeatureCollection>`;
const report=(page:Page)=>page.locator("[data-gis-area-report]");
const layer=(page:Page,name:string)=>report(page).locator("[data-gis-area-layer]",{has:page.getByText(name,{exact:true})});

async function open(page:Page) {
  await page.goto("/viewer");
  await page.locator('input[type="file"]').first().setInputFiles(IFC);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({timeout:60000});
  await page.getByRole("tab",{name:"GIS",exact:true}).click();
}

/** Inspect the actual blue selection in the WebGL canvas, not store-only state. */
async function bluePixels(page:Page) {
  return page.evaluate(async()=>{
    await new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const canvas=document.querySelector<HTMLCanvasElement>("[data-model-canvas]")!;
    const copy=document.createElement("canvas");copy.width=canvas.width;copy.height=canvas.height;
    const ctx=copy.getContext("2d")!;ctx.drawImage(canvas,0,0);
    const pixels=ctx.getImageData(0,0,copy.width,copy.height).data;
    let blue=0;
    for(let i=0;i<pixels.length;i+=4)if(pixels[i+2]>pixels[i]+40 && pixels[i+2]>pixels[i+1]+20)blue++;
    return blue;
  });
}

test("checks every WFS layer in 2D, reports failures, exports metadata and keeps loaded context",async({page},testInfo)=>{
  const errors:string[]=[],requests:URL[]=[];
  page.on("pageerror",(error)=>errors.push(error.message));
  await open(page);
  // Existing context must remain in place; checking is independent of loading.
  await page.locator("[data-context-file-input]").setInputFiles({name:"existing.gml",mimeType:"application/xml",buffer:Buffer.from(features("high-area"))});
  await expect(page.locator("[data-context-model]")).toHaveAttribute("data-context-triangles","2");
  await page.route("**/api/ogc?**",async(route)=>{
    const url=new URL(new URL(route.request().url()).searchParams.get("url")!);requests.push(url);
    if(url.searchParams.get("TYPENAMES") === "failed") await route.fulfill({status:502,contentType:"application/json",body:JSON.stringify({error:"unreachable"})});
    else await route.fulfill({contentType:"application/xml",body:features(url.searchParams.get("TYPENAMES")!)});
  });
  await page.locator("[data-context-file-input]").setInputFiles({name:"planning.wfs",mimeType:"application/xml",buffer:Buffer.from(capabilities)});
  await expect(page.getByRole("combobox",{name:"Service layer"})).toBeVisible();
  // Area checking uses the model extent, not this unrelated layer-load radius.
  await page.getByRole("spinbutton",{name:"Area radius (m)"}).fill("1");
  await page.getByRole("button",{name:"Check all areas",exact:true}).click();
  await expect(report(page)).toContainText("5 / 5 layers checked · 1 matching area");
  await expect(layer(page,"high-area")).toContainText("1 matching area");
  await expect(layer(page,"hole")).toContainText("No intersecting areas");
  await expect(layer(page,"lines")).toContainText("No polygon areas");
  await expect(layer(page,"failed")).toContainText("could not be reached");
  await expect(layer(page,"partial")).toContainText("incomplete layer");
  await expect(report(page)).toContainText("georeferenced-wall-ifc4.ifc");
  expect(requests.map((url)=>url.searchParams.get("TYPENAMES"))).toEqual(names);
  const bbox=requests[0].searchParams.get("BBOX")!.split(",").map(Number);
  expect(bbox[2]-bbox[0]).toBeGreaterThan(5); // Full 5 m model bounds plus padding.
  await layer(page,"high-area").getByRole("button",{name:"Show matching areas"}).click();
  await report(page).locator("summary",{hasText:"Planning zone"}).click();
  await expect(report(page)).toContainText("Residential");
  await expect(report(page)).toContainText("Highlighted");
  await expect(report(page).getByText("Showing matching area…")).toHaveCount(0);
  await expect.poll(()=>bluePixels(page)).toBeGreaterThan(1000);
  // Reuses the checked response, even though the current single-layer radius is only 1 m.
  expect(requests).toHaveLength(names.length);
  const downloading=page.waitForEvent("download");
  await report(page).getByRole("button",{name:"Download CSV"}).click();
  const download=await downloading;
  const filename=testInfo.outputPath("areas.csv");await download.saveAs(filename);
  const csv=await readFile(filename,"utf8");
  expect(csv).toContain('"attribute: category"');
  expect(csv).toContain('"Residential"');
  expect(csv).toContain('"comma, and ""quote"""');
  expect(csv).toContain('"error","tooManyFeatures"');
  expect(csv).toContain('"noMatches"');
  await expect(page.locator("[data-context-model]")).toHaveAttribute("data-context-triangles","2");
  await page.screenshot({path:testInfo.outputPath("gis-area-report.png")});
  await page.getByRole("button",{name:"Close area report"}).click();
  await expect(report(page)).toHaveCount(0);
  await page.getByRole("button",{name:"Show area report"}).click();
  await expect(report(page)).toBeVisible();
  expect(errors).toEqual([]);
});

test("checks all loaded GeoPackage area layers even when hidden, excluding line labels",async({page},testInfo)=>{
  await open(page);
  let network=0;
  await page.route("**/api/ogc?**",async(route)=>{network++;await route.abort();});
  await page.locator("[data-context-file-input]").setInputFiles(GPKG);
  await expect(page.locator("[data-context-model]")).toBeAttached({timeout:30000});
  await page.getByRole("switch",{name:"Context model",exact:true}).click();
  await page.getByRole("button",{name:"Check loaded areas",exact:true}).click();
  await expect(report(page)).toContainText("3 / 3 layers checked · 2 matching areas");
  await expect(layer(page,"Land")).toContainText("1 matching area");
  await expect(layer(page,"Sea")).toContainText("1 matching area");
  await expect(layer(page,"Labels")).toContainText("No polygon areas");
  await expect(report(page).getByRole("button",{name:"Download CSV"})).toBeEnabled();
  await layer(page,"Sea").getByRole("button",{name:"Show matching areas"}).click();
  await layer(page,"Sea").locator("summary").click();
  await expect(page.getByRole("switch",{name:"Context model",exact:true})).toBeChecked();
  await expect(page.locator("[data-context-layer-filter]")).toContainText("Showing layer: Sea");
  await expect(layer(page,"Sea")).toContainText("Highlighted");
  await expect.poll(()=>bluePixels(page)).toBeGreaterThan(1000);
  // Replacing context after checking must not invalidate the report's feature indices.
  await page.locator("[data-context-file-input]").setInputFiles({name:"replacement.gml",mimeType:"application/xml",buffer:Buffer.from(features("high-area"))});
  await expect(page.locator("[data-context-layer-filter]")).toHaveCount(0);
  await layer(page,"Land").getByRole("button",{name:"Show matching areas"}).click();
  await layer(page,"Land").locator("summary").click();
  await expect(page.locator("[data-context-layer-filter]")).toContainText("Showing layer: Land");
  await expect(layer(page,"Land")).toContainText("Highlighted");
  await expect.poll(()=>bluePixels(page)).toBeGreaterThan(1000);
  await page.screenshot({path:testInfo.outputPath("gis-area-highlight.png")});
  await layer(page,"Sea").locator("summary").click();
  await expect(page.locator("[data-context-layer-filter]")).toContainText("Showing layer: Sea");
  await expect(layer(page,"Land")).not.toContainText("Highlighted");
  await page.getByRole("button",{name:"Show all layers",exact:true}).click();
  await expect(page.locator("[data-context-layer-filter]")).toHaveCount(0);
  expect(network).toBe(0);
});

test("cancels the all-layer check and leaves unchecked layers explicit in the report",async({page})=>{
  await open(page);
  let release!:()=>void;
  const held=new Promise<void>((resolve)=>{release=resolve;});
  const requests:string[]=[];
  await page.route("**/api/ogc?**",async(route)=>{
    const name=new URL(new URL(route.request().url()).searchParams.get("url")!).searchParams.get("TYPENAMES")!;
    requests.push(name);
    if(name === "hole") await held;
    await route.fulfill({contentType:"application/xml",body:features(name)}).catch(()=>{});
  });
  await page.locator("[data-context-file-input]").setInputFiles({name:"planning.wfs",mimeType:"application/xml",buffer:Buffer.from(capabilities)});
  await page.getByRole("button",{name:"Check all areas",exact:true}).click();
  await expect(layer(page,"high-area")).toContainText("1 matching area");
  await page.getByRole("tab",{name:"Geo",exact:true}).click();
  await page.getByRole("tab",{name:"GIS",exact:true}).click();
  await page.getByRole("button",{name:"Cancel area check",exact:true}).click();
  await expect(report(page)).toContainText("Check cancelled");
  await expect(layer(page,"hole")).toContainText("Not checked");
  await expect(page.getByRole("button",{name:"Check all areas",exact:true})).toBeEnabled();
  await expect(report(page).getByRole("button",{name:"Download CSV"})).toBeEnabled();
  release();
  expect(requests).toEqual(["high-area","hole"]);
});
