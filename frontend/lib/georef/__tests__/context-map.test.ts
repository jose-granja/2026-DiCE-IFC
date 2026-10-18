import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { unzipSync, zipSync } from "fflate";
import { readMapLegend, readMapSnapshot, saveMapSnapshot, type MapSnapshot } from "../context-map";

const metadata:MapSnapshot={format:"dice-context-map",version:1,name:"Land use",attribution:"City survey",sourceEpsg:3763,box:{minX:0,minY:0,maxX:10,maxY:10},height:0,mimeType:"image/png"};
const image=new Blob(["map pixels"],{type:"image/png"});
const legend={title:"Land use",image:new Blob(["legend pixels"],{type:"image/png"})};

beforeEach(()=>vi.stubGlobal("createImageBitmap",vi.fn(async(blob:Blob)=>{
  if(await blob.text() === "corrupt")throw new Error("decode failed");
  return {width:32,height:32,close:vi.fn()};
})));
afterEach(()=>vi.unstubAllGlobals());

it("round-trips the legend bytes/title locally and still reads snapshots without a legend",async()=>{
  for(const included of [legend,undefined]) {
    const file=await saveMapSnapshot(metadata,image,included);
    const result=await readMapSnapshot(file,3763);
    expect(result.raster?.legend?.title).toBe(included?.title);
    expect(await result.raster?.legend?.image.text()).toBe(included ? "legend pixels" : undefined);
    expect(result.features?.[0].name).toBe("Land use");
  }
});

it("loads the map even when an optional legend is missing or cannot be decoded",async()=>{
  const file=await saveMapSnapshot(metadata,image,legend);
  const original=unzipSync(new Uint8Array(await file.arrayBuffer()));
  for(const replacement of [undefined,new TextEncoder().encode("corrupt")]) {
    const entries={...original};
    if(replacement)entries["legend-image"]=replacement;else delete entries["legend-image"];
    const result=await readMapSnapshot(new Blob([zipSync(entries) as Uint8Array<ArrayBuffer>]),3763);
    expect(result.raster?.image).toBeDefined();
    expect(result.raster?.legend).toBeUndefined();
  }
});

it("rejects non-raster or oversized legends and releases decoded bitmaps",async()=>{
  await expect(readMapLegend(new Blob(["<svg/>"],{type:"image/svg+xml"}),"Legend")).rejects.toThrow("unsupportedImage");
  await expect(readMapLegend(new Blob([new Uint8Array(2*1024*1024+1)],{type:"image/png"}),"Legend")).rejects.toThrow("tooLarge");
  const close=vi.fn();
  vi.mocked(createImageBitmap).mockResolvedValue({width:4000,height:10000,close} as unknown as ImageBitmap);
  await expect(readMapLegend(legend.image,"Legend")).rejects.toThrow("tooLarge");
  expect(close).toHaveBeenCalledOnce();
});
