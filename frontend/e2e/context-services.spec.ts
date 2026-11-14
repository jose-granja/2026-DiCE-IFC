import path from "node:path";
import { readFileSync } from "node:fs";
import { expect,test,type Page } from "@playwright/test";

const IFC=path.resolve(__dirname,"../fixtures/ifc/georeferenced-wall-ifc4.ifc");
const wfs=`<WFS_Capabilities version="2.0.0" xmlns:ows="http://www.opengis.net/ows/1.1" xmlns:xlink="http://www.w3.org/1999/xlink">
  <ows:ServiceIdentification><ows:Title>City survey</ows:Title></ows:ServiceIdentification><ows:OperationsMetadata><ows:Operation name="GetFeature"><ows:DCP><ows:HTTP><ows:Get xlink:href="https://maps.example.org/wfs"/></ows:HTTP></ows:DCP></ows:Operation></ows:OperationsMetadata>
  <FeatureTypeList><FeatureType><Name>city:plots</Name><Title>Survey plots</Title><DefaultCRS>EPSG:3763</DefaultCRS></FeatureType></FeatureTypeList></WFS_Capabilities>`;
const wms=`<WMS_Capabilities version="1.3.0" xmlns:xlink="http://www.w3.org/1999/xlink"><Service><Title>City survey</Title></Service><Capability><Request><GetMap><Format>image/png</Format><DCPType><HTTP><Get><OnlineResource xlink:href="https://maps.example.org/wms"/></Get></HTTP></DCPType></GetMap></Request><Layer><CRS>EPSG:3763</CRS><Attribution><Title>© City survey</Title></Attribution><Layer><Name>map</Name><Title>Survey map</Title></Layer></Layer></Capability></WMS_Capabilities>`;
const wmsWithLegend=wms.replace("<Title>Survey map</Title>",`<Title>Survey map</Title><Style><Name>survey</Name><LegendURL><Format>image/png</Format><OnlineResource xlink:href="https://maps.example.org/wms?SERVICE=WMS&amp;REQUEST=GetLegendGraphic&amp;FORMAT=image/png&amp;LAYER=map&amp;STYLE=survey"/></LegendURL></Style>`);
const features=`<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:gml="http://www.opengis.net/gml/3.2" numberMatched="1" numberReturned="1"><wfs:member><Plot gml:id="plot"><name>West plot</name><zone>Residential</zone><gml:Polygon srsName="EPSG:3763" srsDimension="3"><gml:exterior><gml:LinearRing><gml:posList>-40003 179997 190 -39997 179997 190 -39997 180003 190 -40003 180003 190 -40003 179997 190</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></Plot></wfs:member></wfs:FeatureCollection>`;

async function open(page:Page, rotated = false) {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]',rotated ? {
    name: "georeferenced-wall-ifc4.ifc", mimeType: "application/x-step",
    buffer: Buffer.from(readFileSync(IFC,"utf8").replace(
      "#91= IFCMAPCONVERSION(#15,#90,-40000.,180000.,190.,1.,0.,1.);",
      "#91= IFCMAPCONVERSION(#15,#90,-40000.,180000.,190.,0.,1.,1.);",
    )),
  } : IFC);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({timeout:60000});
  await page.getByRole("button",{name:"Top view",exact:true}).press("Enter");
  await page.getByRole("button",{name:"Orthographic",exact:true}).click();
  await page.getByRole("tab",{name:"Models",exact:true}).click();
  await page.getByRole("button",{name:"Hide georeferenced-wall-ifc4.ifc",exact:true}).click();
  await page.getByRole("tab",{name:"GIS",exact:true}).click();
}
async function pixel(page:Page,x:number,y:number) {
  return page.evaluate(async({x,y})=>{
    await new Promise((r)=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const source=document.querySelector<HTMLCanvasElement>("[data-model-canvas]")!;
    const copy=document.createElement("canvas");copy.width=source.width;copy.height=source.height;
    const ctx=copy.getContext("2d")!;ctx.drawImage(source,0,0);
    return [...ctx.getImageData(Math.floor(x*copy.width),Math.floor(y*copy.height),1,1).data];
  },{x,y});
}

test("opens a saved WFS capabilities file without networking, then loads and inspects its layer",async({page})=>{
  const requests:URL[]=[];
  await page.route("**/api/ogc?**",async(route)=>{
    const url=new URL(new URL(route.request().url()).searchParams.get("url")!);requests.push(url);
    await route.fulfill({contentType:"application/xml",body:features});
  });
  await open(page);
  await page.locator("[data-context-file-input]").setInputFiles({name:"survey.wfs",mimeType:"application/xml",buffer:Buffer.from(wfs)});
  await expect(page.getByRole("combobox",{name:"Service layer"})).toContainText("Survey plots");
  expect(requests).toHaveLength(0);
  await page.getByRole("spinbutton",{name:"Area radius (m)"}).fill("3");
  await page.getByRole("button",{name:"Load selected layer"}).click();
  await expect(page.locator("[data-context-model]")).toBeAttached();
  expect(requests).toHaveLength(1);
  expect(requests[0].searchParams.get("TYPENAMES")).toBe("city:plots");
  const bbox=requests[0].searchParams.get("BBOX")!.split(",");
  [-40003,179997,-39997,180003].forEach((value,i)=>expect(Number(bbox[i])).toBeCloseTo(value,6));
  expect(bbox[4]).toBe("EPSG:3763");
  await page.getByRole("combobox",{name:"Colour by property"}).click();
  await page.getByRole("option",{name:"zone",exact:true}).click();
  await expect(page.getByLabel("Colour for Residential",{exact:true})).toBeVisible();
  const canvas=page.locator("[data-model-canvas]");
  const box=(await canvas.boundingBox())!;
  // Wait for the property Select's dismissal to release pointer events.
  await canvas.click({position:{x:box.width*.25,y:box.height*.35}});
  await expect(page.locator("[data-context-properties]")).toContainText("West plot");
  await expect(page.locator("[data-context-properties]")).toContainText("WFS");
  await page.getByRole("tab",{name:"Models",exact:true}).click();
  await expect(page.locator("[data-context-attribution]")).toContainText("City survey");
});

test("aligns a WFS layer with distant polygon bounds to a rotated IFC model",async({page})=>{
  await open(page,true);
  // A BBOX-filtered feature may include distant parts. Move the geometry origin
  // kilometres away while keeping the surveyed plot at the same map location.
  const polygon=features.match(/<gml:Polygon[\s\S]*?<\/gml:Polygon>/)![0];
  const distant=polygon.replace(/179997/g,"189997").replace(/180003/g,"190003");
  const multipart=features.replace(polygon,`<gml:MultiSurface srsName="EPSG:3763"><gml:surfaceMember>${polygon}</gml:surfaceMember><gml:surfaceMember>${distant}</gml:surfaceMember></gml:MultiSurface>`);
  await page.route("**/api/ogc?**",route=>route.fulfill({contentType:"application/xml",body:multipart}));
  await page.locator("[data-context-file-input]").setInputFiles({name:"survey.wfs",mimeType:"application/xml",buffer:Buffer.from(wfs)});
  await page.getByRole("button",{name:"Load selected layer"}).click();
  await expect(page.locator("[data-context-model]")).toHaveAttribute("data-context-triangles","4");
  const canvas=page.locator("[data-model-canvas]");
  const box=(await canvas.boundingBox())!;
  await canvas.click({position:{x:box.width*.5,y:box.height*.5}});
  await expect(page.locator("[data-context-properties]")).toContainText("West plot");
  await expect(page.locator("[data-context-properties]")).toContainText("WFS");
});

test("loads a WMS map and its style legend, and restores both offline",async({page,browser},testInfo)=>{
  test.setTimeout(90000);
  await page.addInitScript(()=>Object.defineProperty(window,"showDirectoryPicker",{value:undefined,configurable:true}));
  await open(page);
  const encoded=await page.evaluate(()=>{
    const canvas=document.createElement("canvas");canvas.width=64;canvas.height=64;
    const ctx=canvas.getContext("2d")!;ctx.fillStyle="#ff0000";ctx.fillRect(0,0,64,32);ctx.fillStyle="#0000ff";ctx.fillRect(0,32,64,32);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const legendEncoded=await page.evaluate(()=>{
    const canvas=document.createElement("canvas");canvas.width=240;canvas.height=60;
    const ctx=canvas.getContext("2d")!;ctx.fillStyle="white";ctx.fillRect(0,0,240,60);
    ctx.fillStyle="#ff0000";ctx.fillRect(8,8,20,16);ctx.fillStyle="#0000ff";ctx.fillRect(8,36,20,16);
    ctx.fillStyle="black";ctx.font="14px sans-serif";ctx.fillText("North zone",36,22);ctx.fillText("South zone",36,50);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const requests:URL[]=[];
  await page.route("**/api/ogc?**",async(route)=>{
    const url=new URL(new URL(route.request().url()).searchParams.get("url")!);requests.push(url);
    if(url.searchParams.get("REQUEST") === "GetCapabilities")await route.fulfill({contentType:"application/xml",body:wmsWithLegend});
    else if(url.searchParams.get("REQUEST") === "GetLegendGraphic") {
      expect(new URL(route.request().url()).searchParams.get("legend")).toBe("1");
      await route.fulfill({contentType:"image/png",body:Buffer.from(legendEncoded,"base64")});
    }
    else await route.fulfill({contentType:"image/png",body:Buffer.from(encoded,"base64")});
  });
  await page.getByRole("button",{name:"Add WFS / WMS service"}).click();
  await page.getByRole("combobox",{name:"Service type"}).click();
  await page.getByRole("option",{name:"WMS",exact:true}).click();
  await page.getByRole("textbox",{name:"Service URL"}).fill("https://maps.example.org/wms");
  await page.getByRole("button",{name:"Read layers"}).click();
  await expect(page.getByRole("combobox",{name:"Service layer"})).toContainText("Survey map");
  expect(requests).toHaveLength(1); // Discovery alone never downloads legends.
  await page.getByRole("spinbutton",{name:"Area radius (m)"}).fill("3");
  await page.getByRole("button",{name:"Load selected layer"}).click();
  await expect(page.locator("[data-context-model]")).toBeAttached();
  const north=await pixel(page,.5,.35),south=await pixel(page,.5,.65);
  expect(north[0]).toBeGreaterThan(north[2]+150);
  expect(south[2]).toBeGreaterThan(south[0]+150);
  expect(requests).toHaveLength(3);
  expect(requests[1].searchParams.get("CRS")).toBe("EPSG:3763");
  expect(requests[1].searchParams.get("STYLES")).toBe("survey");
  expect(requests[2].searchParams.get("STYLE")).toBe("survey");
  const legendImage=page.getByRole("img",{name:"Legend for Survey map",exact:true});
  await expect(legendImage).toBeVisible();
  await expect.poll(()=>legendImage.evaluate((image)=>(image as HTMLImageElement).naturalWidth)).toBe(240);
  await page.getByRole("button",{name:"Map legend",exact:true}).click();
  await expect(legendImage).not.toBeVisible();
  await page.getByRole("button",{name:"Map legend",exact:true}).click();
  await expect.poll(()=>legendImage.evaluate((image)=>(image as HTMLImageElement).naturalWidth)).toBe(240);
  await expect(page.locator("[data-context-attribution]")).toContainText("© City survey");
  await expect(page.getByRole("combobox",{name:"Colour by property"})).toHaveCount(0);
  await page.getByRole("switch",{name:"Context model",exact:true}).click();
  await expect(page.locator("[data-context-attribution]")).toHaveCount(0);
  await expect(page.locator("[data-context-map-legend]")).toHaveCount(0);
  await page.getByRole("switch",{name:"Context model",exact:true}).click();
  await expect(legendImage).toBeVisible();
  await page.getByRole("tab",{name:"Geo",exact:true}).click();
  await page.getByRole("tab",{name:"GIS",exact:true}).click();
  await expect.poll(()=>legendImage.evaluate((image)=>(image as HTMLImageElement).naturalWidth)).toBe(240);
  expect(requests).toHaveLength(3);
  expect(await pixel(page,.5,.35)).toEqual(north);
  await page.locator("[data-context-map-legend]").scrollIntoViewIfNeeded();
  await page.screenshot({path:testInfo.outputPath("wms-context.png")});
  await page.locator("[data-project-menu]").click();
  const downloading=page.waitForEvent("download");
  await page.getByRole("menuitem",{name:"Save project (.zip)…"}).click();
  const download=await downloading;const zip=testInfo.outputPath("wms-project.zip");await download.saveAs(zip);
  const context=await browser.newContext();
  try {
    const fresh=await context.newPage();let network=0;
    await fresh.route("**/api/ogc?**",async(route)=>{network++;await route.abort();});
    await fresh.goto("/viewer");await fresh.locator("[data-project-zip-input]").setInputFiles(zip);
    await expect(fresh.locator("[data-context-model]")).toBeAttached({timeout:60000});
    expect(await pixel(fresh,.5,.35)).toEqual(north);
    await expect(fresh.locator("[data-context-attribution]")).toContainText("© City survey");
    await fresh.getByRole("tab",{name:"GIS",exact:true}).click();
    const restoredLegend=fresh.getByRole("img",{name:"Legend for Survey map",exact:true});
    await expect(restoredLegend).toBeVisible();
    await expect.poll(()=>restoredLegend.evaluate((image)=>(image as HTMLImageElement).naturalWidth)).toBe(240);
    expect(network).toBe(0);
  } finally {await context.close();}
  // A new service selection leaves the loaded map's legend alone until load.
  await page.locator("[data-context-file-input]").setInputFiles({name:"without-legend.wms",mimeType:"application/xml",buffer:Buffer.from(wms.replace("Survey map","Survey map without legend"))});
  await expect(page.getByRole("combobox",{name:"Service layer"})).toContainText("Survey map without legend");
  await expect(legendImage).toBeVisible();
  await page.getByRole("button",{name:"Load selected layer"}).click();
  await expect(page.locator("[data-context-map-legend]")).toHaveCount(0);
  expect(await pixel(page,.5,.35)).toEqual(north);
});

test("keeps the WMS map usable when its optional legend is unavailable",async({page})=>{
  await open(page);
  const encoded=await page.evaluate(()=>{
    const canvas=document.createElement("canvas");canvas.width=16;canvas.height=16;
    const ctx=canvas.getContext("2d")!;ctx.fillStyle="#ff0000";ctx.fillRect(0,0,16,16);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.route("**/api/ogc?**",async(route)=>{
    const request=new URL(route.request().url());
    if(request.searchParams.get("legend") === "1")await route.fulfill({status:502,contentType:"application/json",body:JSON.stringify({error:"unreachable"})});
    else await route.fulfill({contentType:"image/png",body:Buffer.from(encoded,"base64")});
  });
  await page.locator("[data-context-file-input]").setInputFiles({name:"survey.wms",mimeType:"application/xml",buffer:Buffer.from(wmsWithLegend)});
  await page.getByRole("spinbutton",{name:"Area radius (m)"}).fill("3");
  await page.getByRole("button",{name:"Load selected layer"}).click();
  await expect(page.locator("[data-context-model]")).toBeAttached();
  await expect(page.locator("[data-context-service]").getByRole("status")).toContainText("The legend could not be loaded");
  await expect(page.locator("[data-context-map-legend]")).toHaveCount(0);
  const colour=await pixel(page,.5,.35);expect(colour[0]).toBeGreaterThan(colour[2]+150);
});

test("reports incomplete WFS results and keeps the existing context",async({page})=>{
  await open(page);
  await page.locator("[data-context-file-input]").setInputFiles({name:"old.gml",mimeType:"application/xml",buffer:Buffer.from(features)});
  await expect(page.locator("[data-context-model]")).toHaveAttribute("data-context-triangles","2");
  await page.route("**/api/ogc?**",async(route)=>{
    const operation=new URL(new URL(route.request().url()).searchParams.get("url")!).searchParams.get("REQUEST");
    await route.fulfill({contentType:"application/xml",body:operation === "GetCapabilities" ? wfs : features.replace('numberMatched="1"','numberMatched="99"')});
  });
  await page.getByRole("button",{name:"Add WFS / WMS service"}).click();
  await page.getByRole("textbox",{name:"Service URL"}).fill("https://maps.example.org/wfs");
  await page.getByRole("button",{name:"Read layers"}).click();
  await expect(page.getByRole("combobox",{name:"Service layer"})).toBeVisible();
  await page.getByRole("button",{name:"Load selected layer"}).click();
  await expect(page.locator("[data-context-service]").getByRole("alert")).toContainText("incomplete layer");
  await expect(page.locator("[data-context-model]")).toHaveAttribute("data-context-triangles","2");
});

test("cancels a service load and releases the context file picker",async({page})=>{
  let release!:()=>void;
  const held=new Promise<void>((resolve)=>{release=resolve;});
  await page.route("**/api/ogc?**",async(route)=>{
    await held;
    await route.fulfill({contentType:"application/xml",body:features}).catch(()=>{});
  });
  await open(page);
  await page.locator("[data-context-file-input]").setInputFiles({name:"survey.wfs",mimeType:"application/xml",buffer:Buffer.from(wfs)});
  await expect(page.getByRole("combobox",{name:"Service layer"})).toBeVisible();
  await page.getByRole("button",{name:"Load selected layer"}).click();
  await expect(page.getByRole("progressbar",{name:"Loading map service…"})).toBeVisible();
  await expect(page.locator("[data-context-file-input]")).toBeDisabled();
  await page.getByRole("tab",{name:"Geo",exact:true}).click();
  await expect(page.getByRole("progressbar",{name:"Loading map service…"})).toHaveCount(0);
  await page.getByRole("tab",{name:"GIS",exact:true}).click();
  await expect(page.getByRole("progressbar",{name:"Loading map service…"})).toBeVisible();
  await page.locator("[data-context-service]").getByRole("button",{name:"Cancel",exact:true}).click();
  await expect(page.getByRole("progressbar",{name:"Loading map service…"})).toHaveCount(0);
  await expect(page.locator("[data-context-file-input]")).toBeEnabled();
  release();
  await expect(page.locator("[data-context-model]")).toHaveCount(0);
});

test("offers Vila Nova de Gaia's open data service as an example, contacting it only on Read layers",async({page})=>{
  const requests:URL[]=[];
  await page.route("**/api/ogc?**",async(route)=>{
    requests.push(new URL(new URL(route.request().url()).searchParams.get("url")!));
    await route.fulfill({contentType:"application/xml",body:wfs});
  });
  await open(page);
  await page.getByRole("button",{name:"Add WFS / WMS service"}).click();
  await page.locator("[data-ogc-example]").click();
  await expect(page.getByRole("textbox",{name:"Service URL"})).toHaveValue("https://opendata.gaiurb.pt/geoserver/ows");
  expect(requests).toHaveLength(0);
  await page.getByRole("button",{name:"Read layers"}).click();
  await expect(page.getByRole("combobox",{name:"Service layer"})).toContainText("Survey plots");
  expect(requests.map((url)=>`${url.origin}${url.pathname} ${url.searchParams.get("SERVICE")} ${url.searchParams.get("REQUEST")}`))
    .toEqual(["https://opendata.gaiurb.pt/geoserver/ows WFS GetCapabilities"]);
});
