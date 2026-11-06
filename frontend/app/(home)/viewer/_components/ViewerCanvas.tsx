"use client";

import { useContextModelStore } from "@/lib/viewer/context-model-store";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { ViewerRenderer, detectWebGpu } from "@/lib/viewer/renderer";
import { setActiveRenderer } from "@/lib/viewer/active-renderer";
import { usePointClouds } from "./usePointClouds";
import { usePointCloudStore } from "@/lib/viewer/pointcloud-store";
import { getModelHandle } from "@/lib/viewer/loader";
import { isolationGhostKeys, useViewerStore } from "@/lib/viewer/store";
import { hasAnySnapTarget } from "@/lib/viewer/tools";
import MeasurementLabels from "./MeasurementLabels";
import BcfMarkers from "./BcfMarkers";
import GlobeGoogleLogo from "./GlobeGoogleLogo";
import RealisticMaterials from "./RealisticMaterials";
import OrbitPivotMarker from "./OrbitPivotMarker";
import { Button } from "@/components/ui/button";
import { Axis3D, Contrast, Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { setGlobeCanvas } from "@/lib/viewer/globe-canvas";
import { useGlobeStore } from "@/lib/viewer/globe-store";
import {
  applyDisplaySettings,
  displaySettingsValues,
  useDisplaySettingsStore,
} from "@/lib/viewer/display-settings";
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
  const contextSelection = useContextModelStore((s) => s.selectedFeature);
  const contextAppearance = useContextModelStore((s) => s.appearance);
  const contextAttribution = useContextModelStore((s) => s.visible ? s.loaded?.attribution : undefined);
  const contextAttributionUrl = useContextModelStore((s) => s.loaded?.attributionUrl);
  const t = useTranslations("viewer.canvas");
  const edgeShading = usePointCloudStore((s) => s.edgeShading);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const globeRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<ViewerRenderer | null>(null);
  const viewCubeRef = useRef<ViewCubeRef | null>(null);
  // Where the current gesture started, so `onPointerUp` can tell a click from
  // a drag; see `onPointerDown`.
  const activeTouchesRef = useRef(new Set<number>());
  const multiTouchRef = useRef(false);
  const pointerDownPositionRef = useRef<{ x: number; y: number } | null>(null);
  const orbitStartRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const sectionGizmoDraggingRef = useRef(false);
  // The right button pans the camera as well as opening the menu, so like the
  // primary one it only counts as a click if the pointer stayed put.
  const secondaryDownRef = useRef<{ x: number; y: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<ViewerContextMenuState>(null);
  const [orbiting, setOrbiting] = useState(false);
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
  const isolationGhosts = useViewerStore((s) => s.isolationGhosts);
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
    // A new renderer starts at its defaults; the controls show the store.
    applyDisplaySettings(renderer, displaySettingsValues(useDisplaySettingsStore.getState()));
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
      // The globe outlives the Geo panel but not the viewer it is drawn in.
      useGlobeStore.getState().off();
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

  // ---- the globe needs a model to stand on; with none left it goes too
  const modelCount = models.length;
  useEffect(() => {
    if (modelCount === 0 && useGlobeStore.getState().on) useGlobeStore.getState().off();
  }, [modelCount]);

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

  useEffect(() => {
    rendererRef.current?.setContextSelection(contextSelection);
  }, [contextSelection]);

  useEffect(() => {
    rendererRef.current?.setContextAppearance(contextAppearance);
  }, [contextAppearance]);

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

  // ---- the active lens's colours (lib/lens/, applied by LensSync)
  const lensView = useViewerStore((s) => s.lensView);
  useEffect(() => {
    rendererRef.current?.setLensColours(lensView?.colours ?? null);
  }, [lensView, models]);

  // ---- visibility, isolation and the filters
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    const translucent = lensView?.translucent;
    const ghosts = isolationGhostKeys(useViewerStore.getState());
    for (const model of models) {
      const modelId = model.summary.id;
      renderer.setEntityVisibility(modelId, (expressId) =>
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
        // A lens's ghosts are shown, see-through; an isolation shows its
        // elements solid, whatever the lens says — except those the isolation
        // itself asked to show see-through, around the one in focus.
        (translucent && translucent.size > 0) || ghosts
          ? (expressId) => {
              const key = `${modelId}#${expressId}`;
              if (ghosts?.has(key)) return true;
              const isolated = useViewerStore.getState().isolated;
              return !!translucent?.has(key) && !isolated?.has(key);
            }
          : undefined,
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
    lensView,
    isolationGhosts,
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
  const endOrbitGesture = () => {
    orbitStartRef.current = null;
    setOrbiting(false);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    endOrbitGesture();
    const renderer = rendererRef.current;
    if (event.pointerType === "touch") {
      if (activeTouchesRef.current.size === 0) multiTouchRef.current = false;
      activeTouchesRef.current.add(event.pointerId);
      if (activeTouchesRef.current.size > 1) multiTouchRef.current = true;
      if (multiTouchRef.current) {
        pointerDownPositionRef.current = null;
        renderer?.setSnapPreview(null, null);
        if (sectionGizmoDraggingRef.current) {
          sectionGizmoDraggingRef.current = false;
          renderer?.endSectionGizmoDrag();
        }
        return;
      }
    }
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
    // The unmodified primary button (or first touch) rotates. Pan/zoom and
    // section handles must not replace the rotation point.
    if (event.button === 0 && event.isPrimary && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      renderer?.setOrbitPivotAt(event.clientX - rect.left, event.clientY - rect.top);
      orbitStartRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    }
    pointerDownPositionRef.current = { x: event.clientX, y: event.clientY };
  };

  /**
   * Right-click on an element, in the select tool: make it the selection (unless
   * it already is part of one) and open the menu beside the pointer. Outside an
   * IFC element, offer only Show all. Right-button drags still pan the camera.
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
    const hit = renderer.pickInspectable(event.clientX - rect.left, event.clientY - rect.top);
    if (!hit) {
      setContextMenu({ x: event.clientX, y: event.clientY, target: null });
      return;
    }

    if (hit.kind === "context") {
      store.clearSelection();
      useContextModelStore.getState().selectFeature(hit.featureIndex);
      setContextMenu({ x: event.clientX, y: event.clientY, target: null });
      return;
    }
    const target = { modelId: hit.modelId, expressId: hit.expressId };
    if (!store.isSelected(target)) store.select([target], "replace");
    setContextMenu({ x: event.clientX, y: event.clientY, target });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    endOrbitGesture();
    if (event.pointerType === "touch") {
      activeTouchesRef.current.delete(event.pointerId);
      if (multiTouchRef.current) {
        pointerDownPositionRef.current = null;
        return;
      }
    }
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

    const hit = renderer.pickInspectable(x, y);
    if (!hit) {
      if (!event.shiftKey) store.clearSelection();
      return;
    }
    if (hit.kind === "context") {
      const context = useContextModelStore.getState();
      const index = event.shiftKey && context.selectedFeature === hit.featureIndex ? null : hit.featureIndex;
      store.clearSelection();
      context.selectFeature(index);
      return;
    }
    store.select([{ modelId: hit.modelId, expressId: hit.expressId }], event.shiftKey ? "toggle" : "replace");
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
    if (event.pointerType === "touch" && multiTouchRef.current) return;
    const renderer = rendererRef.current;
    if (!renderer) return;

    // Choose the pivot on press, but show it only for an actual rotation drag.
    const orbitStart = orbitStartRef.current;
    if (
      orbitStart?.pointerId === event.pointerId &&
      Math.hypot(event.clientX - orbitStart.x, event.clientY - orbitStart.y) > CLICK_DRAG_THRESHOLD_PX
    ) {
      setOrbiting(true);
    }

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
    endOrbitGesture();
    pointerDownPositionRef.current = null;
    secondaryDownRef.current = null;
    activeTouchesRef.current.delete(event.pointerId);
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
        onLostPointerCapture={endOrbitGesture}
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
      <OrbitPivotMarker ready={ready} active={orbiting} />
      <BcfMarkers ready={ready} />
      <GlobeGoogleLogo />
      {/* Credits, bottom-right: the context model's, and Poly Haven's while
          realistic materials are on (their API terms ask for one). */}
      <div className="pointer-events-none absolute bottom-0 right-1 z-10 flex max-w-[65%] flex-col items-end gap-0.5 text-[10px]">
        {contextAttribution && <div data-context-attribution className="bg-background/80 text-muted-foreground pointer-events-auto rounded px-1 text-right">
          {contextAttributionUrl ? <a href={contextAttributionUrl} target="_blank" rel="noopener noreferrer" className="underline">{contextAttribution}</a> : contextAttribution}
        </div>}
        <RealisticMaterials ready={ready} />
      </div>

      <ViewerContextMenu state={contextMenu} onClose={() => setContextMenu(null)} />

      {models.length === 0 && cloudCount === 0 && (
        <div className="text-muted-foreground pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center text-sm">
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

      {/* Controls follow the canvas when panels dock or float. */}
      <div className="viewer-canvas-actions absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 gap-2">
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
        {cloudCount > 0 && (
          // The same setting as the switch in the point-cloud list, where the
          // eye already is when looking at a scan.
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={edgeShading ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={edgeShading}
                aria-label={t(edgeShading ? "edgeShadingOff" : "edgeShadingOn")}
                data-edge-shading-toggle
                onClick={() => usePointCloudStore.getState().setEdgeShading(!edgeShading)}
              >
                <Contrast className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t(edgeShading ? "edgeShadingOff" : "edgeShadingOn")}</TooltipContent>
          </Tooltip>
        )}
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
