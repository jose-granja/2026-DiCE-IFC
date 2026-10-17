"use client";

import { useRef, useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { capabilitiesUrl, fetchOgc, layerRequest, OgcError, readCapabilities, type OgcKind, type OgcService } from "@/lib/georef/ogc-service";
import { checkFeatureResponse, featureSnapshotFile } from "@/lib/georef/context-features";
import { saveMapSnapshot } from "@/lib/georef/context-map";
import type { Placement, WgsPoint } from "@/lib/georef/transform";
import LoadingProgress from "./LoadingProgress";

export default function ContextServiceControls({ service, setService, placement, reference, onFile, disabled, onBusyChange }: {
  service:OgcService|null; setService:(service:OgcService|null)=>void;
  placement:Placement|null; reference:WgsPoint|null;
  onFile:(file:File, signal:AbortSignal)=>Promise<unknown>; disabled:boolean; onBusyChange:(busy:boolean)=>void;
}) {
  const t=useTranslations("viewer.contextModel.service");
  const [open,setOpen]=useState(false), [kind,setKind]=useState<OgcKind>("WFS"), [url,setUrl]=useState("");
  const [layerName,setLayerName]=useState(""), [radius,setRadius]=useState("100"), [height,setHeight]=useState("");
  const [busy,setBusy]=useState(false), [error,setError]=useState("");
  const request=useRef<AbortController|null>(null);
  useEffect(() => () => request.current?.abort(),[]);
  const layer=service?.layers.find((l)=>l.name === layerName) ?? service?.layers[0];
  const run=async (job:(signal:AbortSignal)=>Promise<void>) => {
    if (request.current) return;
    const controller=new AbortController();request.current=controller;setBusy(true);onBusyChange(true);setError("");
    try { await job(controller.signal); } catch (e) {
      if (!controller.signal.aborted) setError(t(`errors.${e instanceof OgcError ? e.code : "serviceError"}`));
    } finally { request.current=null;setBusy(false);onBusyChange(false); }
  };
  const connect=()=>run(async(signal)=>{
    const document=await fetchOgc(capabilitiesUrl(url,service?.kind ?? kind),signal);
    const found=readCapabilities(await document.text(),url);
    if (!found) throw new OgcError("invalidCapabilities");
    setService(found);setLayerName("");
  });
  const load=()=>run(async(signal)=>{
    if (!service || !layer || !placement || !reference) throw new OgcError("needsPlacement");
    const selected=layerRequest(service,layer,placement.epsg,reference,Number(radius));
    const response=await fetchOgc(selected.url,signal);
    if (signal.aborted) return;
    let file:File;
    if (service.kind === "WMS") {
      const elevation=height.trim() ? Number(height) : placement.conversion.orthogonalHeight;
      if (!Number.isFinite(elevation)) throw new OgcError("invalidHeight");
      if (!/^image\/(png|jpeg)$/.test(response.type)) throw new OgcError("serviceError");
      file=await saveMapSnapshot({format:"dice-context-map",version:1,name:layer.title,attribution:layer.attribution,attributionUrl:layer.attributionUrl,sourceEpsg:selected.epsg,box:selected.box,height:elevation,mimeType:response.type as "image/png"|"image/jpeg"},response);
    } else {
      const text=await response.text();checkFeatureResponse(text);
      file=featureSnapshotFile({type:"DiCEContextFeatures",version:1,name:layer.title,attribution:layer.attribution,crs:selected.crs,body:text});
    }
    if (!signal.aborted) await onFile(file,signal);
  });
  const visible=open || service;
  return <div className="space-y-2" data-context-service>
    <Button variant="outline" size="sm" className="h-7 w-full text-xs" disabled={disabled || busy} onClick={()=>{setOpen(!visible);if(visible)setService(null);}}>{visible ? t("close") : t("open")}</Button>
    {visible && <div className="space-y-2 rounded-md border p-2">
      <p className="text-muted-foreground text-[11px]">{t("explanation")}</p>
      <div className="flex gap-1">
        <Select value={service?.kind ?? kind} onValueChange={(value)=>{setKind(value as OgcKind);setService(null);}} disabled={disabled||busy}>
          <SelectTrigger aria-label={t("kind")} className="h-7 w-20 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="WFS">WFS</SelectItem><SelectItem value="WMS">WMS</SelectItem></SelectContent>
        </Select>
        <Input aria-label={t("url")} placeholder="https://…" value={url} onChange={(e)=>setUrl(e.target.value)} disabled={disabled||busy} className="h-7 min-w-0 text-xs" />
      </div>
      <p className="text-muted-foreground text-[11px]">{t("privacy")}</p>
      <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!url.trim()||busy||disabled} onClick={connect}>{t("connect")}</Button>
      {service && layer && <>
        <p className="truncate text-xs font-medium" title={service.title}>{service.kind} · {service.title}</p>
        <p className="text-muted-foreground truncate text-[11px]">{new URL(service.url).host}</p>
        <Select value={layer.name} onValueChange={setLayerName} disabled={busy||disabled}>
          <SelectTrigger aria-label={t("layer")} className="h-7 w-full text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>{service.layers.map((l)=><SelectItem key={l.name} value={l.name}>{l.title}</SelectItem>)}</SelectContent>
        </Select>
        <div className="flex items-center gap-2"><Label htmlFor="ogc-radius" className="flex-1 text-[11px]">{t("radius")}</Label><Input id="ogc-radius" type="number" min={1} max={100000} value={radius} onChange={(e)=>setRadius(e.target.value)} className="h-7 w-24 text-xs" disabled={busy||disabled} /></div>
        {service.kind === "WMS" && <div className="flex items-center gap-2"><Label htmlFor="ogc-height" className="flex-1 text-[11px]">{t("height")}</Label><Input id="ogc-height" type="number" value={height} placeholder={String(placement?.conversion.orthogonalHeight ?? 0)} onChange={(e)=>setHeight(e.target.value)} className="h-7 w-24 text-xs" disabled={busy||disabled} /></div>}
        {!placement && <p className="text-muted-foreground text-[11px]">{t("errors.needsPlacement")}</p>}
        <Button size="sm" className="h-7 w-full text-xs" disabled={!placement||!reference||busy||disabled} onClick={load}>{t("load")}</Button>
      </>}
      {busy && <><LoadingProgress label={t("loading")} percent={null} /><Button variant="ghost" size="sm" onClick={()=>request.current?.abort()}>{t("cancel")}</Button></>}
      {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
    </div>}
  </div>;
}
