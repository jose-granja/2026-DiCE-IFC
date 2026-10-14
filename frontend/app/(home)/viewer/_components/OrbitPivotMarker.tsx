"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { getActiveRenderer } from "@/lib/viewer/active-renderer";

/** Show the rotation point during a gesture, without clearing the saved pivot. */
export default function OrbitPivotMarker({ ready, active }: { ready: boolean; active: boolean }) {
  const t = useTranslations("viewer.canvas");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ready) return;
    let frame = 0;
    const update = () => {
      const marker = ref.current;
      const renderer = getActiveRenderer();
      if (marker && renderer) {
        const pivot = renderer.getOrbitPivot();
        const screen = pivot ? renderer.projectPoint(pivot) : null;
        marker.hidden = !active || !screen?.visible;
        if (screen) {
          marker.style.left = `${screen.x}px`;
          marker.style.top = `${screen.y}px`;
        }
        marker.dataset.orbitPivot = pivot?.join(",") ?? "";
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [ready, active]);

  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      <div
        ref={ref}
        hidden
        data-orbit-pivot=""
        role="img"
        aria-label={t("rotationPoint")}
        className="border-primary bg-background/70 absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-sm"
      >
        <span className="bg-primary absolute inset-0.5 rounded-full" />
      </div>
    </div>
  );
}
