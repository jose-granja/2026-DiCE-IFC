"use client";

import { GOOGLE_LOGO_URL } from "@/lib/viewer/globe";
import { useGlobeStore } from "@/lib/viewer/globe-store";

/**
 * Google's logo on the map, bottom-left, whenever the globe shows Google data
 * (the 2D map under the terrain, or Photorealistic 3D). Google's Map Tiles
 * policies want it on the map itself; the logo ion serves is white, made to
 * sit over imagery, so the panel beside the view is the wrong place for it.
 * The data credit stays in the GIS panel's attribution line.
 */
export function GlobeGoogleLogo() {
  const on = useGlobeStore((s) => s.on);
  const layer = useGlobeStore((s) => s.layer);
  const imagery = useGlobeStore((s) => s.imagery);
  if (!on || (layer !== "google-photorealistic" && imagery === "none")) return null;
  return (
    // A plain <img>: ion's own asset host, already in the CSP; next/image would
    // route it through this server for no gain.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={GOOGLE_LOGO_URL}
      alt="Google"
      className="pointer-events-none absolute bottom-2 left-2 z-10 h-[18px] w-auto drop-shadow-[0_0_2px_rgba(0,0,0,0.6)]"
      data-globe-google-logo
    />
  );
}

export default GlobeGoogleLogo;
