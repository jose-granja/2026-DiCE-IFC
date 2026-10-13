import { describe, expect, it } from "vitest";
import { trackGlobeLoading } from "../globe-loading";

function event() {
  const listeners = new Set<(...counts: number[]) => void>();
  return {
    addEventListener(listener: (...counts: number[]) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    emit(...counts: number[]) { for (const listener of listeners) listener(...counts); },
    get size() { return listeners.size; },
  };
}

describe("world map loading", () => {
  it("combines terrain/imagery queues with downloading and processing 3D Tiles", () => {
    const surface = { tilesLoaded: false, tileLoadProgressEvent: event() };
    const tileset = { tilesLoaded: false, loadProgress: event() };
    const tracker = trackGlobeLoading(surface);
    tracker.setTileset(tileset);
    surface.tileLoadProgressEvent.emit(12);
    tileset.loadProgress.emit(5, 3);
    expect(tracker.getState()).toEqual({ loading: true, pending: 20 });

    surface.tileLoadProgressEvent.emit(0);
    surface.tilesLoaded = true;
    tileset.loadProgress.emit(0, 0);
    // No queued requests does not guarantee that Cesium has refined the view.
    expect(tracker.getState()).toEqual({ loading: true, pending: 0 });
    tileset.tilesLoaded = true;
    expect(tracker.getState()).toEqual({ loading: false, pending: 0 });

    surface.tilesLoaded = false;
    surface.tileLoadProgressEvent.emit(7);
    expect(tracker.getState()).toEqual({ loading: true, pending: 7 });
    tracker.dispose();
  });

  it("drops old layer queues and removes every event listener on disposal", () => {
    const surface = { tilesLoaded: true, tileLoadProgressEvent: event() };
    const old = { tilesLoaded: false, loadProgress: event() };
    const next = { tilesLoaded: true, loadProgress: event() };
    const tracker = trackGlobeLoading(surface);
    tracker.setTileset(old);
    old.loadProgress.emit(100, 20);
    tracker.setTileset(next);
    old.loadProgress.emit(200, 40);
    expect(old.loadProgress.size).toBe(0);
    expect(tracker.getState()).toEqual({ loading: false, pending: 0 });
    tracker.dispose();
    expect(surface.tileLoadProgressEvent.size).toBe(0);
    expect(next.loadProgress.size).toBe(0);
  });
});
