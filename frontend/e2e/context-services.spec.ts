import path from "node:path";
import { expect,test,type Page } from "@playwright/test";

const IFC=path.resolve(__dirname,"../fixtures/ifc/georeferenced-wall-ifc4.ifc");
const wfs=`<WFS_Capabilities version="2.0.0" xmlns:ows="http://www.opengis.net/ows/1.1" xmlns:xlink="http://www.w3.org/1999/xlink">
  <ows:ServiceIdentification><ows:Title>City survey</ows:Title></ows:ServiceIdentification><ows:OperationsMetadata><ows:Operation name="GetFeature"><ows:DCP><ows:HTTP><ows:Get xlink:href="https://maps.example.org/wfs"/></ows:HTTP></ows:DCP></ows:Operation></ows:OperationsMetadata>
  <FeatureTypeList><FeatureType><Name>city:plots</Name><Title>Survey plots</Title><DefaultCRS>EPSG:3763</DefaultCRS></FeatureType></FeatureTypeList></WFS_Capabilities>`;
const wms=`<WMS_Capabilities version="1.3.0" xmlns:xlink="http://www.w3.org/1999/xlink"><Service><Title>City survey</Title></Service><Capability><Request><GetMap><Format>image/png</Format><DCPType><HTTP><Get><OnlineResource xlink:href="https://maps.example.org/wms"/></Get></HTTP></DCPType></GetMap></Request><Layer><CRS>EPSG:3763</CRS><Attribution><Title>© City survey</Title></Attribution><Layer><Name>map</Name><Title>Survey map</Title></Layer></Layer></Capability></WMS_Capabilities>`;
const features=`<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:gml="http://www.opengis.net/gml/3.2" numberMatched="1" numberReturned="1"><wfs:member><Plot gml:id="plot"><name>West plot</name><zone>Residential</zone><gml:Polygon srsName="EPSG:3763" srsDimension="3"><gml:exterior><gml:LinearRing><gml:posList>-40003 179997 190 -39997 179997 190 -39997 180003 190 -40003 180003 190 -40003 179997 190</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></Plot></wfs:member></wfs:FeatureCollection>`;

async function open(page:Page) {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]',IFC);
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
  const box=(await page.locator("[data-model-canvas]").boundingBox())!;
  await page.mouse.click(box.x+box.width*.25,box.y+box.height*.35);
  await expect(page.locator("[data-context-properties]")).toContainText("West plot");
  await expect(page.locator("[data-context-properties]")).toContainText("WFS");
  await page.getByRole("tab",{name:"Models",exact:true}).click();
  await expect(page.locator("[data-context-attribution]")).toContainText("City survey");
});

test("loads a WMS URL, draws the map in the correct orientation and restores it offline",async({page,browser},testInfo)=>{
  test.setTimeout(90000);
  await page.addInitScript(()=>Object.defineProperty(window,"showDirectoryPicker",{value:undefined,configurable:true}));
  await open(page);
  const encoded=await page.evaluate(()=>{
    const canvas=document.createElement("canvas");canvas.width=64;canvas.height=64;
    const ctx=canvas.getContext("2d")!;ctx.fillStyle="#ff0000";ctx.fillRect(0,0,64,32);ctx.fillStyle="#0000ff";ctx.fillRect(0,32,64,32);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const requests:URL[]=[];
  await page.route("**/api/ogc?**",async(route)=>{
    const url=new URL(new URL(route.request().url()).searchParams.get("url")!);requests.push(url);
    if(url.searchParams.get("REQUEST") === "GetCapabilities")await route.fulfill({contentType:"application/xml",body:wms});
    else await route.fulfill({contentType:"image/png",body:Buffer.from(encoded,"base64")});
  });
  await page.getByRole("button",{name:"Add WFS / WMS service"}).click();
  await page.getByRole("combobox",{name:"Service type"}).click();
  await page.getByRole("option",{name:"WMS",exact:true}).click();
  await page.getByRole("textbox",{name:"Service URL"}).fill("https://maps.example.org/wms");
  await page.getByRole("button",{name:"Read layers"}).click();
  await expect(page.getByRole("combobox",{name:"Service layer"})).toContainText("Survey map");
  await page.getByRole("spinbutton",{name:"Area radius (m)"}).fill("3");
  await page.getByRole("button",{name:"Load selected layer"}).click();
  await expect(page.locator("[data-context-model]")).toBeAttached();
  const north=await pixel(page,.5,.35),south=await pixel(page,.5,.65);
  expect(north[0]).toBeGreaterThan(north[2]+150);
  expect(south[2]).toBeGreaterThan(south[0]+150);
  expect(requests).toHaveLength(2);
  expect(requests[1].searchParams.get("CRS")).toBe("EPSG:3763");
  await expect(page.locator("[data-context-attribution]")).toContainText("© City survey");
  await expect(page.getByRole("combobox",{name:"Colour by property"})).toHaveCount(0);
  await page.getByRole("switch",{name:"Context model",exact:true}).click();
  await expect(page.locator("[data-context-attribution]")).toHaveCount(0);
  await page.getByRole("switch",{name:"Context model",exact:true}).click();
  expect(await pixel(page,.5,.35)).toEqual(north);
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
    expect(network).toBe(0);
  } finally {await context.close();}
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
