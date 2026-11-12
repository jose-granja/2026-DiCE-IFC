// @vitest-environment jsdom

import { act, StrictMode, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it } from "vitest";

import ViewCube, { type ViewCubeRef } from "@/app/(home)/viewer/_components/ViewCube";
import messages from "@/messages/en.json";

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
  return <ViewCube ref={ref} projection="perspective" onProjectionChange={() => {}} onViewChange={() => {}} onDirectionChange={() => {}} onDrag={() => {}} />;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const rotation = () => container.querySelector<HTMLElement>("[data-view-cube] [style*='transform-style']")!.style.transform;

it("follows the camera after its effects run twice, as they do in development", () => {
  // StrictMode mounts, unmounts and remounts every effect on the same
  // instance. The cube once drew on the next animation frame, and its cleanup
  // cancelled the frame the viewer's first update asked for while still
  // remembering it as scheduled: every later update waited on it for ever.
  act(() => root.render(
    <StrictMode>
      <NextIntlClientProvider locale="en" messages={messages}>
        <Viewer />
      </NextIntlClientProvider>
    </StrictMode>,
  ));
  expect(rotation()).toBe("rotateX(-35deg) rotateY(-45deg)");

  act(() => cube!.updateRotation(-60, 30));
  expect(rotation()).toBe("rotateX(-60deg) rotateY(30deg)");

  act(() => cube!.updateRotation(-90, 0));
  expect(rotation()).toBe("rotateX(-90deg) rotateY(0deg)");
});
