"use client";

/**
 * Show the world under the model.
 *
 * Replaces the MapLibre ground plane, which was one texture stretched over the
 * visible ground and could never be right: its resolution changed with the
 * view, it ran out before the screen did, and it made the model read as a
 * different size at different zooms. A globe has none of those properties.
 *
 * Nothing here is on by default. The globe streams imagery, terrain and
 * geometry from a third party, and a tile request says roughly where the user
 * is looking — which in this module is where the building is.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Globe2, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { getActiveRenderer } from "@/lib/viewer/active-renderer";
import { getGlobeCanvas } from "@/lib/viewer/globe-canvas";
import {
  createGlobe,
  ionConfigured,
  mapTilerConfigured,
  type Globe,
  type GlobeLayer,
} from "@/lib/viewer/globe";
import type { WgsPoint } from "@/lib/georef/transform";

type LayerId =
  | "terrain"
  | "osm-buildings"
  | "google-photorealistic"
  | "ion-asset"
  | "tileset-url";

export function GlobeControls({
  origin,
  northCorrection = 0,
}: {
  origin: WgsPoint | null;
  /** Grid convergence at `origin`, radians — see `lib/georef/transform.ts`. */
  northCorrection?: number;
}) {
  const t = useTranslations("viewer.globeControls");

  const LABELS: Record<LayerId, string> = {
    // Overridden below when MapTiler's OSM imagery is configured — see globe.ts.
    terrain: t("layers.terrain"),
    "osm-buildings": t("layers.osmBuildings"),
    "google-photorealistic": t("layers.googlePhotorealistic"),
    "ion-asset": t("layers.ionAsset"),
    "tileset-url": t("layers.tilesetUrl"),
  };

  const globe = useRef<Globe | null>(null);
  const [on, setOn] = useState(false);
  const [layer, setLayer] = useState<LayerId>("terrain");
  const [assetId, setAssetId] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [attribution, setAttribution] = useState("");

  const configured = ionConfigured();
  const terrainLabel = mapTilerConfigured() ? t("layers.terrainAndImagery") : t("layers.terrain");

  // Tear the globe down with the panel, or it keeps streaming behind a view
  // nobody is looking at.
  useEffect(() => {
    return () => {
      getActiveRenderer()?.setGlobe(null, null);
      globe.current?.dispose();
      globe.current = null;
    };
  }, []);

  // Keep the model's position on the earth current without rebuilding: the
  // globe is expensive to create and the placement can change while it is up.
  useEffect(() => {
    if (!globe.current) return;
    getActiveRenderer()?.setGlobe(globe.current, origin, northCorrection);
  }, [origin, northCorrection]);

  useEffect(() => {
    if (!on) return;
    const timer = setInterval(
      () => setAttribution(globe.current?.getAttribution() ?? ""),
      2_000,
    );
    return () => clearInterval(timer);
  }, [on]);

  const apply = async (next: LayerId, enabled: boolean) => {
    const renderer = getActiveRenderer();
    const canvas = getGlobeCanvas();
    if (!renderer || !canvas || !origin) return;

    if (!enabled) {
      renderer.setGlobe(null, null);
      renderer.setDepthProxy(null);
      globe.current?.dispose();
      globe.current = null;
      return;
    }

    setBusy(true);
    try {
      globe.current ??= await createGlobe(canvas);

      const described: GlobeLayer =
        next === "ion-asset"
          ? { kind: "ion-asset", assetId }
          : next === "tileset-url"
            ? { kind: "tileset-url", url }
            : { kind: next };

      await globe.current.setLayer(described);
      renderer.setGlobe(globe.current, origin, northCorrection);

      /*
        Build the occluder for whatever was just loaded — terrain, 3D Tiles,
        or both.

        Deliberately after `setLayer`, and deliberately awaited separately: the
        globe should appear as soon as it can, and clamping to the scene is a
        network round trip. A failure here costs occlusion, not the map.

        The extent follows what the camera can see, so a model on a hillside
        gets the hillside. It is not rebuilt as the camera moves — the proxy is
        for the ground around the model, and re-sampling on every zoom would
        put a network request in the middle of a gesture.
      */
      try {
        renderer.setDepthProxy(
          await globe.current.sampleDepthProxy(
            origin,
            renderer.visibleGroundMetres(),
            northCorrection,
          ),
        );
      } catch {
        renderer.setDepthProxy(null);
      }
    } catch (error) {
      // A failed layer must not leave a half-built globe hiding the model.
      renderer.setGlobe(null, null);
      globe.current?.dispose();
      globe.current = null;
      setOn(false);
      toast.error(
        error instanceof Error ? error.message : t("loadFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  const needsValue =
    (layer === "ion-asset" && !assetId.trim()) ||
    (layer === "tileset-url" && !url.trim());

  return (
    <div className="space-y-2 border-b p-2" data-globe-controls>
      <div className="flex items-center justify-between gap-2">
        <Label
          htmlFor="globe-toggle"
          className="flex items-center gap-1.5 text-xs font-medium"
        >
          <Globe2 className="h-3.5 w-3.5" aria-hidden />
          {t("title")}
          {busy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
        </Label>
        <Switch
          id="globe-toggle"
          checked={on}
          disabled={!configured || !origin || needsValue}
          onCheckedChange={(next) => {
            setOn(next);
            void apply(layer, next);
          }}
        />
      </div>

      {configured && origin && (
        <>
          <Select
            value={layer}
            onValueChange={(value) => {
              const next = value as LayerId;
              setLayer(next);
              if (on) void apply(next, true);
            }}
          >
            <SelectTrigger className="h-7 text-xs" aria-label={t("worldContext")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(LABELS) as LayerId[]).map((id) => (
                <SelectItem key={id} value={id}>
                  {id === "terrain" ? terrainLabel : LABELS[id]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {layer === "ion-asset" && (
            <div className="space-y-1">
              <Input
                value={assetId}
                onChange={(event) => setAssetId(event.target.value)}
                onBlur={() => on && void apply(layer, true)}
                placeholder="96188"
                aria-label={t("ionAssetIdLabel")}
                className="h-7 font-mono text-xs"
              />
              <p className="text-muted-foreground text-[11px]">
                {t("ionAssetIdHint")}
              </p>
            </div>
          )}

          {layer === "tileset-url" && (
            <div className="space-y-1">
              <Input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                onBlur={() => on && void apply(layer, true)}
                placeholder="https://example.org/tileset.json"
                aria-label={t("tilesetUrlLabel")}
                className="h-7 font-mono text-xs"
              />
              <p className="text-muted-foreground text-[11px]">
                {t("tilesetUrlHint")}
              </p>
            </div>
          )}
        </>
      )}

      {on && attribution && (
        // Required wherever the data is shown, by both ion's and Google's terms.
        <p className="text-muted-foreground text-[11px]" data-globe-attribution>
          {attribution}
        </p>
      )}

      {!configured && (
        <p className="text-muted-foreground text-[11px]">
          {t.rich("noTokenHint", {
            code: (chunks) => <code>{chunks}</code>,
          })}
        </p>
      )}

      {configured && !origin && (
        <p className="text-muted-foreground text-[11px]">
          {t("noOriginHint")}
        </p>
      )}
    </div>
  );
}

export default GlobeControls;
