"use client";

/**
 * Drag-to-resize width for docked side panels.
 *
 * The panels used to float over a full-bleed canvas (see the note this
 * replaced in `page.tsx`); they now take real layout space, which is what
 * makes a width meaningful to drag in the first place. `useResizableWidth`
 * is the state half (clamped, persisted); `ResizeHandle` is the drag surface.
 */

import { useCallback, useEffect, useRef, useState } from "react";

function storageKey(section: string, key: string): string {
  return `dice-ifc.${section}.panel-width.${key}`;
}

function readStoredWidth(key: string, min: number, max: number): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : null;
  } catch {
    // Private browsing can throw on read, not only on write.
    return null;
  }
}

/**
 * A panel width in pixels, clamped to `[min, max]` and remembered per
 * `key` across sessions.
 *
 * The state starts at `fallback` unconditionally — never at whatever
 * `localStorage` holds — and a stored width is applied afterwards, in an
 * effect. `useState(() => readStoredWidth(...))` looks like the obvious way
 * to do this and is the wrong one: the server has no `localStorage`, so its
 * render always produces `fallback`, and when the client's *first* render
 * disagrees (say the client had 460 stored), React's hydration reuses the
 * server-rendered DOM for that first commit rather than reconciling it —
 * there is no hydration-mismatch warning to see, and no re-render to fix it,
 * because as far as hydration is concerned nothing is wrong; the state itself
 * really did compute 460, only the *DOM* silently kept 304. Reading storage
 * in an effect instead makes the correction an ordinary client-only update
 * after hydration has already committed, which does patch the DOM.
 *
 * `setClamped` writes to storage itself, at the point of an actual resize,
 * rather than a `useEffect` keyed on `width` — the latter would also fire for
 * the effect above's own correction and write the freshly-read value straight
 * back, which is harmless but pointless.
 */
export function useResizableWidth(
  key: string,
  fallback: number,
  min: number,
  max: number,
  section = "viewer",
): [number, (updater: (width: number) => number) => void] {
  const [width, setWidth] = useState(fallback);
  const savedKey = storageKey(section, key);

  /* eslint-disable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect --
     Deliberately once, on mount, with no reactive dependencies: this is the
     hydration-mismatch correction the block comment above explains, not a
     synchronisation this effect should re-run for a changed `key`/`min`/`max`
     (the hook is one instance per panel; those never change for it). */
  useEffect(() => {
    const stored = readStoredWidth(savedKey, min, max);
    if (stored !== null) setWidth(stored);
  }, []);
  /* eslint-enable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */

  const setClamped = useCallback(
    (updater: (width: number) => number) => {
      setWidth((previous) => {
        const next = Math.min(max, Math.max(min, updater(previous)));
        try {
          window.localStorage.setItem(savedKey, String(next));
        } catch {
          // Full quota or private browsing — the width just resets next visit.
        }
        return next;
      });
    },
    [savedKey, min, max],
  );

  return [width, setClamped];
}

/**
 * A thin drag surface between a resizable panel and its neighbour.
 *
 * Deliberately not `pointermove` on `window`: capturing the pointer on the
 * handle itself (`setPointerCapture`) keeps delivering move events to this
 * element even once the cursor has left it — the usual way to drag past an
 * element's own bounds without a document-level listener to add and remove.
 */
export function ResizeHandle({
  onDrag,
  label,
}: {
  /** Called with the pointer's horizontal movement since the last event. */
  onDrag: (deltaX: number) => void;
  /** For the accessible name — which panel this resizes. */
  label: string;
}) {
  const lastX = useRef(0);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      className="group relative z-10 w-2 shrink-0 cursor-col-resize touch-none outline-none"
      onPointerDown={(event) => {
        lastX.current = event.clientX;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        // `setPointerCapture` keeps sending move events to this element for
        // the whole gesture, but only while a button is actually held — the
        // capture itself does not imply a drag is in progress.
        if (event.buttons !== 1) return;
        onDrag(event.clientX - lastX.current);
        lastX.current = event.clientX;
      }}
      onKeyDown={(event) => {
        // Keyboard equivalent for the same reason the tab labels stay in the
        // accessibility tree when collapsed to icons: a drag handle with no
        // non-pointer path is unusable without a mouse.
        if (event.key === "ArrowLeft") onDrag(-16);
        else if (event.key === "ArrowRight") onDrag(16);
        else return;
        event.preventDefault();
      }}
    >
      <div className="bg-border group-hover:bg-primary/60 group-focus-visible:bg-primary pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors" />
    </div>
  );
}
