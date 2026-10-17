import path from "node:path";
import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const IFC = path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc");
const ring = (role: string, xy: number[][]) => `<gml:${role}><gml:LinearRing><gml:posList>${xy.map(([x,y]) => `${-40003+x} ${179997+y} 190`).join(" ")}</gml:posList></gml:LinearRing></gml:${role}>`;
const polygon = `<gml:Polygon>${ring("exterior", [[0,0],[6,0],[6,6],[4,6],[4,2],[2,2],[2,6],[0,6],[0,0]])}
  ${ring("interior", [[0.5,3],[1.5,3],[1.5,4],[0.5,4],[0.5,3]])}</gml:Polygon>`;
const xml = `<FeatureCollection xmlns:gml="http://www.opengis.net/gml" srsName="EPSG:3763" srsDimension="3">
  <member><Building gml:id="U"><category>Courtyard block</category>${polygon}</Building></member></FeatureCollection>`;

for (const streamed of [false, true]) {
  test(`renders concave GML boundaries and holes ${streamed ? "in the large-file worker" : "in the XML reader"}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/viewer");
    await page.setInputFiles('input[type="file"]', IFC);
    await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
    await page.getByRole("button", { name: "Top view", exact: true }).press("Enter");
    await page.getByRole("button", { name: "Orthographic", exact: true }).click();
    await page.getByRole("tab", { name: "Models", exact: true }).click();
    await page.getByRole("button", { name: "Hide georeferenced-wall-ifc4.ifc", exact: true }).click();
    await page.getByRole("tab", { name: "Geo", exact: true }).click();
    const file = testInfo.outputPath(streamed ? "large-courtyard.gml" : "courtyard.xml");
    // Real >64 MiB file exercises the production dispatch and Comlink worker.
    // Small comments keep the parser's streaming memory bounded.
    const padding = streamed ? `<!--${" ".repeat(1024*1024)}-->`.repeat(65) : "";
    await writeFile(file, xml.replace("</FeatureCollection>", `${padding}</FeatureCollection>`));
    await page.locator("[data-context-file-input]").setInputFiles(file);
    await expect(page.locator("[data-context-model]")).toBeAttached({ timeout: 60_000 });
    await page.getByRole("combobox", { name: "Colour by property" }).click();
    await page.getByRole("option", { name: "category", exact: true }).click();
    await page.getByLabel("Colour for Courtyard block", { exact: true }).evaluate((element) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, "#ff00ff");
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const pixels = await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const canvas = document.querySelector<HTMLCanvasElement>("[data-model-canvas]")!;
      const copy = document.createElement("canvas");copy.width=canvas.width;copy.height=canvas.height;
      const ctx = copy.getContext("2d")!;ctx.drawImage(canvas,0,0);
      const { data }=ctx.getImageData(0,0,copy.width,copy.height);
      const coloured = (x: number,y: number) => { const i=(y*copy.width+x)*4;return data[i]>80 && data[i+2]>80 && data[i+1]<50; };
      let x0=copy.width,y0=copy.height,x1=0,y1=0;
      for(let y=0;y<copy.height;y++)for(let x=0;x<copy.width;x++)if(coloured(x,y)){x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);}
      const at = (x: number,y: number) => coloured(Math.round(x0+(x1-x0)*x/6),Math.round(y1-(y1-y0)*y/6));
      return { width:x1-x0, left:at(1,1), right:at(5,4), notch:at(3,4), hole:at(1,3.5),
        pick: {x:(x0+(x1-x0)/6)/copy.width,y:(y1-(y1-y0)/6)/copy.height} };
    });
    expect(pixels.width).toBeGreaterThan(100);
    expect(pixels.left).toBe(true);
    expect(pixels.right).toBe(true);
    expect(pixels.notch).toBe(false);
    expect(pixels.hole).toBe(false);
    await page.screenshot({ path:testInfo.outputPath("concave-courtyard.png") });
    const box=(await page.locator("[data-model-canvas]").boundingBox())!;
    await page.mouse.click(box.x+box.width*pixels.pick.x,box.y+box.height*pixels.pick.y);
    await expect(page.locator("[data-context-properties]")).toContainText("Courtyard block");
    expect(errors).toEqual([]);
  });
}
