"use client";

import { useEffect, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";

import { getActiveRenderer } from "@/lib/viewer/active-renderer";
import { getModelHandle } from "@/lib/viewer/loader";
import { MAX_SURFACE_LAYERS } from "@/lib/viewer/renderer";
import { applyRealisticMaterials, type RealisticModel } from "@/lib/viewer/realistic/apply";
import { SOURCE_HOMES, SOURCE_NAMES, useRealisticStore } from "@/lib/viewer/realistic/store";
import { useViewerStore } from "@/lib/viewer/store";

/**
 * Keeps the scene's realistic materials in step with the switch and the
 * models: on, it searches and applies textures to every model with geometry,
 * and again whenever one is added or rebuilt; off, it puts the IFC colours
 * back. Renders a credit naming the libraries whose textures are on screen
 * (Poly Haven's API terms ask for one; 360into's do not, but it is due) while textures
 * are on screen.
 */
export function RealisticMaterials({ ready }: { ready: boolean }) {
  const t = useTranslations("viewer.realistic");
  const on = useRealisticStore((s) => s.on);
  const status = useRealisticStore((s) => s.status);
  const applied = useRealisticStore((s) => s.applied);
  const models = useViewerStore((s) => s.models);
  const textured = useRealisticStore((s) => s.textured);
  // Whether textures may be on the scene, so turning nothing off costs nothing.
  const drawn = useRef(false);
  // A new key when a model gains or loses geometry: setModelGeometry rebuilds
  // the batches, and with them their texture layers.
  const key = useMemo(
    () => models.filter((m) => m.hasGeometry).map((m) => m.summary.id).sort().join("|"),
    [models],
  );

  useEffect(() => {
    const renderer = getActiveRenderer();
    if (!ready || !renderer) return;
    if (!on) {
      if (drawn.current) renderer.clearSurfaceTextures();
      drawn.current = false;
      return;
    }
    drawn.current = true;
    const controller = new AbortController();
    const targets: RealisticModel[] = key
      .split("|")
      .filter(Boolean)
      .flatMap((modelId) => {
        const handle = getModelHandle(modelId);
        return handle ? [{ modelId, getSurfaceMaterials: () => handle.getSurfaceMaterials() }] : [];
      });
    const store = useRealisticStore.getState();
    store.update({ status: "searching", progress: null, error: null });
    applyRealisticMaterials(renderer, targets, {
      signal: controller.signal,
      maxLayers: MAX_SURFACE_LAYERS,
      onProgress: (progress) => {
        if (!controller.signal.aborted) useRealisticStore.getState().update({ progress });
      },
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        useRealisticStore.getState().update({
          status: "ready",
          progress: null,
          ...result,
          textured: renderer.texturedVertexCount,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        renderer.clearSurfaceTextures();
        useRealisticStore.getState().update({
          status: "failed",
          progress: null,
          textured: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => controller.abort();
  }, [on, ready, key]);

  if (!on || status !== "ready" || applied.length === 0) {
    return <span hidden data-realistic-status={on ? status : "off"} data-surface-textured={0} />;
  }
  // Every library whose textures are on screen, in a fixed order.
  const used = (Object.keys(SOURCE_NAMES) as Array<keyof typeof SOURCE_NAMES>).filter((id) =>
    applied.some((line) => line.source === id),
  );
  return (
    <div
      className="bg-background/80 text-muted-foreground pointer-events-auto rounded px-1 text-right"
      data-realistic-credit
      data-realistic-status={status}
      data-surface-textured={textured}
    >
      {t("credit")}{" "}
      {used.map((id, index) => (
        <span key={id}>
          {index > 0 && " · "}
          <a href={SOURCE_HOMES[id]} target="_blank" rel="noopener noreferrer" className="underline">
            {SOURCE_NAMES[id]}
          </a>
        </span>
      ))}
    </div>
  );
}

export default RealisticMaterials;
