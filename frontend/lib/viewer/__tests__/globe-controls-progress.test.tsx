// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GlobeControls from "@/app/(home)/viewer/_components/GlobeControls";
import { createGlobe, type Globe } from "../globe";
import { useGlobeStore } from "../globe-store";
import messages from "@/messages/en.json";

const { renderer, notify } = vi.hoisted(() => ({
  renderer: { setGlobe: vi.fn(), setDepthProxy: vi.fn(), visibleGroundMetres: () => 100 },
  notify: vi.fn(),
}));
vi.mock("../globe", () => ({ createGlobe: vi.fn(), ionConfigured: () => true, mapTilerConfigured: () => false }));
vi.mock("../active-renderer", () => ({ getActiveRenderer: () => renderer }));
vi.mock("../globe-canvas", () => ({ getGlobeCanvas: () => document.createElement("div") }));
vi.mock("sonner", () => ({ toast: { error: notify } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let root: Root;
let container: HTMLDivElement;
let globe: Globe;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  // The globe lives in a store that outlives the panel (it stays on across
  // tabs), so each test starts from a released globe, not the last test's.
  useGlobeStore.getState().off();
  useGlobeStore.setState({ layer: "terrain", assetId: "", url: "", pendingOutcome: null });
  globe = {
    setLayer: vi.fn().mockResolvedValue(undefined),
    sampleDepthProxy: vi.fn().mockResolvedValue(null),
    getLoadingState: vi.fn().mockReturnValue({ loading: false, pending: 0 }),
    sync: vi.fn(), setSectionPlanes: vi.fn(), getAttribution: () => "", isReady: () => true, dispose: vi.fn(),
  };
  vi.mocked(createGlobe).mockResolvedValue(globe);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <GlobeControls origin={{ latitude: 41, longitude: -8, height: 10 }} />
    </NextIntlClientProvider>,
  ));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function toggle() {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
  });
}
const bar = () => container.querySelector('[role="progressbar"]');
async function poll() { await act(async () => vi.advanceTimersByTime(200)); }

describe("world map progress lifecycle", () => {
  it("covers startup, layer and depth preparation, then follows continuing tile streaming", async () => {
    const start = deferred<Globe>();
    const layer = deferred<void>();
    const depth = deferred<null>();
    vi.mocked(createGlobe).mockReturnValue(start.promise);
    vi.mocked(globe.setLayer).mockReturnValue(layer.promise);
    vi.mocked(globe.sampleDepthProxy).mockReturnValue(depth.promise);
    await toggle();
    expect(container.textContent).toContain("Starting world maps…");
    expect(bar()).not.toBeNull();
    expect(bar()?.hasAttribute("aria-valuenow")).toBe(false);

    await act(async () => start.resolve(globe));
    expect(container.textContent).toContain("Loading map layer…");
    await act(async () => layer.resolve());
    expect(container.textContent).toContain("Preparing terrain and buildings…");
    vi.mocked(globe.getLoadingState).mockReturnValue({ loading: true, pending: 12 });
    await act(async () => depth.resolve(null));
    await poll();
    expect(container.textContent).toContain("Loading map tiles…");
    expect(container.textContent).toContain("12 tiles remaining");

    vi.mocked(globe.getLoadingState).mockReturnValue({ loading: false, pending: 0 });
    await poll();
    expect(bar()).toBeNull();
    vi.mocked(globe.getLoadingState).mockReturnValue({ loading: true, pending: 3 });
    await poll();
    expect(bar()).not.toBeNull();
    expect(container.textContent).toContain("3 tiles remaining");
  });

  it("does not resurrect a map switched off while its engine was starting", async () => {
    const start = deferred<Globe>();
    vi.mocked(createGlobe).mockReturnValue(start.promise);
    await toggle();
    await toggle();
    expect(bar()).toBeNull();
    await act(async () => start.resolve(globe));
    expect(globe.dispose).toHaveBeenCalledOnce();
    expect(globe.setLayer).not.toHaveBeenCalled();
    expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
  });

  it("clears the bar and releases the map when a layer fails", async () => {
    vi.mocked(globe.setLayer).mockRejectedValue(new Error("Layer unavailable"));
    await toggle();
    expect(bar()).toBeNull();
    expect(notify).toHaveBeenCalledWith("Layer unavailable");
    expect(globe.dispose).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    expect(useGlobeStore.getState().phase).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[role="combobox"]')?.disabled).toBe(false);
  });

  it("does not install a late depth proxy after switching the map off", async () => {
    const depth = deferred<{ positions: Float32Array; indices: Uint32Array }>();
    vi.mocked(globe.sampleDepthProxy).mockReturnValue(depth.promise);
    await toggle();
    await toggle();
    const proxy = { positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) };
    await act(async () => depth.resolve(proxy));
    expect(renderer.setDepthProxy).not.toHaveBeenCalledWith(proxy);
    expect(bar()).toBeNull();
  });
});
