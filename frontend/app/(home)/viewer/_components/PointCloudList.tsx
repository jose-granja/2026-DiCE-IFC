"use client";

import { useTranslations } from "next-intl";
import { AlertTriangle, Eye, EyeOff, Focus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { getActiveRenderer } from "@/lib/viewer/active-renderer";
import { availableModes, type PointColourMode } from "@/lib/pointcloud/colour";
import type { CloudFrame } from "@/lib/pointcloud/place";
import { removePointCloud } from "@/lib/viewer/pointcloud-loader";
import { resolveCloudTransform } from "@/lib/viewer/pointcloud-placement";
import { usePointCloudStore } from "@/lib/viewer/pointcloud-store";
import { useViewerStore } from "@/lib/viewer/store";

/**
 * The scanned point clouds in the scene.
 *
 * Under the model list rather than in it: a cloud is a reference to compare the
 * model against, not a model — no entities, no properties, nothing to validate.
 * See `lib/viewer/pointcloud-store.ts`.
 */
export function PointCloudList() {
  const t = useTranslations("viewer.pointClouds");
  const clouds = usePointCloudStore((state) => state.clouds);
  const update = usePointCloudStore((state) => state.update);
  const edgeShading = usePointCloudStore((state) => state.edgeShading);
  const setEdgeShading = usePointCloudStore((state) => state.setEdgeShading);
  const models = useViewerStore((state) => state.models);
  const placements = useViewerStore((state) => state.placements);
  const worldOrigin = useViewerStore((state) => state.worldOrigin);

  if (clouds.length === 0) return null;

  return (
    <section className="border-t" data-point-cloud-list>
      <div className="flex items-center justify-between gap-2 px-3 pt-2.5">
        <h3 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">{t("title")}</h3>
        <div className="flex items-center gap-1.5" title={t("edgeShadingHint")}>
          <Label htmlFor="point-cloud-edge-shading" className="text-muted-foreground text-[11px] font-normal">
            {t("edgeShading")}
          </Label>
          <Switch
            id="point-cloud-edge-shading"
            checked={edgeShading}
            onCheckedChange={setEdgeShading}
          />
        </div>
      </div>
      <ul className="divide-y">
        {clouds.map((entry) => {
          const ready = entry.status === "ready" && entry.cloud;
          const { problem } = resolveCloudTransform(entry, { models, placements, worldOrigin });
          const modes = entry.cloud ? availableModes(entry.cloud) : [];

          return (
            <li key={entry.id} className="px-3 py-2.5" data-point-cloud-item={entry.name}>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={entry.name}>
                    {entry.name}
                  </p>

                  {ready && entry.cloud && (
                    <p className="text-muted-foreground text-xs">
                      {entry.cloud.sourcePointCount > entry.cloud.pointCount
                        ? t("thinned", {
                            shown: entry.cloud.pointCount,
                            total: entry.cloud.sourcePointCount,
                          })
                        : t("pointCount", { count: entry.cloud.pointCount })}
                    </p>
                  )}

                  {entry.status === "loading" && (
                    <div className="mt-1.5">
                      <Progress value={Math.round(entry.progress * 100)} className="h-1" />
                      <p className="text-muted-foreground mt-1 text-[11px]">
                        {t("reading", { percent: Math.round(entry.progress * 100) })}
                      </p>
                    </div>
                  )}

                  {entry.status === "failed" && (
                    <p className="text-destructive mt-1 flex items-start gap-1 text-[11px]">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                      {entry.error}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 items-center">
                  {ready && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("zoomTo", { name: entry.name })}
                        onClick={() => {
                          const renderer = getActiveRenderer();
                          renderer?.fitToBounds(renderer.getPointCloudBounds(entry.id) ?? null);
                        }}
                      >
                        <Focus className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={
                          entry.visible
                            ? t("hide", { name: entry.name })
                            : t("show", { name: entry.name })
                        }
                        aria-pressed={!entry.visible}
                        onClick={() => update(entry.id, { visible: !entry.visible })}
                      >
                        {entry.visible ? (
                          <Eye className="h-4 w-4" />
                        ) : (
                          <EyeOff className="text-muted-foreground h-4 w-4" />
                        )}
                      </Button>
                    </>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={
                      entry.status === "loading"
                        ? t("cancel", { name: entry.name })
                        : t("remove", { name: entry.name })
                    }
                    onClick={() => removePointCloud(entry.id)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {ready && (
                <div className="mt-2 space-y-2">
                  <div className="grid grid-cols-[5.5rem_1fr] items-center gap-x-2 gap-y-2">
                    <Label htmlFor={`${entry.id}-colour`} className="text-xs font-normal">
                      {t("colour")}
                    </Label>
                    <Select
                      value={entry.mode}
                      onValueChange={(mode) => update(entry.id, { mode: mode as PointColourMode })}
                    >
                      <SelectTrigger id={`${entry.id}-colour`} className="h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {modes.map((mode) => (
                          <SelectItem key={mode} value={mode}>
                            {t(`modes.${mode}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    <Label htmlFor={`${entry.id}-size`} className="text-xs font-normal">
                      {t("size")}
                    </Label>
                    <Slider
                      id={`${entry.id}-size`}
                      aria-label={t("size")}
                      min={1}
                      max={8}
                      step={0.5}
                      value={[entry.size]}
                      onValueChange={([size]) => update(entry.id, { size })}
                    />

                    <Label htmlFor={`${entry.id}-frame`} className="text-xs font-normal">
                      {t("coordinates")}
                    </Label>
                    <Select
                      value={entry.frame}
                      onValueChange={(frame) => update(entry.id, { frame: frame as CloudFrame })}
                    >
                      <SelectTrigger id={`${entry.id}-frame`} className="h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="map">{t("frames.map")}</SelectItem>
                        <SelectItem value="model">{t("frames.model")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {problem && (
                    <p className="text-warning flex items-start gap-1 text-[11px]" role="status">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                      {t(`problems.${problem}`)}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default PointCloudList;
