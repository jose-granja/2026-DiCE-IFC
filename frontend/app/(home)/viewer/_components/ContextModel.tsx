"use client";

/**
 * Load a geospatial file as surrounding context.
 *
 * A basemap answers "is the building in the right place". It does not answer
 * "is it the right height beside its neighbours" — that needs the neighbours,
 * in 3D. This reads a CityJSON file the user already has (many municipalities
 * publish them) and places it in the same scene as the model.
 *
 * The context is **not a model**. It is not in the model list, not in the
 * spatial tree, not validated against an IDS, and not part of the federation
 * bounds — putting someone else's city into the user's validation results would
 * be worse than not having it at all. `renderer.setContextGeometry` is separate
 * from `setModelGeometry` for exactly that reason.
 *
 * Parsed in the tab, like every other file here. It is never uploaded.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Boxes, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { parseCityJson, sniffJsonType } from "@/lib/georef/cityjson";
import { parseGeoJson } from "@/lib/georef/geojson";
import { parseCityGml } from "@/lib/georef/citygml";
import { findCrs } from "@/config/epsg";
import { readGeoPackage } from "@/lib/workers/geopackage-client";
import type { ContextGeometry } from "@/lib/georef/context-geometry";
import { readContextFile } from "@/lib/georef/read-context-file";
import type { Placement, WgsPoint } from "@/lib/georef/transform";
import { placeContextGeometry, type ContextScenePlacement } from "@/lib/georef/context-placement";
import { clipCityJson } from "@/lib/workers/cityjson-client";
import { clipLargeGml } from "@/lib/workers/gml-client";
import { getActiveRenderer } from "@/lib/viewer/active-renderer";
import { useContextModelStore } from "@/lib/viewer/context-model-store";
import type { Vec3 } from "@/lib/ifc/types";
import LoadingProgress from "./LoadingProgress";
import { ContextAppearanceControls } from "./ContextAppearanceControls";
import { prepareContextEdges } from "@/lib/workers/context-edges-client";
import { OgcError, readCapabilities, type OgcService } from "@/lib/georef/ogc-service";
import { readMapSnapshot } from "@/lib/georef/context-map";
import { readFeatureSnapshot } from "@/lib/georef/context-features";
import ContextServiceControls from "./ContextServiceControls";
import { ContextMapLegend } from "./ContextMapLegend";
import { GisAreaCheckButton, type GisAreaModel } from "./GisAreaCheckButton";
import { revealContextFeature } from "@/lib/viewer/context-appearance";
import { useViewerStore } from "@/lib/viewer/store";
import { useGisAreaStore } from "@/lib/viewer/gis-area-store";

const LARGE_TEXT_FILE_BYTES = 64 * 1024 * 1024;

export function ContextModel({
  areaModel,
  placement,
  referencePoint,
  originShift,
  modelPlacement,
  ready,
}: {
  areaModel: GisAreaModel | null;
  /**
   * True once the panel has worked out where the model sits — what a context
   * file from a restored project waits for before it is read and placed.
   */
  ready: boolean;
  /** The model's map conversion, for putting the city in the same frame. */
  placement: Placement | null;
  /** Where the model sits on the earth — the centre a clip radius is drawn around. */
  referencePoint: WgsPoint | null;
  originShift: Vec3;
  modelPlacement: ContextScenePlacement;
}) {
  const t = useTranslations("viewer.contextModel");
  const areasT = useTranslations("viewer.gisAreas");
  const areaBusy = useGisAreaStore((s) => s.busy || !!s.viewRequest);
  const areaViewRequest = useGisAreaStore((s) => s.viewRequest);
  const areaReport = useGisAreaStore((s) => s.report);
  const filename = useContextModelStore((s) => s.file?.name);
  /**
   * GeoJSON needs the model's map conversion. GML and GeoPackage declare
   * their source CRS and can also be previewed locally without an IFC placement.
   */
  const NEEDS_PLACEMENT = t("needsPlacement");

  const input = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [phase, setPhase] = useState<"reading" | "processing" | "displaying">("reading");
  const [loadingName, setLoadingName] = useState("");
  const [service, setService] = useState<OgcService | null>(null);
  const [serviceBusy, setServiceBusy] = useState(false);
  const inFlight = useRef(false);
  // In a store, not here: the panel unmounts on every tab switch while the
  // geometry stays in the scene, and a project folder saves and restores it.
  const loaded = useContextModelStore((s) => s.loaded);
  const visible = useContextModelStore((s) => s.visible);
  const clipEnabled = useContextModelStore((s) => s.clipEnabled);
  const clipRadius = useContextModelStore((s) => s.clipRadius);
  const pending = useContextModelStore((s) => s.pending);
  const setSettings = useContextModelStore((s) => s.setSettings);
  const setVisible = (on: boolean) => setSettings({ visible: on });
  const setClipEnabled = (on: boolean) => setSettings({ clipEnabled: on });
  const setClipRadius = (value: string) => setSettings({ clipRadius: value });

  // Keep loaded geometry aligned when the reference placement changes, without
  // rebuilding its buffers, colours or selection.
  useEffect(() => {
    if (!loaded) return;
    const transform = placeContextGeometry(loaded.origin, placement, originShift, modelPlacement);
    getActiveRenderer()?.setContextPlacement(transform.offset, transform.rotationY, transform.scale);
  }, [loaded, placement, originShift, modelPlacement]);

  const canClip = Boolean(placement && referencePoint);
  const radiusMetres = Number(clipRadius);
  const radiusValid = Number.isFinite(radiusMetres) && radiusMetres > 0;

  const processing = async () => {
    setPhase("processing");
    setProgress(null);
    // Let React and the browser paint the stage before a synchronous parser
    // starts. Large clipped files already run in workers and report progress.
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
  };

  const place = (result: ContextGeometry | null, show: boolean) => {
    const renderer = getActiveRenderer();
    if (!renderer) return;

    if (!result || !show) {
      renderer.setContextGeometry(null);
      return;
    }

    const transform = placeContextGeometry(result.origin, placement, originShift, modelPlacement);
    renderer.setContextGeometry(result);
    renderer.setContextPlacement(transform.offset, transform.rotationY, transform.scale);
    renderer.setContextAppearance(useContextModelStore.getState().appearance);
    renderer.setContextSelection(useContextModelStore.getState().selectedFeature);
  };

  /**
   * Pick a reader from the file's own contents, not its extension.
   *
   * Both formats are `.json` as often as not — CityJSON's own convention is
   * `.city.json`, and half the GeoJSON published by municipalities is plain
   * `.json`. The `type` member is the thing that actually distinguishes them,
   * and it costs one parse to read.
   */
  const read = async (
    file: File,
    epsg: number | null,
  ): Promise<ContextGeometry | null> => {
    /*
      Sniff the bytes, not the extension.

      A GeoPackage is a SQLite database and says so in its first 15 bytes; the
      text formats are told apart by their first non-space character and, for
      the two JSON ones, by their `type` member. Extensions decide nothing here
      — CityJSON and GeoJSON are both `.json` as often as not, and `.xml` could
      be either GML or something else entirely.
    */
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (head[0] === 0x50 && head[1] === 0x4b) {
      await processing();
      return readMapSnapshot(file, epsg);
    }
    if (new TextDecoder().decode(head.subarray(0, 15)) === "SQLite format 3") {
      const bytes = await readContextFile(file, "buffer", setProgress);
      await processing();
      const result = await readGeoPackage(new Uint8Array(bytes), epsg, {
        targetDefinition: epsg === null ? undefined : findCrs(epsg)?.proj4,
        clip: clipEnabled && canClip && radiusValid
          ? { reference: referencePoint!, radiusMetres }
          : undefined,
      }, setProgress);
      if (!result.ok) throw new Error(t(`geoPackageErrors.${result.error}`));
      return result.geometry;
    }

    // Detect XML from a small prefix. A national CityGML delivery can be
    // several gigabytes, which is larger than the browser's maximum string;
    // calling `File.text()` before this decision is what produced the false
    // “neither JSON nor XML” message.
    const prefix = await file.slice(0, 64 * 1024).text();
    if (prefix.trimStart().startsWith("<")) {
      if (file.size > LARGE_TEXT_FILE_BYTES) {
        if (
          epsg === null ||
          !clipEnabled ||
          !referencePoint ||
          !radiusValid
        ) {
          throw new Error(t("largeGmlNeedsClip"));
        }
        setPhase("processing");
        setProgress(0);
        return clipLargeGml(
          file,
          {
            targetEpsg: epsg,
            reference: referencePoint,
            radiusMetres,
          },
          setProgress,
        );
      }
      const text = await readContextFile(file, "text", setProgress);
      await processing();
      const capabilities = readCapabilities(text);
      if (capabilities) { setService(capabilities); return null; }
      return parseCityGml(text, epsg);
    }

    const text = await readContextFile(file, "text", setProgress);
    await processing();
    return readText(text, file.name, epsg);
  };

  const readText = async (
    text: string,
    name: string,
    epsg: number | null,
  ): Promise<ContextGeometry> => {
    // XML formats first: they are unambiguous from the first non-space
    // character, and trying to sniff a CityGML file as JSON only to report
    // "neither JSON nor XML" would name the wrong problem.
    if (text.trimStart().startsWith("<")) {
      return parseCityGml(text, epsg);
    }

    // A cheap top-level scan rather than `JSON.parse(text).type`: the whole
    // point of clipping is to avoid paying full-parse cost on a file that
    // can be hundreds of megabytes, and sniffing the format is no exception.
    const kind = sniffJsonType(text);
    if (kind === "DiCEContextFeatures") return readFeatureSnapshot(text, epsg);
    if (kind === undefined) {
      throw new Error(t("neitherJsonNorXml", { name }));
    }

    if (kind === "CityJSON") {
      if (clipEnabled && canClip && radiusValid) {
        return clipCityJson(text, {
          referenceLongitude: referencePoint!.longitude,
          referenceLatitude: referencePoint!.latitude,
          radiusMetres,
          targetEpsg: epsg!,
        });
      }
      return parseCityJson(text);
    }

    // GeoJSON is longitude/latitude; it can only be placed once we know what to
    // project it into, and that comes from the model's own placement.
    if (epsg === null) throw new Error(NEEDS_PLACEMENT);
    return parseGeoJson(text, epsg);
  };

  const onFile = async (file: File, show = true, signal?: AbortSignal) => {
    if (inFlight.current) return { ok: false, error: t("alreadyLoading") } as const;
    inFlight.current = true;
    setLoading(true);
    setLoadingName(file.name);
    setPhase("reading");
    setProgress(null);
    let result: ContextGeometry | null = null;
    let adopted = false;
    try {
      signal?.throwIfAborted();
      result = await read(file, placement?.epsg ?? null);
      signal?.throwIfAborted();
      if (!result) return { ok: true } as const;
      setPhase("processing");
      setProgress(null);
      if (!result.raster) result.edgeMasks = await prepareContextEdges(result);
      signal?.throwIfAborted();
      setPhase("displaying");
      setProgress(null);
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
      signal?.throwIfAborted();
      useContextModelStore.getState().setLoaded(file, result);
      adopted = true;
      setVisible(show);
      place(result, show);

      const summary = result.types
        .slice(0, 3)
        .map((entry) => `${entry.count} ${entry.type}`)
        .join(", ");
      toast.success(t("loaded", { count: result.objectCount, summary }));
      if (result.skippedObjects) toast.warning(t("skippedObjects", { count: result.skippedObjects }));

      if (placement && result.epsg && placement.epsg && result.epsg !== placement.epsg) {
        // Not fatal: the coordinates may still be close enough to be useful,
        // and saying nothing would leave a plausible-looking misplacement.
        toast.warning(
          t("crsMismatch", { resultEpsg: result.epsg, placementEpsg: placement.epsg }),
        );
      }
      return { ok: true } as const;
    } catch (error) {
      const message = error instanceof OgcError ? t(`service.errors.${error.code}`) : error instanceof Error ? error.message : t("readFailed");
      if (!signal?.aborted) toast.error(message);
      return { ok: false, error: message } as const;
    } finally {
      if (!adopted) result?.raster?.image.close();
      inFlight.current = false;
      setLoading(false);
      setProgress(null);
    }
  };

  // Report clicks use the exact checked file/geometry, independent of the
  // currently selected service, load radius, colour visibility or context file.
  useEffect(() => {
    if (!areaViewRequest) return;
    const request = areaViewRequest;
    const controller = new AbortController();
    const show = async () => {
      try {
        if (!ready) throw new Error(areasT("needsModel"));
        if (!placement || request.epsg !== placement.epsg) throw new Error(areasT("errors.differentCrs"));
        if (inFlight.current || serviceBusy || pending) throw new Error(t("alreadyLoading"));
        const { source, featureIndex } = request;
        let context = useContextModelStore.getState();
        const alreadyLoaded = context.file === source.file && !!context.loaded;
        let mustPlace = !context.visible;
        if (!alreadyLoaded) {
          if (source.geometry) { context.setLoaded(source.file, source.geometry); mustPlace = true; }
          else {
            const outcome = await onFile(source.file, true, controller.signal);
            controller.signal.throwIfAborted();
            if (!outcome.ok) throw new Error(outcome.error);
            mustPlace = false; // onFile has already built and placed this mesh.
          }
        }
        controller.signal.throwIfAborted();
        context = useContextModelStore.getState();
        const feature = context.loaded?.features?.[featureIndex];
        if (!feature || !context.loaded) throw new Error(t("readFailed"));
        context.setSettings({ visible: true, appearance: revealContextFeature(
          alreadyLoaded ? context.appearance : source.appearance ?? context.appearance, feature, source.layer,
        ) });
        useViewerStore.getState().clearSelection(true);
        context.selectFeature(featureIndex, true);
        if (mustPlace) place(context.loaded, true);
        const renderer = getActiveRenderer();
        renderer?.setContextAppearance(useContextModelStore.getState().appearance);
        renderer?.setContextSelection(featureIndex);
        renderer?.focusContextFeature(featureIndex);
        useGisAreaStore.getState().finishView(request);
      } catch (error) {
        if (!controller.signal.aborted) useGisAreaStore.getState().finishView(request, error instanceof Error ? error.message : t("readFailed"));
      }
    };
    void show();
    return () => controller.abort();
    // Placement and readers are captured when the user requests this view.
    // Changes to the context during adoption must not restart the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areaViewRequest, ready, placement?.epsg]);

  /*
    A context file from a restored project. Read once the panel knows where the
    model sits: before that the reader would either refuse a GeoJSON for want of
    a placement or put a CityJSON down at the origin, unclipped, which looks
    loaded and is in the wrong place.
  */
  const started = useRef<File | null>(null);
  useEffect(() => {
    if (!pending || !ready || started.current === pending) return;
    started.current = pending;
    const file = pending;
    const show = useContextModelStore.getState().visible;
    void onFile(file, show).then((outcome) => {
      useContextModelStore.getState().finishPending(outcome);
    });
    // `onFile` closes over this render's placement, which is what `ready` waited for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, ready]);

  const clear = () => {
    useContextModelStore.getState().clear();
    place(null, false);
    if (input.current) input.current.value = "";
  };

  return (
    <div className="space-y-2 border-b p-2">
      <div className="flex items-center justify-between gap-2">
        <Label
          htmlFor="georef-context"
          className="flex items-center gap-1.5 text-xs font-medium"
        >
          <Boxes className="h-3.5 w-3.5" aria-hidden />
          {t("title")}
        </Label>

        {loaded ? (
          <div className="flex items-center gap-1">
            <Switch
              id="georef-context"
              checked={visible}
              disabled={loading || serviceBusy || areaBusy}
              onCheckedChange={(on) => {
                setVisible(on);
                place(loaded, on);
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={clear}
              disabled={loading || serviceBusy || areaBusy}
              aria-label={t("remove")}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-[11px]"
            onClick={() => input.current?.click()}
            disabled={loading || serviceBusy || areaBusy}
          >
            {t("loadContext")}
          </Button>
        )}
      </div>

      {loading && (
        <LoadingProgress label={t(`progress.${phase}`)} detail={loadingName} percent={progress} />
      )}

      <input
        ref={input}
        data-context-file-input
        type="file"
        accept=".json,.city.json,.cityjson,.geojson,.gml,.xml,.citygml,.gpkg,.wfs,.wms,.context-map,.context-features,application/json,application/geo+json,application/gml+xml,text/xml"
        className="hidden"
        disabled={loading || serviceBusy || areaBusy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void onFile(file);
        }}
      />

      <ContextServiceControls service={service} setService={setService} placement={placement} reference={referencePoint} onFile={(file, signal) => onFile(file, true, signal)} disabled={loading || areaBusy} onBusyChange={setServiceBusy} areaModel={areaModel} />
      {loaded && !loaded.raster && loaded.featureRanges?.some((range) => range.area !== false) && <div className="flex flex-wrap gap-1">
        <GisAreaCheckButton geometry={loaded} filename={filename} model={areaModel} placement={placement} disabled={loading || serviceBusy} />
      </div>}
      {areaReport && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => useGisAreaStore.getState().show()}>{areasT("showReport")}</Button>}
      {loaded && !loaded.raster && <ContextAppearanceControls geometry={loaded} disabled={loading} />}
      {loaded?.raster && <p className="text-muted-foreground text-[11px]">{t("service.rasterNote")}</p>}
      {visible && loaded?.raster?.legend && <ContextMapLegend legend={loaded.raster.legend} />}

      {!loaded && canClip && (
        <div className="flex items-center justify-between gap-2">
          <Label
            htmlFor="georef-context-clip"
            className="text-muted-foreground text-[11px]"
          >
            {t("clipToModel")}
          </Label>
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              min={1}
              step={1}
              value={clipRadius}
              onChange={(event) => setClipRadius(event.target.value)}
              disabled={loading || !clipEnabled}
              aria-label={t("clipRadiusLabel")}
              className="h-6 w-16 text-[11px]"
            />
            <span className="text-muted-foreground text-[11px]">m</span>
            <Switch
              id="georef-context-clip"
              checked={clipEnabled}
              disabled={loading}
              onCheckedChange={setClipEnabled}
            />
          </div>
        </div>
      )}

      {loaded ? (
        <p className="text-muted-foreground text-[11px]">
          {t("summary", {
            count: loaded.objectCount,
            metres: Math.round(loaded.sizeMetres),
            crs: loaded.epsg ? t("summaryCrs", { epsg: loaded.epsg }) : t("summaryNoCrs"),
          })}
          {!placement && ` ${t("noPlacementNote")}`}
        </p>
      ) : (
        <p className="text-muted-foreground text-[11px]">
          {t("formatsHint")}
          {!canClip && ` ${t("clipHint")}`}
        </p>
      )}
    </div>
  );
}

export default ContextModel;
