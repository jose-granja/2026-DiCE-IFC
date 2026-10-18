import { describe, expect, it, vi } from "vitest";
import { publicAddress, validateOgcRequest, downloadOgc } from "../ogc-proxy";
import { lookup } from "node:dns/promises";
vi.mock("node:dns/promises",()=>({lookup:vi.fn()}));

describe("OGC proxy boundary",()=>{
  it.each(["127.0.0.1","10.1.2.3","172.16.2.3","192.168.1.1","169.254.169.254","100.64.0.1","0.0.0.0","224.0.0.1","::1","::ffff:127.0.0.1","fc00::1","fe80::1","2001:db8::1","2002:7f00:1::"])("rejects nonpublic address %s",(address)=>expect(publicAddress(address)).toBe(false));
  it.each(["8.8.8.8","1.1.1.1","2606:4700:4700::1111"])("accepts public address %s",(address)=>expect(publicAddress(address)).toBe(true));
  it("rejects write operations, remote styles, duplicate parameters and unbounded requests",()=>{
    for(const query of ["SERVICE=WFS&REQUEST=Transaction","SERVICE=WFS&REQUEST=GetFeature","SERVICE=WMS&REQUEST=GetCapabilities&request=Transaction","SERVICE=WMS&REQUEST=GetMap&SLD=https://example.org/evil.xml","SERVICE=WFS&REQUEST=GetFeature&BBOX=1,2,3,4&COUNT=100000"])
      expect(()=>validateOgcRequest(`https://maps.example.org/ogc?${query}`)).toThrow();
    for(const url of ["file:///etc/passwd","https://user:pass@maps.example.org/wms","https://maps.example.org:9000/wms"])
      expect(()=>validateOgcRequest(url)).toThrow();
  });
  it("bounds images/features and preserves valid read requests",()=>{
    const request=validateOgcRequest("https://maps.example.org/wms?SERVICE=WMS&REQUEST=GetMap&FORMAT=image/png&WIDTH=1024&HEIGHT=1024&BBOX=1,2,3,4&LAYERS=plots");
    expect(request.image).toBe(true);expect(request.limit).toBe(20*1024*1024);
    expect(()=>validateOgcRequest(request.url.href.replace("WIDTH=1024","WIDTH=99999"))).toThrow();
  });
  it("allows bounded legends without map bounds, including restricted static PNG/JPEG links",()=>{
    const url="https://maps.example.org/wms?SERVICE=WMS&REQUEST=GetLegendGraphic&FORMAT=image/png&LAYER=plots&STYLE=land_use";
    expect(validateOgcRequest(url,true)).toMatchObject({image:true,limit:2*1024*1024});
    expect(validateOgcRequest("https://maps.example.org/legend.png?key=demo",true)).toMatchObject({image:true,limit:2*1024*1024});
    for(const suffix of ["&WIDTH=99999","&SLD=https://example.org/style.xml","&SLD_BODY=xml","&SCALE=-1","&request=GetMap"])
      expect(()=>validateOgcRequest(url+suffix,true)).toThrow();
    for(const bad of [url.replace("LAYER=plots","LAYER="),url.replace("image/png","image/svg+xml"),url.replace("SERVICE=WMS","SERVICE=WFS"),
      "https://maps.example.org/admin","https://maps.example.org/legend.svg","https://maps.example.org/legend.png?REQUEST=Transaction","https://maps.example.org/legend.png?callback=evil",
      "https://maps.example.org/wms?SERVICE=WMS&REQUEST=GetCapabilities"])
      expect(()=>validateOgcRequest(bad,true)).toThrow();
    expect(()=>validateOgcRequest("https://maps.example.org/legend.png")).toThrow();
  });
  it("rejects a public hostname resolving to any private address before connecting",async()=>{
    vi.mocked(lookup).mockResolvedValue([{address:"8.8.8.8",family:4},{address:"127.0.0.1",family:4}] as never);
    await expect(downloadOgc("https://maps.example.org/wms?SERVICE=WMS&REQUEST=GetCapabilities")).rejects.toThrow("publicServiceOnly");
    await expect(downloadOgc("https://maps.example.org/legend.png",undefined,true)).rejects.toThrow("publicServiceOnly");
  });
});
