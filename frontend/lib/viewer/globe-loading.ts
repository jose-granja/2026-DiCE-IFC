/** Public Cesium queue signals; a streaming view has no fixed total or percent. */
type LoadingEvent = {
  addEventListener: (listener: (...counts: number[]) => void) => () => void;
};
type Surface = { readonly tilesLoaded: boolean; tileLoadProgressEvent: LoadingEvent };
type Tileset = { readonly tilesLoaded: boolean; loadProgress: LoadingEvent };

export type GlobeLoadingState = { loading: boolean; pending: number };

export function trackGlobeLoading(surface: Surface) {
  let surfacePending = 0;
  let tilesPending = 0;
  let tileset: Tileset | null = null;
  let stopTiles: (() => void) | undefined;
  const count = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;
  const stopSurface = surface.tileLoadProgressEvent.addEventListener((pending) => {
    surfacePending = count(pending);
  });

  return {
    setTileset(next: Tileset | null) {
      stopTiles?.();
      tileset = next;
      tilesPending = 0;
      stopTiles = next?.loadProgress.addEventListener((requests, processing) => {
        tilesPending = count(requests) + count(processing);
      });
    },
    getState(): GlobeLoadingState {
      const pending = surfacePending + tilesPending;
      return {
        loading: pending > 0 || !surface.tilesLoaded || Boolean(tileset && !tileset.tilesLoaded),
        pending,
      };
    },
    dispose() {
      stopTiles?.();
      stopSurface();
      tileset = null;
    },
  };
}
