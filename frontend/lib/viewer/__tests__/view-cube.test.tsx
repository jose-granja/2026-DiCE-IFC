// @vitest-environment jsdom

import { act, StrictMode, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import ViewCube, { type ViewCubeRef } from "@/app/(home)/viewer/_components/ViewCube";
import messages from "@/messages/en.json";

/** Animation frames, run by hand. */
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
function runFrames() {
  const due = [...frames.values()];
  frames = new Map();
  for (const callback of due) callback(0);
}

let root: Root;
let container: HTMLDivElement;
let cube: ViewCubeRef | null = null;

/** As `ViewerCanvas` does: the renderer reports the camera's angles as soon as it is made, in an effect. */
function Viewer() {
  const ref = useRef<ViewCubeRef | null>(null);
  useEffect(() => {
    ref.current?.updateRotation(-35, -45);
    cube = ref.current;
  }, []);
  return <ViewCube ref={ref} projection="perspective" onProjectionChange={() => {}} onViewChange={() => {}} onDrag={() => {}} />;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(nextFrame, callback);
    return nextFrame++;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const rotation = () => container.querySelector<HTMLElement>("[data-view-cube] [style*='transform-style']")!.style.transform;

it("follows the camera after its effects run twice, as they do in development", () => {
  // StrictMode mounts, unmounts and remounts every effect on the same
  // instance: the cube's cleanup cancels the first frame the viewer asked for.
  act(() => root.render(
    <StrictMode>
      <NextIntlClientProvider locale="en" messages={messages}>
        <Viewer />
      </NextIntlClientProvider>
    </StrictMode>,
  ));
  act(() => runFrames());

  act(() => cube!.updateRotation(-60, 30));
  act(() => runFrames());
  expect(rotation()).toBe("rotateX(-60deg) rotateY(30deg)");

  act(() => cube!.updateRotation(-90, 0));
  act(() => runFrames());
  expect(rotation()).toBe("rotateX(-90deg) rotateY(0deg)");
});
