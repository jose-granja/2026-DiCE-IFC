"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { FlipHorizontal, Plus, RotateCw, Scissors, Trash2 } from "lucide-react";

import { sceneBounds } from "@/lib/viewer/scene-bounds";
import { usePointCloudStore } from "@/lib/viewer/pointcloud-store";
import { useContextModelStore } from "@/lib/viewer/context-model-store";
import { useViewerStore } from "@/lib/viewer/store";
import {
  rotateSectionPlane,
  sectionRange,
  type SectionAxis,
} from "@/lib/viewer/tools";
import { HATCH_PATTERNS, type HatchPatternId } from "@/lib/viewer/section-cap";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";

import { CapStyleSettings } from "./CapStyleSettings";

export function SectionPanel() {
  const t = useTranslations("viewer.sectionPanel");

  /**
   * Section planes.
   *
   * Axes are labelled by what the cut *is* rather than by letter. The
   * renderer is Y-up, so a cut along Y is a floor plan and the other two are
   * vertical sections; "add a plan cut" is a thing a BIM user asks for, "add
   * a Y plane" is not.
   */
  const AXES: Array<{ axis: SectionAxis; label: string; hint: string }> = [
    { axis: "y", label: t("axes.plan.label"), hint: t("axes.plan.hint") },
    { axis: "x", label: t("axes.x.label"), hint: t("axes.x.hint") },
    { axis: "z", label: t("axes.z.label"), hint: t("axes.z.hint") },
  ];

  const planes = useViewerStore((s) => s.sectionPlanes);
  const addSectionPlane = useViewerStore((s) => s.addSectionPlane);
  const updateSectionPlane = useViewerStore((s) => s.updateSectionPlane);
  const removeSectionPlane = useViewerStore((s) => s.removeSectionPlane);
  const clearSectionPlanes = useViewerStore((s) => s.clearSectionPlanes);
  const capStyle = useViewerStore((s) => s.sectionCapStyle);
  const setSectionCapStyle = useViewerStore((s) => s.setSectionCapStyle);
  const models = useViewerStore((s) => s.models);
  const placements = useViewerStore((s) => s.placements);

  // `federationBounds()` builds a fresh object on every call, so using it
  // directly as a zustand selector compares unequal every render and loops
  // forever (React error #185). Select the inputs; derive the box.
  // The models and whatever was loaded around them: a plane through a scan or a
  // neighbouring building is what those are loaded for (`scene-bounds.ts`).
  const clouds = usePointCloudStore((s) => s.clouds);
  const hasContext = useContextModelStore((s) => s.loaded !== null);
  const bounds = useMemo(
    () => sceneBounds(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [models, placements, clouds, hasContext],
  );
  const hasSomething = models.length > 0 || clouds.length > 0 || hasContext;

  if (!hasSomething) {
    return (
      <p className="text-muted-foreground p-3 text-xs">
        {t("loadModel")}
      </p>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b p-2">
        {AXES.map(({ axis, label, hint }) => (
          <Button
            key={axis}
            variant="secondary"
            size="sm"
            title={hint}
            onClick={() => addSectionPlane(axis, sceneBounds())}
          >
            <Plus className="h-3.5 w-3.5" />
            {label}
          </Button>
        ))}
        {planes.length > 0 && (
          <Button variant="ghost" size="sm" onClick={clearSectionPlanes}>
            {t("clear")}
          </Button>
        )}
      </div>

      {/* The fill drawn where an enabled plane cuts through solid geometry —
          a clipping plane alone leaves the cut open. Off by default: it costs
          extra render passes per enabled plane (`renderer.ts#drawSectionCaps`). */}
      <div className="flex items-center gap-2 border-b p-2">
        <Checkbox
          id="section-cap-enabled"
          checked={capStyle.enabled}
          onCheckedChange={(checked) =>
            setSectionCapStyle({ enabled: checked === true })
          }
        />
        <label
          htmlFor="section-cap-enabled"
          className="mr-auto cursor-pointer text-xs font-medium"
        >
          {t("capFill.label")}
        </label>
        <Select
          value={capStyle.pattern}
          onValueChange={(pattern) =>
            setSectionCapStyle({ pattern: pattern as HatchPatternId })
          }
          disabled={!capStyle.enabled}
        >
          <SelectTrigger
            className="h-7 w-36 text-xs"
            aria-label={t("capFill.patternLabel")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HATCH_PATTERNS.map((pattern) => (
              <SelectItem key={pattern} value={pattern}>
                {t(`capFill.patterns.${pattern}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <CapStyleSettings />
      </div>

      {planes.length === 0 ? (
        <p className="text-muted-foreground p-3 text-xs">
          <Scissors className="mr-1 inline h-3 w-3" />
          {t("noPlanes")}
        </p>
      ) : (
        <ul className="divide-y overflow-auto">
          {planes.map((plane) => {
            const range = sectionRange(bounds, plane.axis, plane.rotation);
            const label =
              AXES.find((a) => a.axis === plane.axis)?.label ?? plane.axis;

            return (
              <li key={plane.id} className="space-y-2 p-3">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`${plane.id}-enabled`}
                    checked={plane.enabled}
                    onCheckedChange={(checked) =>
                      updateSectionPlane(plane.id, { enabled: checked === true })
                    }
                  />
                  <label
                    htmlFor={`${plane.id}-enabled`}
                    className="flex-1 cursor-pointer text-sm font-medium"
                  >
                    {label}
                  </label>

                  <Button
                    variant="ghost"
                    size="icon"
                    title={
                      plane.flipped
                        ? t("flipFarSide")
                        : t("flipNearSide")
                    }
                    aria-label={t("flipWhichSide")}
                    aria-pressed={plane.flipped}
                    onClick={() =>
                      updateSectionPlane(plane.id, { flipped: !plane.flipped })
                    }
                  >
                    <FlipHorizontal className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("removePlane")}
                    onClick={() => removeSectionPlane(plane.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                <div className="flex items-center gap-3">
                  <Slider
                    aria-label={t("positionLabel", { label })}
                    min={range.min}
                    max={range.max}
                    step={(range.max - range.min) / 500 || 0.01}
                    value={[plane.position]}
                    disabled={!plane.enabled}
                    onValueChange={([position]) =>
                      updateSectionPlane(plane.id, { position })
                    }
                  />
                  <span className="text-muted-foreground w-16 shrink-0 text-right text-xs tabular-nums">
                    {plane.position.toFixed(2)} m
                  </span>
                </div>

                {plane.axis !== "y" && (
                  <div className="flex items-center gap-3">
                    <RotateCw
                      className="text-muted-foreground h-3.5 w-3.5 shrink-0"
                      aria-hidden
                    />
                    <Slider
                      aria-label={t("rotationLabel", { label })}
                      min={-180}
                      max={180}
                      step={1}
                      value={[plane.rotation]}
                      disabled={!plane.enabled}
                      onValueChange={([rotation]) =>
                        updateSectionPlane(
                          plane.id,
                          rotateSectionPlane(plane, rotation, bounds),
                        )
                      }
                    />
                    <span className="text-muted-foreground w-16 shrink-0 text-right text-xs tabular-nums">
                      {plane.rotation.toFixed(0)}°
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {planes.some((plane) => plane.enabled) && (
        <p className="text-muted-foreground border-t p-2 text-[11px]">
          {t("handlesHint")}
        </p>
      )}
    </div>
  );
}

export default SectionPanel;
