"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { useTranslations } from "next-intl";
import { Box, Square } from "lucide-react";

import type {
  CameraProjection,
  StandardView,
} from "@/lib/viewer/camera";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type FaceView = Exclude<StandardView, "isometric">;

const FACES: Array<{
  id: FaceView;
  transform: (half: number) => string;
}> = [
  { id: "front", transform: (half) => `translateZ(${half}px)` },
  {
    id: "back",
    transform: (half) => `translateZ(${-half}px) rotateY(180deg)`,
  },
  {
    id: "top",
    transform: (half) => `translateY(${-half}px) rotateX(90deg)`,
  },
  {
    id: "bottom",
    transform: (half) => `translateY(${half}px) rotateX(-90deg)`,
  },
  {
    id: "right",
    transform: (half) => `translateX(${half}px) rotateY(90deg)`,
  },
  {
    id: "left",
    transform: (half) => `translateX(${-half}px) rotateY(-90deg)`,
  },
];

export type ViewCubeRef = {
  updateRotation: (rotationX: number, rotationY: number) => void;
};

type ViewCubeProps = {
  projection: CameraProjection;
  onProjectionChange: (projection: CameraProjection) => void;
  onViewChange: (view: FaceView) => void;
  onDrag: (deltaX: number, deltaY: number) => void;
};

/**
 * IFC Lite style view cube: six real CSS 3D faces, live camera rotation, face
 * snapping, and cube dragging as an alternate orbit gesture.
 */
export const ViewCube = forwardRef<ViewCubeRef, ViewCubeProps>(
  function ViewCube(
    { projection, onProjectionChange, onViewChange, onDrag },
    ref,
  ) {
    const t = useTranslations("viewer.canvas.viewCube");
    const rotationRef = useRef<HTMLDivElement>(null);
    const frameRef = useRef<number | null>(null);
    const pendingRef = useRef<{ x: number; y: number } | null>(null);
    const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
    const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
    const pressedFaceRef = useRef<FaceView | null>(null);
    const draggedRef = useRef(false);
    const [dragging, setDragging] = useState(false);
    const [hovered, setHovered] = useState<FaceView | null>(null);
    const size = 60;
    const half = size / 2;

    useImperativeHandle(ref, () => ({
      updateRotation: (x, y) => {
        pendingRef.current = { x, y };
        // Camera controls can emit a change on every animation frame while
        // orbiting or damping. Keep the already scheduled frame and only
        // replace its pending angles; cancelling and rescheduling here would
        // starve the cube until camera movement stopped.
        if (frameRef.current !== null) return;
        frameRef.current = requestAnimationFrame(() => {
          if (rotationRef.current && pendingRef.current) {
            rotationRef.current.style.transform =
              `rotateX(${pendingRef.current.x}deg) ` +
              `rotateY(${pendingRef.current.y}deg)`;
          }
          pendingRef.current = null;
          frameRef.current = null;
        });
      },
    }));

    useEffect(
      () => () => {
        if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      },
      [],
    );

    const beginDrag = (event: PointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      pointerStartRef.current = { x: event.clientX, y: event.clientY };
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
      const face = (event.target as Element)
        .closest<HTMLButtonElement>("[data-view-face]")
        ?.dataset.viewFace;
      pressedFaceRef.current = (face as FaceView | undefined) ?? null;
      draggedRef.current = false;
      setDragging(true);
    };

    const continueDrag = (event: PointerEvent<HTMLDivElement>) => {
      const previous = lastPointerRef.current;
      const start = pointerStartRef.current;
      if (!previous || !start || !dragging) return;
      const deltaX = event.clientX - previous.x;
      const deltaY = event.clientY - previous.y;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 5) {
        draggedRef.current = true;
      }
      if (draggedRef.current) onDrag(deltaX * 2, deltaY * 2);
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
    };

    const finishDrag = (
      event: PointerEvent<HTMLDivElement>,
      activateFace: boolean,
    ) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (activateFace && !draggedRef.current && pressedFaceRef.current) {
        onViewChange(pressedFaceRef.current);
      }
      pointerStartRef.current = null;
      lastPointerRef.current = null;
      pressedFaceRef.current = null;
      draggedRef.current = false;
      setDragging(false);
    };

    return (
      <div
        className="absolute top-4 right-2 z-20 flex flex-col items-end gap-2"
        aria-label={t("label")}
        data-view-cube
        data-projection={projection}
      >
        

        <div
          className={cn(
            "relative touch-none select-none mt-1 mr-4",
            dragging ? "cursor-grabbing" : "cursor-grab",
          )}
          style={{ width: size, height: size, perspective: 200 }}
          onPointerDown={beginDrag}
          onPointerMove={continueDrag}
          onPointerUp={(event) => finishDrag(event, true)}
          onPointerCancel={(event) => finishDrag(event, false)}
        >
          <div
            ref={rotationRef}
            className="relative h-full w-full"
            style={{
              transformStyle: "preserve-3d",
              transform: "rotateX(-25deg) rotateY(-45deg)",
            }}
          >
            {FACES.map(({ id, transform }) => (
              <button
                key={id}
                type="button"
                data-view-face={id}
                aria-label={t(`views.${id}`)}
                title={t(`views.${id}`)}
                className={cn(
                  "bg-card/95 border-border/60 absolute flex h-full w-full cursor-pointer items-center justify-center border text-[9px] font-bold transition-colors [backface-visibility:hidden]",
                  hovered === id
                    ? "border-primary bg-primary/25 text-primary"
                    : "hover:bg-accent",
                )}
                style={{ transform: transform(half) }}
                onPointerEnter={() => setHovered(id)}
                onPointerLeave={() => setHovered(null)}
                // Pointer activation is handled by the cube container because
                // pointer capture retargets pointerup to that container. A
                // zero-detail click is keyboard activation and still belongs
                // to the focused face button.
                onClick={(event) => {
                  if (event.detail === 0) onViewChange(id);
                }}
              >
                {t(`short.${id}`)}
              </button>
            ))}
          </div>
        </div>
        <div
          className="flex flex-col mt-4"
          role="group"
          aria-label={t("projection")}
        >
          {(["perspective", "orthographic"] as const).map((mode) => {
            const Icon = mode === "perspective" ? Box : Square;
            return (
              <Button
                key={mode}
                type="button"
                aria-pressed={projection === mode}
                aria-label={t(mode)}
                title={t(mode)}
                onClick={() => onProjectionChange(mode)}
                size="icon-xs"
                variant={projection === mode ? "secondary" : "ghost"}
              >
                <Icon size="xs" aria-hidden />
              </Button>
            );
          })}
        </div>
      </div>
    );
  },
);

ViewCube.displayName = "ViewCube";

export default ViewCube;
