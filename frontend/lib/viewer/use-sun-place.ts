"use client";

/**
 * Keep `useSunPlaceStore` on where the loaded models are, and the sun with it.
 *
 * The model the federation is anchored on goes first (its frame is the
 * viewer's), then the rest in load order; the first that says where it is
 * wins. A model in a CRS outside the bundled list waits for the full EPSG
 * index, as the georeferencing panel does, rather than being passed over.
 */

import { useEffect, useState } from "react";

import { isCrsIndexLoaded, loadCrsIndex } from "@/lib/georef/crs-index";
import { getActiveRenderer } from "./active-renderer";
import {
  applyDisplaySettings,
  displaySettingsValues,
  useDisplaySettingsStore,
  useSunPlaceStore,
} from "./display-settings";
import { useViewerStore } from "./store";
import { sunPlaceOf, type SunPlace } from "./sun";

export function useSunPlaceSync() {
  const models = useViewerStore((s) => s.models);
  const placements = useViewerStore((s) => s.placements);
  const anchor = useViewerStore((s) => s.worldOrigin?.derivedFrom);
  const [indexLoaded, setIndexLoaded] = useState(isCrsIndexLoaded);

  useEffect(() => {
    const ordered = [...models].sort(
      (a, b) => Number(b.summary.id === anchor) - Number(a.summary.id === anchor),
    );
    let place: SunPlace | null = null;
    let needsIndex = false;
    for (const model of ordered) {
      if (!model.coordinates) continue;
      const found = sunPlaceOf({
        id: model.summary.id,
        coordinates: model.coordinates,
        georeference: model.georeference,
        rotationY: placements[model.summary.id]?.rotationY ?? 0,
      });
      if (found === "needsCrsIndex") {
        needsIndex = true;
        // The anchor first: a later model's place would be in another frame.
        break;
      }
      if (found) {
        place = found;
        break;
      }
    }

    let cancelled = false;
    if (needsIndex && !indexLoaded) {
      void loadCrsIndex().then((loaded) => {
        if (loaded && !cancelled) setIndexLoaded(true);
      });
    }
    const previous = useSunPlaceStore.getState().place;
    if (!samePlace(previous, place)) {
      useSunPlaceStore.getState().setPlace(place);
      applyDisplaySettings(getActiveRenderer(), displaySettingsValues(useDisplaySettingsStore.getState()), place);
    }
    return () => {
      cancelled = true;
    };
  }, [models, placements, anchor, indexLoaded]);
}

function samePlace(a: SunPlace | null, b: SunPlace | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.latitude === b.latitude &&
    a.longitude === b.longitude &&
    a.north[0] === b.north[0] &&
    a.north[1] === b.north[1] &&
    a.source === b.source &&
    a.modelId === b.modelId
  );
}
