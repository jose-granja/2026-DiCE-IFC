"use client";

import {
  Angle,
  Box,
  Pentagon,
  Ruler,
  Square,
  Trash2,
  Triangle,
  ChevronsDownUp,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { ComponentType } from "react";

import { usePointCloudStore } from "@/lib/viewer/pointcloud-store";
import { useContextModelStore } from "@/lib/viewer/context-model-store";
import { useViewerStore } from "@/lib/viewer/store";
import {
  angleBetween,
  boxVolume,
  facePatchArea,
  formatAngle,
  formatArea,
  formatLength,
  formatVolume,
  measure,
  polygonArea,
  type SnapTargetType,
} from "@/lib/viewer/tools";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** "corners", "corners and edges", "corners, edge midpoints and edges" — for the hint text. */
function joinNouns(nouns: string[], and: string): string {
  if (nouns.length <= 1) return nouns[0] ?? "";
  return `${nouns.slice(0, -1).join(", ")} ${and} ${nouns[nouns.length - 1]}`;
}

type MeasureTool =
  | "measureDistance"
  | "measureAngle"
  | "measureArea"
  | "measureVolume";

/** A results section's header: title, count, and its own "Clear" — each kind has its own list, so a single global Clear would be ambiguous about which one it means. */
function SectionHeader({
  title,
  count,
  onClear,
}: {
  title: string;
  count: number;
  onClear: () => void;
}) {
  const t = useTranslations("viewer.measurePanel");
  return (
    <div className="flex items-center justify-between border-b px-3 py-1.5">
      <span className="text-xs font-medium">
        {title} ({count})
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        onClick={onClear}
      >
        {t("clear")}
      </Button>
    </div>
  );
}

/**
 * Measurements taken in the viewport: distance, angle, area and volume.
 *
 * One tool is active at a time (`tool`), but every kind's results stay listed
 * regardless of which is active — switching to Angle to measure a corner
 * should not make earlier distance measurements disappear from the panel.
 */
export function MeasurePanel() {
  const t = useTranslations("viewer.measurePanel");

  // Same shapes the in-viewport snap-preview marker uses for each target
  // type (`renderer.ts`'s `createSnapMarkerTexture`) — a corner is a square,
  // an edge midpoint a triangle, a point on an edge a ChevronsUpDown — so the toggle
  // a user clicks and the marker it turns on read as the same thing.
  const SNAP_TARGET_OPTIONS: Array<{
    type: SnapTargetType;
    label: string;
    noun: string;
    icon: ComponentType<{ className?: string }>;
  }> = [
    { type: "corner", label: t("snap.corners"), noun: t("snap.cornersNoun"), icon: Square },
    {
      type: "edgeMidpoint",
      label: t("snap.edgeMidpoints"),
      noun: t("snap.edgeMidpointsNoun"),
      icon: Triangle,
    },
    { type: "edge", label: t("snap.edges"), noun: t("snap.edgesNoun"), icon: ChevronsDownUp },
  ];

  const TOOL_OPTIONS: Array<{
    tool: MeasureTool;
    label: string;
    icon: ComponentType<{ className?: string }>;
  }> = [
    { tool: "measureDistance", label: t("tools.distance"), icon: Ruler },
    { tool: "measureAngle", label: t("tools.angle"), icon: Angle },
    { tool: "measureArea", label: t("tools.area"), icon: Pentagon },
    { tool: "measureVolume", label: t("tools.volume"), icon: Box },
  ];

  const tool = useViewerStore((s) => s.tool);
  const setTool = useViewerStore((s) => s.setTool);
  const snapTargets = useViewerStore((s) => s.snapTargets);
  const setSnapTarget = useViewerStore((s) => s.setSnapTarget);
  // A scan or a neighbouring building can be measured as well as a model.
  const modelCount = useViewerStore((s) => s.models.length);
  const cloudCount = usePointCloudStore((s) => s.clouds.length);
  const hasContext = useContextModelStore((s) => s.loaded !== null);

  const measurements = useViewerStore((s) => s.measurements);
  const pendingPoint = useViewerStore((s) => s.pendingPoint);
  const removeMeasurement = useViewerStore((s) => s.removeMeasurement);
  const clearMeasurements = useViewerStore((s) => s.clearMeasurements);

  const angleMeasurements = useViewerStore((s) => s.angleMeasurements);
  const pendingAnglePoints = useViewerStore((s) => s.pendingAnglePoints);
  const removeAngleMeasurement = useViewerStore(
    (s) => s.removeAngleMeasurement,
  );
  const clearAngleMeasurements = useViewerStore(
    (s) => s.clearAngleMeasurements,
  );

  const areaMeasurements = useViewerStore((s) => s.areaMeasurements);
  const areaMode = useViewerStore((s) => s.areaMode);
  const setAreaMode = useViewerStore((s) => s.setAreaMode);
  const pendingAreaPoints = useViewerStore((s) => s.pendingAreaPoints);
  const finishAreaMeasurement = useViewerStore((s) => s.finishAreaMeasurement);
  const removeAreaMeasurement = useViewerStore((s) => s.removeAreaMeasurement);
  const clearAreaMeasurements = useViewerStore((s) => s.clearAreaMeasurements);

  const volumeMeasurements = useViewerStore((s) => s.volumeMeasurements);
  const volumeMode = useViewerStore((s) => s.volumeMode);
  const setVolumeMode = useViewerStore((s) => s.setVolumeMode);
  const pendingBoxCorner = useViewerStore((s) => s.pendingBoxCorner);
  const removeVolumeMeasurement = useViewerStore(
    (s) => s.removeVolumeMeasurement,
  );
  const clearVolumeMeasurements = useViewerStore(
    (s) => s.clearVolumeMeasurements,
  );

  if (modelCount === 0 && cloudCount === 0 && !hasContext) {
    return (
      <p className="text-muted-foreground p-3 text-xs">
        {t("loadModel")}
      </p>
    );
  }

  const activeSnapNouns = SNAP_TARGET_OPTIONS.filter(
    ({ type }) => snapTargets[type],
  ).map(({ noun }) => noun);
  const snapHint =
    activeSnapNouns.length > 0
      ? t("snap.hintOn", { list: joinNouns(activeSnapNouns, t("snap.and")) })
      : t("snap.hintOff");

  // Snapping only ever applies to a click that picks a *point* on the model.
  // Volume's "element" mode and area's "face" mode each pick a whole entity
  // instead, so the toggles above would describe a behaviour those modes
  // do not have.
  const showSnapTargets =
    (tool !== "measureVolume" || volumeMode === "box") &&
    (tool !== "measureArea" || areaMode === "points");

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b p-2">
        {TOOL_OPTIONS.map(({ tool: candidate, label, icon: Icon }) => (
          <Tooltip key={candidate}>
            <TooltipTrigger asChild>
              <Button
                key={candidate}
                variant={tool === candidate ? "default" : "secondary"}
                size="sm"
                aria-pressed={tool === candidate}
                aria-label={label}
                onClick={() =>
                  setTool(tool === candidate ? "select" : candidate)
                }
              >
                <Icon className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{label}</p>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>

      {showSnapTargets && (
        <div className="flex flex-col gap-1.5 border-b px-3 py-2">
          <span className="text-muted-foreground text-xs font-medium">
            {t("snap.snapTo")}
          </span>
          <div className="flex flex-wrap gap-1">
            {SNAP_TARGET_OPTIONS.map(({ type, label, icon: Icon }) => (
              <Tooltip key={type}>
                {/*
                  A plain wrapper, not `asChild` straight onto `Toggle`:
                  Radix's Tooltip and Toggle primitives each render their own
                  `data-state` onto whatever DOM node they're given, and
                  `asChild` here would merge both onto the *same* button —
                  Tooltip's open/closed value stomping Toggle's on/off one,
                  so a pressed toggle randomly stops looking pressed. The
                  wrapper gives Tooltip a node of its own to decorate.
                */}
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Toggle
                      size="sm"
                      pressed={snapTargets[type]}
                      onPressedChange={(pressed) => setSnapTarget(type, pressed)}
                      aria-label={label}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </Toggle>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{label}</p>
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        </div>
      )}

      {tool === "measureArea" && (
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <span className="text-muted-foreground text-xs font-medium">
            {t("area.of")}
          </span>
          <Button
            variant={areaMode === "face" ? "default" : "secondary"}
            size="sm"
            onClick={() => setAreaMode("face")}
          >
            {t("area.clickedFace")}
          </Button>
          <Button
            variant={areaMode === "points" ? "default" : "secondary"}
            size="sm"
            onClick={() => setAreaMode("points")}
          >
            {t("area.pointsIClick")}
          </Button>
        </div>
      )}

      {tool === "measureVolume" && (
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <span className="text-muted-foreground text-xs font-medium">
            {t("volume.of")}
          </span>
          <Button
            variant={volumeMode === "element" ? "default" : "secondary"}
            size="sm"
            onClick={() => setVolumeMode("element")}
          >
            {t("volume.clickedElement")}
          </Button>
          <Button
            variant={volumeMode === "box" ? "default" : "secondary"}
            size="sm"
            onClick={() => setVolumeMode("box")}
          >
            {t("volume.boxBetweenTwoPoints")}
          </Button>
        </div>
      )}

      {tool === "measureDistance" && (
        <p className="text-muted-foreground border-b px-3 py-2 text-xs">
          {pendingPoint
            ? t("distance.hintSecondPoint")
            : t("distance.hint", { snapHint })}
        </p>
      )}

      {tool === "measureAngle" && (
        <p className="text-muted-foreground border-b px-3 py-2 text-xs">
          {pendingAnglePoints.length === 0 &&
            t("angle.hintFirst", { snapHint })}
          {pendingAnglePoints.length === 1 && t("angle.hintCorner")}
          {pendingAnglePoints.length === 2 && t("angle.hintSecond")}
        </p>
      )}

      {tool === "measureArea" &&
        (areaMode === "face" ? (
          <p className="text-muted-foreground border-b px-3 py-2 text-xs">
            {t("area.hintFace")}
          </p>
        ) : (
          <div className="text-muted-foreground border-b px-3 py-2 text-xs">
            <p>
              {pendingAreaPoints.length >= 3
                ? t("area.hintPointsCanFinish", { snapHint })
                : t("area.hintPoints", { snapHint })}
            </p>
            {pendingAreaPoints.length >= 3 && (
              <Button
                size="sm"
                className="mt-1.5"
                onClick={finishAreaMeasurement}
              >
                {t("area.finish", { count: pendingAreaPoints.length })}
              </Button>
            )}
          </div>
        ))}

      {tool === "measureVolume" && (
        <p className="text-muted-foreground border-b px-3 py-2 text-xs">
          {volumeMode === "element"
            ? t("volume.hintElement")
            : pendingBoxCorner
              ? t("volume.hintSecondCorner")
              : t("volume.hintFirstCorner", { snapHint })}
        </p>
      )}

      <div className="flex-1 overflow-auto">
        {measurements.length === 0 &&
          angleMeasurements.length === 0 &&
          areaMeasurements.length === 0 &&
          volumeMeasurements.length === 0 && (
            <p className="text-muted-foreground p-3 text-xs">
              {t("noneYet")}
            </p>
          )}

        {measurements.length > 0 && (
          <>
            <SectionHeader
              title={t("distance.sectionTitle")}
              count={measurements.length}
              onClear={clearMeasurements}
            />
            <ul className="divide-y">
              {measurements.map((measurement, index) => {
                const readout = measure(measurement);
                return (
                  <li
                    key={measurement.id}
                    className="flex items-start gap-2 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium tabular-nums">
                        {formatLength(readout.distance)}
                      </p>
                      <p className="text-muted-foreground text-xs tabular-nums">
                        {t("distance.rowDetail", {
                          plan: formatLength(readout.horizontal),
                          vertical: formatLength(readout.vertical),
                        })}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("distance.remove", { index: index + 1 })}
                      onClick={() => removeMeasurement(measurement.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {angleMeasurements.length > 0 && (
          <>
            <SectionHeader
              title={t("angle.sectionTitle")}
              count={angleMeasurements.length}
              onClear={clearAngleMeasurements}
            />
            <ul className="divide-y">
              {angleMeasurements.map((measurement, index) => (
                <li
                  key={measurement.id}
                  className="flex items-start gap-2 px-3 py-2"
                >
                  <p className="min-w-0 flex-1 text-sm font-medium tabular-nums">
                    {formatAngle(angleBetween(measurement))}
                  </p>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("angle.remove", { index: index + 1 })}
                    onClick={() => removeAngleMeasurement(measurement.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}

        {areaMeasurements.length > 0 && (
          <>
            <SectionHeader
              title={t("area.sectionTitle")}
              count={areaMeasurements.length}
              onClear={clearAreaMeasurements}
            />
            <ul className="divide-y">
              {areaMeasurements.map((measurement, index) => (
                <li
                  key={measurement.id}
                  className="flex items-start gap-2 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium tabular-nums">
                      {formatArea(
                        measurement.kind === "face"
                          ? facePatchArea(measurement.triangles)
                          : polygonArea(measurement.points),
                      )}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {measurement.kind === "face"
                        ? t("area.clickedFace")
                        : t("area.pointCount", { count: measurement.points.length })}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("area.remove", { index: index + 1 })}
                    onClick={() => removeAreaMeasurement(measurement.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}

        {volumeMeasurements.length > 0 && (
          <>
            <SectionHeader
              title={t("volume.sectionTitle")}
              count={volumeMeasurements.length}
              onClear={clearVolumeMeasurements}
            />
            <ul className="divide-y">
              {volumeMeasurements.map((measurement, index) => (
                <li
                  key={measurement.id}
                  className="flex items-start gap-2 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium tabular-nums">
                      {formatVolume(
                        measurement.kind === "element"
                          ? measurement.volume
                          : boxVolume(measurement.corner1, measurement.corner2),
                      )}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {measurement.kind === "element"
                        ? t("volume.clickedElement")
                        : t("volume.box")}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("volume.remove", { index: index + 1 })}
                    onClick={() => removeVolumeMeasurement(measurement.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

export default MeasurePanel;
