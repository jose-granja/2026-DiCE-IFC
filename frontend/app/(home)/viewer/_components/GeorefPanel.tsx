"use client";

import { useEffect, useMemo } from "react";
import { useTranslations } from "next-intl";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DEFAULT_EPSG } from "@/config";
import { isTrivialMapConversion, resolveEpsgCode } from "@/lib/georef/logeoref";
import { useGeorefStore } from "@/lib/georef/store";
import { gridConvergence, isSupportedCrs, localToMap, mapToWgs84 } from "@/lib/georef/transform";
import GlobeControls from "./GlobeControls";
import ContextModel from "./ContextModel";
import { federatedBounds, renderToIfc } from "@/lib/viewer/federation";
import { useViewerStore } from "@/lib/viewer/store";
import type { Vec3 } from "@/lib/ifc/types";

import GeorefReportPanel from "@/app/(home)/georef/_components/GeorefReportPanel";
import ControlPointsPanel from "@/app/(home)/georef/_components/ControlPointsPanel";
import PlacementEditor from "@/app/(home)/georef/_components/PlacementEditor";
import WriteBackPanel from "@/app/(home)/georef/_components/WriteBackPanel";

/**
 * Georeferencing, in the viewer.
 *
 * The old page put a 2D map beside the model and drew its footprint on it as a
 * polygon. The question being answered — is this building in the right place,
 * facing the right way — is a 3D one, so the map now goes **under the model**
 * in the viewport and you fly around it.
 *
 * The map is optional and off by default: it is the only part of this
 * application that talks to a third party, and a tile request says roughly
 * where the building is (ADR 003).
 */
/** Shared so the prop identity is stable across renders. */
const ZERO: Vec3 = [0, 0, 0];

export function GeorefPanel() {
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

    const epsg = resolveEpsgCode(georeference.projectedCRS?.name);
    const placement = georeference.mapConversion
      ? {
          epsg: epsg && isSupportedCrs(epsg) ? epsg : DEFAULT_EPSG,
          conversion: georeference.mapConversion,
        }
      : null;

    setOriginal(placement);
    setDraft(
      placement ?? {
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
  }, [model?.summary.id, georeference, setDraft, setOriginal]); // eslint-disable-line react-hooks/exhaustive-deps

  const bounds = useMemo(
    () =>
      federatedBounds(
        models
          .filter((entry) => entry.coordinates && entry.visible)
          .map((entry) => ({
            bounds: entry.coordinates!.shiftedBounds,
            offset: placements[entry.summary.id]?.offset ?? [0, 0, 0],
          })),
      ),
    [models, placements],
  );

  /**
   * Where the model sits on the earth.
   *
   * The globe is anchored to the *model*, never the camera: Cesium streams
   * whatever the view needs by itself, and re-anchoring as the camera moves
   * would throw that away on every zoom.
   */
  const modelAnchor = useMemo(() => {
    if (!model || !draft || !bounds) return null;
    // Eastings=Northings=0 is a placeholder no real site sits on (Revit's
    // default when its Survey Point was never set) — trusting it lands the
    // model near the CRS's false origin, often hundreds of km from the real
    // site, while every other level-50 check still reads as "georeferenced".
    if (isTrivialMapConversion(draft.conversion)) return null;

    const groundCentre: Vec3 = [
      (bounds.min[0] + bounds.max[0]) / 2,
      bounds.min[1],
      (bounds.min[2] + bounds.max[2]) / 2,
    ];

    const shift = model.coordinates?.originShift ?? ZERO;
    const offset = placements[model.summary.id]?.offset ?? ZERO;
    const ifc = renderToIfc([
      groundCentre[0] - offset[0] + shift[0],
      groundCentre[1] - offset[1] + shift[1],
      groundCentre[2] - offset[2] + shift[2],
    ]);

    try {
      const placement = { epsg: draft.epsg, conversion: draft.conversion, lengthUnitScale };
      const mapPoint = localToMap(
        {
          x: ifc[0] / lengthUnitScale,
          y: ifc[1] / lengthUnitScale,
          z: ifc[2] / lengthUnitScale,
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
  }, [model, draft, bounds, placements, lengthUnitScale]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <GlobeControls
        origin={modelAnchor?.centre ?? null}
        northCorrection={modelAnchor?.northCorrection ?? 0}
      />
      <ContextModel
        placement={
          draft && model?.coordinates
            ? { conversion: draft.conversion, epsg: draft.epsg, lengthUnitScale }
            : null
        }
        referencePoint={modelAnchor?.centre ?? null}
        originShift={model?.coordinates?.originShift ?? [0, 0, 0]}
        modelOffset={model ? (placements[model.summary.id]?.offset ?? ZERO) : ZERO}
      />

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
    </div>
  );
}

export default GeorefPanel;
