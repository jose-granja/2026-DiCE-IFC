"use client";

import { effectiveScale } from "@/lib/georef/scale";
import { useEffect, useMemo } from "react";
import { useTranslations } from "next-intl";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DEFAULT_EPSG } from "@/config";
import { isTrivialMapConversion, resolveEpsgCode } from "@/lib/georef/logeoref";
import { useGeorefStore } from "@/lib/georef/store";
import { loadCrsIndex } from "@/lib/georef/crs-index";
import {
  gridConvergence,
  isSupportedCrs,
  localToMap,
  mapToWgs84,
  wgs84ToLocal,
} from "@/lib/georef/transform";
import GlobeControls from "./GlobeControls";
import ContextModel from "./ContextModel";
import { getActiveRenderer } from "@/lib/viewer/active-renderer";
import { worldToIfcMetres } from "@/lib/viewer/federation";
import type { ContextScenePlacement } from "@/lib/georef/context-placement";
import { useViewerStore } from "@/lib/viewer/store";
import type { Vec3 } from "@/lib/ifc/types";

import GeorefReportPanel from "@/app/(home)/georef/_components/GeorefReportPanel";
import ControlPointsPanel from "@/app/(home)/georef/_components/ControlPointsPanel";
import PlacementEditor from "@/app/(home)/georef/_components/PlacementEditor";
import WriteBackPanel from "@/app/(home)/georef/_components/WriteBackPanel";

/**
 * Geo and GIS share one placement calculation and draft lifecycle. Both tab
 * contents stay mounted so changing tabs preserves edits, context geometry,
 * map downloads and pending project restores. Maps remain opt-in (ADR 003).
 */
/** Shared so the prop identity is stable across renders. */
const ZERO: Vec3 = [0, 0, 0];
const IDENTITY: ContextScenePlacement = { offset: ZERO, rotationY: 0, scale: 1 };

export function GeorefPanels() {
  const t = useTranslations("viewer.georefPanel");
  const models = useViewerStore((s) => s.models);
  const placements = useViewerStore((s) => s.placements);
  const ready = useMemo(
    () => models.filter((model) => model.load.status === "ready"),
    [models],
  );

  const modelId = useGeorefStore((s) => s.modelId);
  const selectModel = useGeorefStore((s) => s.selectModel);
  const draft = useGeorefStore((s) => s.draft);
  const setDraft = useGeorefStore((s) => s.setDraft);
  const setOriginal = useGeorefStore((s) => s.setOriginal);

  const model = ready.find((entry) => entry.summary.id === modelId) ?? ready[0];
  const georeference = model?.georeference;
  const lengthUnitScale = georeference?.lengthUnitScale ?? 1;

  useEffect(() => {
    if (!modelId && ready.length > 0) selectModel(ready[0].summary.id);
    if (modelId && !ready.some((m) => m.summary.id === modelId)) {
      selectModel(ready[0]?.summary.id ?? null);
    }
  }, [ready, modelId, selectModel]);

  // Seed the draft from the file, once per model.
  useEffect(() => {
    if (!model || !georeference) return;
    let cancelled = false;

    const seed = () => {
      const epsg = resolveEpsgCode(georeference.projectedCRS?.name);
      const fromFile = georeference.projectedCRS;
      const site = {
        latitude: georeference.site?.latitude ?? null,
        longitude: georeference.site?.longitude ?? null,
        elevation: georeference.site?.elevation ?? null,
      };
      const crs = {
        geodeticDatum: fromFile?.geodeticDatum ?? "",
        verticalDatum: fromFile?.verticalDatum ?? "",
        mapProjection: fromFile?.mapProjection ?? "",
        mapZone: fromFile?.mapZone ?? "",
      };
      const placement = georeference.mapConversion
        ? {
            epsg: epsg && isSupportedCrs(epsg) ? epsg : DEFAULT_EPSG,
            conversion: georeference.mapConversion,
            crs,
            site,
          }
        : null;

      setOriginal(placement);
      setDraft(
        placement ?? {
          crs,
          site,
          epsg: DEFAULT_EPSG,
          conversion: {
            eastings: 0,
            northings: 0,
            orthogonalHeight: 0,
            xAxisAbscissa: 1,
            xAxisOrdinate: 0,
            scale: 1,
          },
        },
      );
    };

    // A model in a system outside the curated list is only recognised once the
    // full EPSG index is in, so wait for it rather than falling back to the
    // default CRS and silently placing the model in the wrong one.
    const declared = resolveEpsgCode(georeference.projectedCRS?.name);
    if (declared && !isSupportedCrs(declared)) {
      void loadCrsIndex().then(() => {
        if (!cancelled) seed();
      });
    } else {
      seed();
    }
    return () => {
      cancelled = true;
    };
  }, [model?.summary.id, georeference, setDraft, setOriginal]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Where render coordinate (0, 0, 0) sits on the earth.
   *
   * `createGlobe.sync` treats its WGS point as the origin of the whole Three.js
   * frame and then transforms the camera's unmodified render coordinates from
   * there. Anchoring at the model bounds centre adds that centre twice: once in
   * the WGS anchor and again in the camera position. Resolve the render origin
   * through the inverse model-group transform instead, matching the reference
   * implementation's "shift geometry, project the same shift" rule.
   */
  const modelAnchor = useMemo(() => {
    if (!model || !draft || !model.coordinates) return null;
    // Eastings=Northings=0 is a placeholder no real site sits on (Revit's
    // default when its Survey Point was never set) — trusting it lands the
    // model near the CRS's false origin, often hundreds of km from the real
    // site, while every other level-50 check still reads as "georeferenced".
    if (isTrivialMapConversion(draft.conversion)) return null;

    const placement = placements[model.summary.id];
    const ifcMetres = worldToIfcMetres(
      ZERO,
      model.coordinates,
      placement ?? { offset: ZERO, rotationY: 0, scale: 1 },
    );
    if (!ifcMetres) return null;

    try {
      const placement = { epsg: draft.epsg, conversion: draft.conversion, lengthUnitScale };
      const mapPoint = localToMap(
        {
          x: ifcMetres[0] / lengthUnitScale,
          y: ifcMetres[1] / lengthUnitScale,
          z: ifcMetres[2] / lengthUnitScale,
        },
        placement,
      );

      return {
        centre: mapToWgs84(mapPoint, draft.epsg),
        // Grid north (what the model's render geometry is rotated to align
        // with, see `gridRotationAngle`) vs. true north (what the globe's
        // camera anchors to) — see `gridConvergence` for why this matters.
        northCorrection: gridConvergence(mapPoint, draft.epsg),
      };
    } catch {
      // An unsupported CRS, or a model still at the origin: there is nowhere
      // on earth to put it, and guessing would be a fabrication.
      return null;
    }
  }, [model, draft, placements, lengthUnitScale]);

  /**
   * The `IfcSite` pin. Where the site's latitude/longitude falls in the
   * model's own axes depends on the placement being edited, so the pin is
   * recomputed with it; it only shows while the model origins do.
   */
  const siteLatitude = draft?.site?.latitude ?? null;
  const siteLongitude = draft?.site?.longitude ?? null;
  const siteElevation = draft?.site?.elevation ?? null;
  useEffect(() => {
    const renderer = getActiveRenderer();
    const id = model?.summary.id;
    if (!renderer || !id) return;

    let position: [number, number, number] | null = null;
    if (draft && siteLatitude !== null && siteLongitude !== null && isSupportedCrs(draft.epsg)) {
      try {
        const local = wgs84ToLocal(
          { latitude: siteLatitude, longitude: siteLongitude },
          { epsg: draft.epsg, conversion: draft.conversion, lengthUnitScale },
        );
        // Height: the site's elevation above the datum, less the datum height of
        // the model origin, in the model's own axes. Without one, on the ground
        // plane of the origin.
        const conversion = draft.conversion;
        const height =
          siteElevation === null
            ? 0
            : (siteElevation - conversion.orthogonalHeight) / effectiveScale(conversion.scale, lengthUnitScale);
        const metres: [number, number, number] = [
          local.x * lengthUnitScale,
          local.y * lengthUnitScale,
          height * lengthUnitScale,
        ];
        if (metres.every(Number.isFinite)) position = metres;
      } catch {
        // A latitude/longitude the CRS cannot project: no pin rather than a wrong one.
      }
    }
    renderer.setSiteMarker(id, position);
    return () => {
      getActiveRenderer()?.setSiteMarker(id, null);
    };
    // `draft` is read for its CRS and conversion; the site fields are listed
    // separately so typing in them is what drives the pin.
  }, [model?.summary.id, ready, draft?.epsg, draft?.conversion, siteLatitude, siteLongitude, siteElevation, lengthUnitScale]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <TabsContent value="gis" forceMount className="min-h-0 flex-1 overflow-auto data-[state=inactive]:hidden">
        <GlobeControls
          origin={modelAnchor?.centre ?? null}
          northCorrection={modelAnchor?.northCorrection ?? 0}
          ready={Boolean(model?.coordinates && draft)}
        />
        <ContextModel
          placement={
            draft && model?.coordinates && !isTrivialMapConversion(draft.conversion)
              ? { conversion: draft.conversion, epsg: draft.epsg, lengthUnitScale }
              : null
          }
          referencePoint={modelAnchor?.centre ?? null}
          originShift={model?.coordinates?.originShift ?? ZERO}
          modelPlacement={model ? (placements[model.summary.id] ?? IDENTITY) : IDENTITY}
          ready={Boolean(model?.coordinates && draft)}
        />
      </TabsContent>
      <TabsContent value="georef" forceMount className="flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden">
        {!model ? (
          <p className="text-muted-foreground p-3 text-xs">
            {t("loadModel")}
          </p>
        ) : (
          <Tabs defaultValue="report" className="flex min-h-0 flex-1 flex-col">
            <TabsList className="m-2 grid grid-cols-3 bg-transparent p-0">
              <TabsTrigger value="report" className="text-xs">
                {t("tabs.report")}
              </TabsTrigger>
              <TabsTrigger value="place" className="text-xs">
                {t("tabs.place")}
              </TabsTrigger>
              <TabsTrigger value="points" className="text-xs">
                {t("tabs.points")}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="report" className="min-h-0 flex-1 overflow-auto">
              {georeference ? (
                <GeorefReportPanel view={georeference} />
              ) : (
                <p className="text-muted-foreground p-3 text-xs">
                  {t("readingGeoreferencing")}
                </p>
              )}
            </TabsContent>

            <TabsContent value="place" className="min-h-0 flex-1 overflow-auto">
              <PlacementEditor lengthUnitScale={lengthUnitScale} />
              <WriteBackPanel modelName={model.summary.name} />
            </TabsContent>

            <TabsContent value="points" className="min-h-0 flex-1 overflow-hidden">
              <ControlPointsPanel lengthUnitScale={lengthUnitScale} />
            </TabsContent>
          </Tabs>
        )}
      </TabsContent>
    </>
  );
}

export default GeorefPanels;
