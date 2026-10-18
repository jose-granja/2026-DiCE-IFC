"use client";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CoordinateInfo } from "@/lib/ifc/types";
import type { ContextGeometry } from "@/lib/georef/context-geometry";
import type { Placement } from "@/lib/georef/transform";
import type { OgcService } from "@/lib/georef/ogc-service";
import { contextLayerName, loadedAreaLayers, modelAreaFootprint, type AreaReport } from "@/lib/georef/area-check";
import { checkWfsAreas } from "@/lib/georef/wfs-area-check";
import { checkContextAreas } from "@/lib/workers/area-check-client";
import { useGisAreaStore } from "@/lib/viewer/gis-area-store";
import { useContextModelStore } from "@/lib/viewer/context-model-store";
import LoadingProgress from "./LoadingProgress";

export type GisAreaModel = { name: string; coordinates: CoordinateInfo };

export function GisAreaCheckButton({ service, geometry, filename, model, placement, disabled }: {
  service?: OgcService | null;
  geometry?: ContextGeometry;
  filename?: string;
  model: GisAreaModel | null;
  placement: Placement | null;
  disabled: boolean;
}) {
  const t = useTranslations("viewer.gisAreas");
  const busy = useGisAreaStore((s) => s.busy || !!s.viewRequest);
  const request = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  useEffect(() => () => request.current?.abort(), [model?.coordinates, placement?.conversion, placement?.epsg]);

  const run = async () => {
    if (!model || !placement || busy || request.current || (!geometry && service?.kind !== "WFS")) return;
    const context = useContextModelStore.getState();
    const controller = new AbortController();
    request.current = controller;
    const source = service ? `${service.title} (${new URL(service.url).host})` : filename ?? t("loadedData");
    let report: AreaReport = {
      model: model.name, source, epsg: placement.epsg, checkedAt: new Date().toISOString(),
      scope: service ? "wfs" : "loaded", status: "running",
      layers: service ? service.layers.map((layer) => ({ name: layer.name, title: layer.title, status: "pending", matches: [] })) : loadedAreaLayers(geometry!, source),
    };
    useGisAreaStore.getState().start(report);
    setProgress(0);
    try {
      const footprint = modelAreaFootprint(model.coordinates, placement);
      if (service) {
        await checkWfsAreas(service, placement.epsg, footprint, controller.signal, checkContextAreas, (index, result) => {
          if (useGisAreaStore.getState().report?.checkedAt !== report.checkedAt) { controller.abort(); return; }
          report = { ...report, layers: report.layers.map((layer, i) => i === index ? result : layer) };
          useGisAreaStore.getState().update(report);
          setProgress((index + 1) / report.layers.length * 100);
        });
      } else {
        if (geometry!.epsg !== placement.epsg) throw new Error("differentCrs");
        const checked = await checkContextAreas(geometry!, footprint, controller.signal);
        const areas = new Set(checked.areas.map((i) => contextLayerName(geometry!.features![i], source)));
        report = { ...report, layers: report.layers.map((layer) => {
          const featureIndices = checked.matches.filter((i) => contextLayerName(geometry!.features![i], source) === layer.name);
          const matches = featureIndices.map((i) => geometry!.features![i]);
          const first = matches[0];
          const view = first && context.file ? { file: context.file, geometry: geometry!, appearance: context.appearance, featureIndices,
            layer: first.layer ? { field: "layer" as const, value: first.layer }
              : /GML|CityJSON/.test(first.source) ? { field: "type" as const, value: first.type } : undefined } : undefined;
          return { ...layer, matches, view, status: matches.length ? "matched" : areas.has(layer.name) ? "noMatches" : "noAreas" };
        }) };
        if (geometry!.skippedObjects) report = { ...report, layers: [...report.layers, { name: "", title: source, status: "error", error: "skippedGeometry", matches: [] }] };
      }
    } catch (error) {
      if (!controller.signal.aborted) report = { ...report, layers: report.layers.map((layer) => layer.status === "pending"
        ? { ...layer, status: "error", error: error instanceof Error && error.message === "differentCrs" ? "differentCrs" : "invalidFeatureFile" } : layer) };
    } finally {
      report = { ...report, status: controller.signal.aborted ? "cancelled" : "complete" };
      // A new session may have cleared the store while this task was cancelled.
      if (useGisAreaStore.getState().report?.checkedAt === report.checkedAt) useGisAreaStore.getState().update(report);
      request.current = null;
      setProgress(null);
    }
  };

  return <>
    <Button size="sm" variant="outline" className="h-7 text-xs" disabled={disabled || busy || !model || !placement || (!geometry && service?.kind !== "WFS")}
      title={t(!model || !placement ? "needsModel" : "method")} onClick={() => void run()}>
      <ScanSearch className="h-3.5 w-3.5" aria-hidden />{t(geometry ? "checkLoaded" : "check")}
    </Button>
    {progress !== null && <div className="w-full space-y-1">
      <LoadingProgress label={t("checking")} percent={progress} />
      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => request.current?.abort()}>{t("cancel")}</Button>
    </div>}
  </>;
}
