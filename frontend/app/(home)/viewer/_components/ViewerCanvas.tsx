"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { ViewerRenderer, detectWebGpu } from "@/lib/viewer/renderer";
import { setActiveRenderer } from "@/lib/viewer/active-renderer";
import { usePointClouds } from "./usePointClouds";
import { usePointCloudStore } from "@/lib/viewer/pointcloud-store";
import { getModelHandle } from "@/lib/viewer/loader";
import { useViewerStore } from "@/lib/viewer/store";
import { hasAnySnapTarget } from "@/lib/viewer/tools";
import MeasurementLabels from "./MeasurementLabels";
import { Button } from "@/components/ui/button";
import { Axis3D, Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { setGlobeCanvas } from "@/lib/viewer/globe-canvas";
import type { CameraProjection } from "@/lib/viewer/camera";
import ViewCube, { type ViewCubeRef } from "./ViewCube";
import ViewerContextMenu, { type ViewerContextMenuState } from "./ViewerContextMenu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Above this many CSS pixels of movement between pointerdown and pointerup,
 * a gesture is a drag (orbiting the camera) rather than a click (picking or
 * selecting) — see the comment on `onPointerDown` below for why this
 * distinction has to exist at all.
 */
const CLICK_DRAG_THRESHOLD_PX = 5;

/**
 * The 3D viewport.
 *
 * Owns the renderer and keeps it in sync with the store. Geometry is fetched
 * here rather than in the loader so the spatial tree and property inspector
 * become usable while meshes are still being tessellated — on a large model
 * that is the difference between a usable UI in a second and a blank one for
 * ten.
 *
 * The canvas is `aria-hidden` and paired with the spatial tree, which is the
 * keyboard-navigable equivalent. A 3D canvas cannot be made accessible on its
 * own; the tree is the alternative, not a convenience.
 */
export function ViewerCanvas() {
  const t = useTranslations("viewer.canvas");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const globeRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<ViewerRenderer | null>(null);
  const viewCubeRef = useRef<ViewCubeRef | null>(null);
  // Where the current gesture started, so `onPointerUp` can tell a click from
  // a drag; see `onPointerDown`.
  const pointerDownPositionRef = useRef<{ x: number; y: number } | null>(null);
  const sectionGizmoDraggingRef = useRef(false);
  // The right button pans the camera as well as opening the menu, so like the
  // primary one it only counts as a click if the pointer stayed put.
  const secondaryDownRef = useRef<{ x: number; y: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<ViewerContextMenuState>(null);
  const [ready, setReady] = useState(false);
  usePointClouds(rendererRef, ready);
  const cloudCount = usePointCloudStore((state) => state.clouds.length);
  const [projection, setProjection] = useState<CameraProjection>("perspective");
  const [originsVisible, setOriginsVisible] = useState(false);
  // What the scene actually holds, which is not always what the store holds.
  const [renderedModels, setRenderedModels] = useState(0);

  const models = useViewerStore((s) => s.models);
  const placements = useViewerStore((s) => s.placements);
  const selection = useViewerStore((s) => s.selection);
  const hidden = useViewerStore((s) => s.hidden);
  const isolated = useViewerStore((s) => s.isolated);
  const entityTypeByRef = useViewerStore((s) => s.entityTypeByRef);
  const typeVisibility = useViewerStore((s) => s.typeVisibility);
  const typeFilter = useViewerStore((s) => s.typeFilter);
  const facetVisible = useViewerStore((s) => s.facetVisible);
  const tool = useViewerStore((s) => s.tool);
  const snapTargets = useViewerStore((s) => s.snapTargets);
  const sectionPlanes = useViewerStore((s) => s.sectionPlanes);
  const sectionCapStyle = useViewerStore((s) => s.sectionCapStyle);
  const measurements = useViewerStore((s) => s.measurements);
  const pendingPoint = useViewerStore((s) => s.pendingPoint);
  const angleMeasurements = useViewerStore((s) => s.angleMeasurements);
  const pendingAnglePoints = useViewerStore((s) => s.pendingAnglePoints);
  const areaMeasurements = useViewerStore((s) => s.areaMeasurements);
  const areaMode = useViewerStore((s) => s.areaMode);
  const pendingAreaPoints = useViewerStore((s) => s.pendingAreaPoints);
  const volumeMeasurements = useViewerStore((s) => s.volumeMeasurements);
  const volumeMode = useViewerStore((s) => s.volumeMode);
  const pendingBoxCorner = useViewerStore((s) => s.pendingBoxCorner);

  // Whether the active tool picks a *point* on the model — every mode except
  // volume's "element" sub-mode and area's "face" sub-mode, which each pick a
  // whole entity instead. Snap preview and the crosshair cursor both key off
  // this.
  const isPointPickingTool =
    tool === "measureDistance" ||
    tool === "measureAngle" ||
    (tool === "measureArea" && areaMode === "points") ||
    (tool === "measureVolume" && volumeMode === "box");

  // ---- renderer lifecycle
  /**
   * Keep the viewport backdrop on the theme.
   *
   * The colour lives in CSS (`--viewport`) so the two themes are defined in one
   * place, and is pushed into the renderer here. `next-themes` switches themes
   * by toggling a class on `<html>`, which fires no event — hence the observer
   * rather than a listener.
   */
  useEffect(() => {
    const apply = () => {
      const renderer = rendererRef.current;
      if (!renderer) return;

      const colour = getComputedStyle(document.documentElement)
        .getPropertyValue("--viewport")
        .trim();
      if (colour) renderer.setBackgroundColor(colour);
    };

    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => observer.disconnect();
  }, [ready]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const renderer = new ViewerRenderer(canvasRef.current);
    if (globeRef.current) setGlobeCanvas(globeRef.current);
    rendererRef.current = renderer;
    setActiveRenderer(renderer);
    setReady(true);
    const stopProjectionListener = renderer.onProjectionChange(setProjection);
    const stopRotationListener = renderer.onCameraRotationChange(
      ({ azimuth, elevation }) =>
        viewCubeRef.current?.updateRotation(-elevation, -azimuth),
    );

    detectWebGpu().then((support) => {
      if (!support.available) {
        // A warning, not a blocker: the WebGL path is the shipped one.
        toast.info(t(`webgpu.${support.reason}`), {
          id: "webgpu",
          duration: 8000,
        });
      }
    });

    return () => {
      stopProjectionListener();
      stopRotationListener();
      renderer.dispose();
      rendererRef.current = null;
      setActiveRenderer(null);
      setReady(false);
    };
    // Deliberately mount-once: this creates and tears down the renderer
    // itself, which must not happen again just because `t`'s reference
    // changed (e.g. on a locale switch) — that would drop and rebuild the
    // whole WebGL context to fix a toast that only fires once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- fetch geometry for models that do not have it yet
  //
  // Deliberately NOT cancelled when `models` changes. Claiming a model marks it
  // in the store, which changes `models`, which re-runs this effect — so a
  // cleanup that cancelled in-flight work would abort the very fetch it just
  // started, and the geometry would arrive and be thrown away with no error.
  // Only unmounting cancels; `requested` is what prevents duplicate work.
  const mounted = useRef(true);
  const requested = useRef(new Set<string>());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const renderer = rendererRef.current;
    if (!renderer) return;

    /*
      Drop geometry the store no longer has.

      `unloadModel` closes the worker and updates the store; it deliberately
      knows nothing about the renderer, so without this the model disappeared
      from the list and stayed in the scene. Reconciling here keeps the loader
      free of rendering concerns and makes the scene a function of the store,
      which is the only version of this that cannot drift.
    */
    const live = new Set(models.map((model) => model.summary.id));
    for (const modelId of [...requested.current]) {
      if (live.has(modelId)) continue;
      renderer.removeModel(modelId);
      requested.current.delete(modelId);
    }
    setRenderedModels(renderer.modelCount);

    for (const model of models) {
      const modelId = model.summary.id;
      if (requested.current.has(modelId)) continue;
      if (model.load.status === "failed" || model.load.status === "parsing")
        continue;

      requested.current.add(modelId);
      const handle = getModelHandle(modelId);
      if (!handle) {
        requested.current.delete(modelId);
        continue;
      }

      handle
        .getGeometry()
        .then((geometry) => {
          if (!mounted.current) return;
          renderer.setModelGeometry(modelId, geometry.meshes, {
            originShift: geometry.coordinates.originShift,
          });
          useViewerStore.getState().registerEntityTypes(
            modelId,
            geometry.meshes.map(({ expressId, type }) => ({ expressId, type })),
          );
          useViewerStore.getState().updateModel(modelId, {
            coordinates: geometry.coordinates,
            hasGeometry: true,
            load: { status: "ready" },
          });
          setRenderedModels(renderer.modelCount);
          renderer.fitToBounds(useViewerStore.getState().federationBounds());
        })
        .catch((error: unknown) => {
          requested.current.delete(modelId);
          if (!mounted.current) return;
          const message =
            error instanceof Error ? error.message : String(error);
          useViewerStore.getState().updateModel(modelId, {
            hasGeometry: false,
            load: { status: "failed", error: message },
          });
          toast.error(`${model.summary.name}: ${message}`);
        });
    }
  }, [models, ready]);

  // ---- placements
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    for (const model of models) {
      const placement = placements[model.summary.id];
      if (placement) {
        renderer.setPlacement(
          model.summary.id,
          placement.offset,
          placement.rotationY,
          placement.scale,
        );
      }
      renderer.setModelVisible(model.summary.id, model.visible);
    }
  }, [models, placements]);

  // ---- selection
  useEffect(() => {
    rendererRef.current?.setSelection(selection);
  }, [selection]);

  // ---- colouring (clash detection, BCF viewpoints)
  const colouring = useViewerStore((s) => s.colouring);
  useEffect(() => {
    rendererRef.current?.setHighlights(
      [...colouring].map(([key, colour]) => {
        const at = key.lastIndexOf("#");
        return { modelId: key.slice(0, at), expressId: Number(key.slice(at + 1)), colour };
      }),
    );
  }, [colouring, models]);

  // ---- visibility, isolation and the filters
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    for (const model of models) {
      renderer.setEntityVisibility(model.summary.id, (expressId) =>
        /*
          The store's own rule, not a copy of it.

          This used to re-implement "isolated wins, otherwise not hidden"
          inline. The copy then drifted: the filter panel's `facetVisible` was
          added to `isVisible` and this never learned about it, so ticking a
          filter changed the store and left the viewport untouched. One rule,
          in one place, is the only way that stays true.
        */
        useViewerStore.getState().isVisible({
          modelId: model.summary.id,
          expressId,
        }),
      );
    }
    // Every input to `isVisible` has to be a dependency, or the effect will not
    // re-run when the answer changes.
  }, [
    models,
    hidden,
    isolated,
    entityTypeByRef,
    typeVisibility,
    typeFilter,
    facetVisible,
  ]);

  // ---- section planes
  useEffect(() => {
    rendererRef.current?.setSectionPlanes(
      sectionPlanes,
      useViewerStore.getState().federationBounds(),
    );
  }, [sectionPlanes, models, placements]);

  useEffect(() => {
    rendererRef.current?.setSectionCapStyle(sectionCapStyle);
  }, [sectionCapStyle]);

  // ---- measurement overlays
  useEffect(() => {
    rendererRef.current?.setMeasurements(measurements, pendingPoint);
  }, [measurements, pendingPoint]);

  useEffect(() => {
    rendererRef.current?.setAngleMeasurements(
      angleMeasurements,
      pendingAnglePoints,
    );
  }, [angleMeasurements, pendingAnglePoints]);

  useEffect(() => {
    rendererRef.current?.setAreaMeasurements(
      areaMeasurements,
      pendingAreaPoints,
    );
  }, [areaMeasurements, pendingAreaPoints]);

  useEffect(() => {
    rendererRef.current?.setVolumeMeasurements(
      volumeMeasurements,
      pendingBoxCorner,
    );
  }, [volumeMeasurements, pendingBoxCorner]);

  // Leaving a point-picking tool, or turning off every snap target, drops the
  // preview outright rather than waiting for the next pointer move to notice
  // — otherwise it sits there, snapped to the last thing it was near,
  // describing a click that snapping no longer applies to.
  useEffect(() => {
    if (!isPointPickingTool || !hasAnySnapTarget(snapTargets)) {
      rendererRef.current?.setSnapPreview(null, null);
    }
  }, [isPointPickingTool, snapTargets]);

  // ---- Esc cancels a half-finished measurement; Enter finishes an area
  useEffect(() => {
    if (tool === "select") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const store = useViewerStore.getState();

      if (event.key === "Enter" && store.tool === "measureArea") {
        store.finishAreaMeasurement();
        return;
      }
      if (event.key !== "Escape") return;

      switch (store.tool) {
        case "measureDistance":
          if (store.pendingPoint) store.cancelMeasurement();
          else store.setTool("select");
          return;
        case "measureAngle":
          if (store.pendingAnglePoints.length > 0)
            store.cancelAngleMeasurement();
          else store.setTool("select");
          return;
        case "measureArea":
          if (store.pendingAreaPoints.length > 0) store.cancelAreaMeasurement();
          else store.setTool("select");
          return;
        case "measureVolume":
          if (store.pendingBoxCorner) store.cancelVolumeMeasurement();
          else store.setTool("select");
          return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tool]);

  /**
   * Remember where a gesture started; act on it in `onPointerUp` instead of
   * here.
   *
   * OrbitControls listens for this exact same pointerdown, on this exact
   * same canvas, to start orbiting the camera — dragging to rotate and
   * clicking to pick or select both begin with one. Acting immediately, on
   * pointerdown, could not tell them apart: every drag to orbit also dropped
   * a measurement point (or changed the selection) at wherever the drag
   * happened to start, before the user had moved the mouse at all. Waiting
   * for `onPointerUp` and checking how far the pointer travelled is what
   * lets a click still act while a drag does not.
   */
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const renderer = rendererRef.current;
    if (event.button === 2) {
      secondaryDownRef.current = { x: event.clientX, y: event.clientY };
      pointerDownPositionRef.current = null;
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    if (
      renderer?.beginSectionGizmoDrag(
        event.clientX - rect.left,
        event.clientY - rect.top,
      )
    ) {
      sectionGizmoDraggingRef.current = true;
      pointerDownPositionRef.current = null;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    pointerDownPositionRef.current = { x: event.clientX, y: event.clientY };
  };

  /**
   * Right-click on an element, in the select tool: make it the selection (unless
   * it already is part of one) and open the menu beside the pointer. Empty space,
   * a drag, and the measuring tools — which spend clicks on points — do nothing.
   */
  const openContextMenu = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const renderer = rendererRef.current;
    const down = secondaryDownRef.current;
    secondaryDownRef.current = null;
    if (!renderer || !down) return;
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > CLICK_DRAG_THRESHOLD_PX) return;

    const store = useViewerStore.getState();
    if (store.tool !== "select") return;

    const rect = event.currentTarget.getBoundingClientRect();
    const hit = renderer.pick(event.clientX - rect.left, event.clientY - rect.top);
    if (!hit) {
      setContextMenu(null);
      return;
    }

    const target = { modelId: hit.modelId, expressId: hit.expressId };
    if (!store.isSelected(target)) store.select([target], "replace");
    setContextMenu({ x: event.clientX, y: event.clientY, target });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const renderer = rendererRef.current;
    if (sectionGizmoDraggingRef.current) {
      sectionGizmoDraggingRef.current = false;
      renderer?.endSectionGizmoDrag();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      return;
    }
    if (event.button === 2) {
      openContextMenu(event);
      return;
    }
    const down = pointerDownPositionRef.current;
    pointerDownPositionRef.current = null;
    if (!renderer || !down) return;

    const dragDistance = Math.hypot(
      event.clientX - down.x,
      event.clientY - down.y,
    );
    if (dragDistance > CLICK_DRAG_THRESHOLD_PX) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const store = useViewerStore.getState();

    switch (store.tool) {
      case "measureDistance": {
        const point = renderer.pickPoint(x, y, store.snapTargets);
        // Clicking empty space does nothing: silently dropping a point onto
        // the far clip plane would produce a confidently wrong number.
        if (point) store.addMeasurementPoint(point.point);
        return;
      }
      case "measureAngle": {
        const point = renderer.pickPoint(x, y, store.snapTargets);
        if (point) store.addAnglePoint(point.point);
        return;
      }
      case "measureArea": {
        if (store.areaMode === "face") {
          // A whole-entity pick, not a point pick — same exclusions as
          // volume's "element" mode (never reaches the context mesh, which
          // has no expressId to report).
          const result = renderer.pickFace(x, y);
          if (!result) return;
          store.addFaceArea(result.modelId, result.expressId, result.triangles);
          // Reuses the ordinary selection highlight the same way volume's
          // "element" mode does, so the measured element is visibly obvious
          // alongside the face's own green fill.
          store.select(
            [{ modelId: result.modelId, expressId: result.expressId }],
            "replace",
          );
        } else {
          const point = renderer.pickPoint(x, y, store.snapTargets);
          if (point) store.addAreaPoint(point.point);
        }
        return;
      }
      case "measureVolume": {
        if (store.volumeMode === "element") {
          // A whole-entity pick, not a point pick — the context mesh (no
          // expressId; see `pick()`) and empty space both come back null.
          const hit = renderer.pick(x, y);
          if (!hit) return;
          const result = renderer.getElementVolume(hit.modelId, hit.expressId);
          if (!result) return;
          store.addElementVolume(
            hit.modelId,
            hit.expressId,
            result.volume,
            result.centroid,
          );
          // Reuses the ordinary selection highlight as the "this is what got
          // measured" feedback, rather than building a second, redundant one.
          store.select([hit], "replace");
        } else {
          const point = renderer.pickPoint(x, y, store.snapTargets);
          if (point) store.addBoxVolumePoint(point.point);
        }
        return;
      }
    }

    const hit = renderer.pick(x, y);
    if (!hit) {
      if (!event.shiftKey) store.clearSelection();
      return;
    }
    store.select([hit], event.shiftKey ? "toggle" : "replace");
  };

  /**
   * Preview where the next measurement click would land, before it happens.
   *
   * Only worth asking the renderer when a click could actually snap: outside
   * a point-picking tool, or with every snap target off, there is nothing a
   * hover could show that the cursor is not already showing. `pickPoint`'s
   * own `snapType` — not merely a hit — decides whether to show anything, and
   * which shape: hovering the middle of a large face is a real hit with
   * nothing to snap to, and a marker sitting under the cursor there would say
   * "this is where you'll land" about a point snapping never touches.
   */
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    if (sectionGizmoDraggingRef.current) {
      const rect = event.currentTarget.getBoundingClientRect();
      const update = renderer.updateSectionGizmoDrag(
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
      if (update) {
        useViewerStore
          .getState()
          .updateSectionPlane(update.id, update.patch);
      }
      return;
    }

    const store = useViewerStore.getState();
    const pointPicking =
      store.tool === "measureDistance" ||
      store.tool === "measureAngle" ||
      (store.tool === "measureArea" && store.areaMode === "points") ||
      (store.tool === "measureVolume" && store.volumeMode === "box");
    if (!pointPicking || !hasAnySnapTarget(store.snapTargets)) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const result = renderer.pickPoint(x, y, store.snapTargets);
    renderer.setSnapPreview(
      result?.snapType ? result.point : null,
      result?.snapType ?? null,
    );
  };

  const onPointerLeave = () => {
    rendererRef.current?.setSnapPreview(null, null);
  };

  const onPointerCancel = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!sectionGizmoDraggingRef.current) return;
    sectionGizmoDraggingRef.current = false;
    rendererRef.current?.endSectionGizmoDrag();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  // Every loaded model has its geometry in the renderer. Exposed on the DOM so
  // tests can wait on the real thing rather than on a timeout, and so the
  // "Fit" button can be disabled until there is something to fit to.
  const geometryReady =
    models.length > 0 && models.every((m) => m.load.status === "ready");

  return (
    <div
      // `isolate` keeps the globe's negative z-index inside this stacking
      // context rather than letting it slide behind the page background.
      className="bg-muted/40 relative isolate h-full w-full"
      data-geometry-ready={geometryReady ? "true" : "false"}
      data-rendered-models={renderedModels}
    >
      {/*
        The globe, behind the model.

        Its own canvas and its own WebGL context: Cesium and three.js each own
        theirs and neither will share. They are kept in register by syncing the
        cameras every frame, and the model canvas is transparent so this shows
        through. `pointer-events-none` because the model viewer owns navigation
        — Cesium's own controls are disabled for the same reason.
      */}
      <div
        ref={globeRef}
        aria-hidden
        data-globe-canvas
        // A container, not a canvas: `CesiumWidget` creates and sizes its own
        // canvas inside whatever element it is given, and keeps it sized on
        // resize — which a hand-managed canvas did not.
        //
        // Behind the model. An absolutely-positioned element paints above a
        // static sibling, so without the negative z-index the globe covers the
        // very geometry it is meant to sit under.
        className="pointer-events-none absolute inset-0 -z-10 h-full w-full"
      />

      <canvas
        ref={canvasRef}
        data-model-canvas
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onPointerCancel={onPointerCancel}
        // The camera's own right-button pan is what the menu must not get in the
        // way of, and the browser's menu has nothing to offer a 3D view.
        onContextMenu={(event) => event.preventDefault()}
        className={cn(
          "h-full w-full touch-none",
          tool !== "select" && "cursor-crosshair",
        )}
        // The spatial tree is the keyboard-navigable equivalent of this canvas.
        aria-hidden="true"
      />

      <MeasurementLabels />

      <ViewerContextMenu state={contextMenu} onClose={() => setContextMenu(null)} />

      {models.length === 0 && cloudCount === 0 && (
        <div className="text-muted-foreground pointer-events-none absolute inset-0 flex items-center justify-center text-sm">
          {t("dropHint")}
        </div>
      )}

      <ViewCube
        ref={viewCubeRef}
        projection={projection}
        onProjectionChange={(nextProjection) =>
          rendererRef.current?.setProjection(nextProjection)
        }
        onViewChange={(view) => rendererRef.current?.setStandardView(view)}
        onDrag={(deltaX, deltaY) => rendererRef.current?.orbit(deltaX, deltaY)}
      />

      {/*
        Bottom-centre of this element, which since the side panels became
        docked (`page.tsx`) is exactly the visible canvas area — no longer a
        "clear channel" chosen to dodge a floating panel, just the natural
        centre of the space this canvas actually has.
      */}
      <div className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={originsVisible ? "secondary" : "ghost"}
              size="sm"
              disabled={models.length === 0}
              aria-pressed={originsVisible}
              aria-label={originsVisible ? t("hideOrigins") : t("showOrigins")}
              onClick={() => {
                const visible = !originsVisible;
                setOriginsVisible(visible);
                const renderer = rendererRef.current;
                renderer?.setOriginsVisible(visible);
                if (visible) {
                  renderer?.fitToBoundsAndOrigins(
                    useViewerStore.getState().federationBounds(),
                  );
                }
              }}
            >
              <Axis3D className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {originsVisible ? t("hideOrigins") : t("showOrigins")}
          </TooltipContent>
        </Tooltip>
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            rendererRef.current?.fitToBounds(
              useViewerStore.getState().federationBounds() ??
                rendererRef.current.getPointCloudBounds(),
            )
          }
        >
          <Maximize2 className="h-4 w-4" />
          {t("fitView")}
        </Button>
      </div>
    </div>
  );
}

export default ViewerCanvas;
