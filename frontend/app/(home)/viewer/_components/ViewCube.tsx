"use client";

import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { useTranslations } from "next-intl";
import { Box, Square } from "lucide-react";

import type { Vec3 } from "@/lib/ifc/types";
import type {
  CameraProjection,
  StandardView,
} from "@/lib/viewer/camera";
import {
  CUBE_FACES,
  faceOfDirection,
  facesOfDirection,
  isZoneLit,
  zonesForFace,
  type CubeFace,
  type CubeZone,
} from "@/lib/viewer/view-cube-zones";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type FaceView = Exclude<StandardView, "isometric">;

/** Edge length of the cube, in CSS px (ifclite.com's). */
const SIZE = 72;
/** Width of the edge and corner cells round each face, in CSS px. */
const BAND = 16;

const FACES: Array<{
  id: CubeFace;
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

const ZONES = Object.fromEntries(
  CUBE_FACES.map((face) => [face, zonesForFace(face)]),
) as Record<CubeFace, CubeZone[]>;
const DIRECTIONS = new Map(
  CUBE_FACES.flatMap((face) => ZONES[face]).map((zone) => [zone.key, zone.direction]),
);

/**
 * Hairlines between a face's cells: unseen until the pointer is over the cube,
 * then faint, so a cube at rest is as plain as a cube of six faces.
 */
const SEPARATORS =
  "group-hover/cube:border-l-foreground/[0.06] group-hover/cube:border-r-foreground/[0.06] group-hover/cube:border-t-foreground/[0.06] group-hover/cube:border-b-foreground/[0.06]";

export type ViewCubeRef = {
  updateRotation: (rotationX: number, rotationY: number) => void;
};

type ViewCubeProps = {
  projection: CameraProjection;
  onProjectionChange: (projection: CameraProjection) => void;
  onViewChange: (view: FaceView) => void;
  /** An edge or a corner: where the camera stands relative to its target. */
  onDirectionChange: (direction: Vec3) => void;
  onDrag: (deltaX: number, deltaY: number) => void;
};

/**
 * IFC Lite style view cube: six real CSS 3D faces, each a 3 × 3 grid whose
 * middle is the face and whose sides and corners are the cube's edges and
 * corners (26 views, `view-cube-zones.ts`), live camera rotation, and cube
 * dragging as an alternate orbit gesture.
 */
export const ViewCube = forwardRef<ViewCubeRef, ViewCubeProps>(
  function ViewCube(
    { projection, onProjectionChange, onViewChange, onDirectionChange, onDrag },
    ref,
  ) {
    const t = useTranslations("viewer.canvas.viewCube");
    const rotationRef = useRef<HTMLDivElement>(null);
    const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
    const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
    const pressedZoneRef = useRef<string | null>(null);
    const draggedRef = useRef(false);
    const [dragging, setDragging] = useState(false);
    const [hovered, setHovered] = useState<string | null>(null);
    const half = SIZE / 2;

    useImperativeHandle(ref, () => ({
      // Written at once, not on the next animation frame: the renderer calls
      // this once per camera change, a style write is cheap, and deferring it
      // made the cube trail the model by a frame. It also leaves no scheduled
      // frame to lose: a frame cancelled by an effect's cleanup and still
      // remembered as scheduled once froze the cube in development.
      updateRotation: (x, y) => {
        if (rotationRef.current) {
          rotationRef.current.style.transform = `rotateX(${x}deg) rotateY(${y}deg)`;
        }
      },
    }));

    const activate = (key: string) => {
      const direction = DIRECTIONS.get(key);
      if (!direction) return;
      const face = faceOfDirection(direction);
      if (face) onViewChange(face);
      else onDirectionChange(direction);
    };

    const beginDrag = (event: PointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      pointerStartRef.current = { x: event.clientX, y: event.clientY };
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
      pressedZoneRef.current =
        (event.target as Element).closest<HTMLButtonElement>("[data-view-zone]")
          ?.dataset.viewZone ?? null;
      draggedRef.current = false;
      setDragging(true);
    };

    const continueDrag = (event: PointerEvent<HTMLDivElement>) => {
      const previous = lastPointerRef.current;
      const start = pointerStartRef.current;
      if (!previous || !start || !dragging) return;
      const deltaX = event.clientX - previous.x;
      const deltaY = event.clientY - previous.y;
      if (!draggedRef.current && Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 5) {
        draggedRef.current = true;
        // Under pointer capture the cells see no leave event: drop the hover.
        setHovered(null);
      }
      if (draggedRef.current) onDrag(deltaX * 2, deltaY * 2);
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
    };

    const finishDrag = (
      event: PointerEvent<HTMLDivElement>,
      activateZone: boolean,
    ) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (activateZone && !draggedRef.current && pressedZoneRef.current) {
        activate(pressedZoneRef.current);
      }
      pointerStartRef.current = null;
      lastPointerRef.current = null;
      pressedZoneRef.current = null;
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
            "group/cube relative touch-none select-none mt-1 mr-6 drop-shadow-md",
            dragging ? "cursor-grabbing" : "cursor-grab",
          )}
          style={{ width: SIZE, height: SIZE, perspective: 200 }}
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
              <div
                key={id}
                data-cube-face={id}
                className="border-foreground/30 absolute grid h-full w-full border backface-hidden"
                style={{
                  transform: transform(half),
                  gridTemplate: `${BAND}px 1fr ${BAND}px / ${BAND}px 1fr ${BAND}px`,
                }}
              >
                {ZONES[id].map((zone) => {
                  const isFace = zone.kind === "face";
                  const label = isFace
                    ? t(`views.${id}`)
                    : t("zone", {
                        faces: facesOfDirection(zone.direction)
                          .map((face) => t(`faces.${face}`))
                          .join(" / "),
                      });
                  return (
                    <button
                      key={zone.key}
                      type="button"
                      data-view-zone={zone.key}
                      data-view-zone-kind={zone.kind}
                      data-view-face={isFace ? id : undefined}
                      data-lit={isZoneLit(zone, id, hovered) || undefined}
                      aria-label={label}
                      title={label}
                      // The face's button spans the whole face; its edge and
                      // corner cells sit on top of it and take the clicks in
                      // the outer band, so only the middle picks the face.
                      style={
                        isFace
                          ? { gridArea: "1 / 1 / -1 / -1" }
                          : { gridColumn: zone.column + 2, gridRow: zone.row + 2, zIndex: 1 }
                      }
                      // The keyboard gets the six faces; twenty more stops,
                      // most of them facing away, would only crowd the tab order.
                      tabIndex={isFace ? undefined : -1}
                      className={cn(
                        "flex cursor-pointer items-center justify-center border border-transparent text-[9px] font-bold transition-colors duration-150",
                        SEPARATORS,
                        isZoneLit(zone, id, hovered)
                          ? "bg-[color-mix(in_srgb,var(--primary)_45%,var(--card))] text-foreground active:bg-[color-mix(in_srgb,var(--primary)_65%,var(--card))]"
                          : "bg-card/95 text-foreground/75",
                        zone.key === hovered && "!border-primary/80",
                      )}
                      onPointerEnter={() => {
                        if (!draggedRef.current) setHovered(zone.key);
                      }}
                      onPointerLeave={() =>
                        setHovered((current) => (current === zone.key ? null : current))
                      }
                      // Pointer activation is handled by the cube container
                      // because pointer capture retargets pointerup to it. A
                      // zero-detail click is keyboard activation and still
                      // belongs to the focused face button.
                      onClick={(event) => {
                        if (event.detail === 0) activate(zone.key);
                      }}
                    >
                      {isFace ? t(`short.${id}`) : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        <div
          className="viewer-projection-actions mt-4 flex flex-col"
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
                <Icon aria-hidden />
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
