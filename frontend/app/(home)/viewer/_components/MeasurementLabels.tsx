"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { getActiveRenderer } from "@/lib/viewer/active-renderer";
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
  NEGLIGIBLE_LEG,
  polygonArea,
} from "@/lib/viewer/tools";

type ScreenPosition = { x: number; y: number; visible: boolean };
type MeasurementPositions = {
  total: ScreenPosition;
  horizontal: ScreenPosition;
  vertical: ScreenPosition;
};

function round(screen: { x: number; y: number; visible: boolean }): ScreenPosition {
  // Rounded to whole pixels, so a still camera produces an identical key and
  // no re-render.
  return { x: Math.round(screen.x), y: Math.round(screen.y), visible: screen.visible };
}

/**
 * Poll the renderer for a set of measurements' label positions on every
 * animation frame, re-rendering only when the (rounded) result actually
 * changes.
 *
 * Shared by all four measurement kinds below rather than four copies of the
 * same loop: the camera moves continuously under OrbitControls with no event
 * for "the view changed", so each kind needs this same polling shape, and
 * only `project` (what a label position means for that kind) differs.
 */
function useLabelPositions<M extends { id: string }, P>(
  measurements: M[],
  project: (renderer: NonNullable<ReturnType<typeof getActiveRenderer>>, m: M) => P,
): Record<string, P> {
  const [positions, setPositions] = useState<Record<string, P>>({});

  useEffect(() => {
    if (measurements.length === 0) return;
    let previous = "";
    let frame = 0;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const renderer = getActiveRenderer();
      if (!renderer) return;

      const next: Record<string, P> = {};
      for (const measurement of measurements) next[measurement.id] = project(renderer, measurement);

      const key = JSON.stringify(next);
      if (key !== previous) {
        previous = key;
        setPositions(next);
      }
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // `project` is a fresh closure every render by design (it closes over
    // nothing that changes independently of `measurements`), so it is
    // deliberately not a dependency — including it would restart the loop
    // every render instead of only when the measurement list itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measurements]);

  return positions;
}

/**
 * Every measurement kind's labels, drawn over the canvas.
 *
 * HTML rather than in-scene sprites: text stays crisp at any zoom, it is
 * selectable, and a screen reader can reach it — the numbers are the point of
 * the tool, so they should not be locked inside a canvas.
 *
 * Which labels exist is derived from the store at render time, not stored
 * state, so clearing a measurement list needs no extra write and cannot leave
 * a stale label behind.
 */
export function MeasurementLabels() {
  const t = useTranslations("viewer.measureLabels");
  const measurements = useViewerStore((s) => s.measurements);
  const angleMeasurements = useViewerStore((s) => s.angleMeasurements);
  const areaMeasurements = useViewerStore((s) => s.areaMeasurements);
  const volumeMeasurements = useViewerStore((s) => s.volumeMeasurements);

  const distancePositions = useLabelPositions(measurements, (renderer, m): MeasurementPositions => ({
    total: round(renderer.labelPosition(m)),
    horizontal: round(renderer.horizontalLabelPosition(m)),
    vertical: round(renderer.verticalLabelPosition(m)),
  }));
  const anglePositions = useLabelPositions(angleMeasurements, (renderer, m) =>
    round(renderer.angleLabelPosition(m)),
  );
  const areaPositions = useLabelPositions(areaMeasurements, (renderer, m) =>
    round(renderer.areaLabelPosition(m)),
  );
  const volumePositions = useLabelPositions(volumeMeasurements, (renderer, m) =>
    round(renderer.volumeLabelPosition(m)),
  );

  return (
    <div
      data-measurement-labels
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {measurements.map((measurement) => {
        const position = distancePositions[measurement.id];
        if (!position) return null;
        const readout = measure(measurement);

        return (
          <div key={measurement.id}>
            {position.total.visible && (
              <span
                className="z-10 bg-background/90 border-primary/40 text-foreground absolute -translate-x-1/2 -translate-y-1/2 rounded border px-1.5 py-0.5 text-xs font-medium tabular-nums shadow-sm"
                style={{ left: position.total.x, top: position.total.y }}
              >
                {formatLength(readout.distance)}
              </span>
            )}
            {/*
              Horizontal/vertical: smaller and fainter than the total, so the
              straight-line distance still reads first — these are the
              breakdown, not a second answer to "how far". The total is `z-10`
              so it also stays on top where a short leg's tag overlaps it.
            */}
            {position.horizontal.visible && readout.horizontal > NEGLIGIBLE_LEG && (
              <span
                className="bg-background/80 border-border text-muted-foreground absolute -translate-x-1/2 -translate-y-1/2 rounded border px-1 py-0.5 text-[10px] tabular-nums"
                style={{ left: position.horizontal.x, top: position.horizontal.y }}
              >
                {t("plan")} {formatLength(readout.horizontal)}
              </span>
            )}
            {position.vertical.visible && Math.abs(readout.vertical) > NEGLIGIBLE_LEG && (
              <span
                className="bg-background/80 border-border text-muted-foreground absolute -translate-x-1/2 -translate-y-1/2 rounded border px-1 py-0.5 text-[10px] tabular-nums"
                style={{ left: position.vertical.x, top: position.vertical.y }}
              >
                {t("vertical")} {formatLength(readout.vertical)}
              </span>
            )}
          </div>
        );
      })}

      {angleMeasurements.map((measurement) => {
        const position = anglePositions[measurement.id];
        if (!position?.visible) return null;
        return (
          <span
            key={measurement.id}
            className="bg-background/90 text-foreground absolute -translate-x-1/2 -translate-y-1/2 rounded border px-1.5 py-0.5 text-xs font-medium tabular-nums shadow-sm"
            style={{ left: position.x, top: position.y, borderColor: "#e0af68" }}
          >
            {formatAngle(angleBetween(measurement))}
          </span>
        );
      })}

      {areaMeasurements.map((measurement) => {
        const position = areaPositions[measurement.id];
        if (!position?.visible) return null;
        const area =
          measurement.kind === "face"
            ? facePatchArea(measurement.triangles)
            : polygonArea(measurement.points);
        return (
          <span
            key={measurement.id}
            className="bg-background/90 text-foreground absolute -translate-x-1/2 -translate-y-1/2 rounded border px-1.5 py-0.5 text-xs font-medium tabular-nums shadow-sm"
            style={{ left: position.x, top: position.y, borderColor: "#9ece6a" }}
          >
            {formatArea(area)}
          </span>
        );
      })}

      {volumeMeasurements.map((measurement) => {
        const position = volumePositions[measurement.id];
        if (!position?.visible) return null;
        const volume =
          measurement.kind === "element"
            ? measurement.volume
            : boxVolume(measurement.corner1, measurement.corner2);
        return (
          <span
            key={measurement.id}
            className="bg-background/90 text-foreground absolute -translate-x-1/2 -translate-y-1/2 rounded border px-1.5 py-0.5 text-xs font-medium tabular-nums shadow-sm"
            style={{ left: position.x, top: position.y, borderColor: "#bb9af7" }}
          >
            {formatVolume(volume)}
          </span>
        );
      })}
    </div>
  );
}

export default MeasurementLabels;
