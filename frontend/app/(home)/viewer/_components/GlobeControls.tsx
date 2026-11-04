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

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Globe2 } from "lucide-react";
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
import { linkAttribution } from "@/lib/viewer/attribution";
import { ionConfigured } from "@/lib/viewer/globe";
import { GLOBE_IMAGERY, getGlobe, useGlobeStore, type GlobeImageryId, type GlobeLayerId } from "@/lib/viewer/globe-store";
import type { WgsPoint } from "@/lib/georef/transform";
import type { GlobeLoadingState } from "@/lib/viewer/globe-loading";
import LoadingProgress from "./LoadingProgress";

type LayerId = GlobeLayerId;

export function GlobeControls({
  origin,
  northCorrection = 0,
  ready = true,
}: {
  origin: WgsPoint | null;
  /** Grid convergence at `origin`, radians — see `lib/georef/transform.ts`. */
  northCorrection?: number;
  /**
   * True once the panel has worked out where the model sits, whether or not
   * that gave an origin — what a restored project waits for before it can say
   * "turned on" or "this model has nowhere on the earth to show it".
   */
  ready?: boolean;
}) {
  const t = useTranslations("viewer.globeControls");

  const LABELS: Record<LayerId, string> = {
    terrain: t("layers.terrain"),
    "osm-buildings": t("layers.osmBuildings"),
    "google-photorealistic": t("layers.googlePhotorealistic"),
    "ion-asset": t("layers.ionAsset"),
    "tileset-url": t("layers.tilesetUrl"),
  };

  // The globe is the store's, not this panel's: it stays on when the panel
  // closes (see `globe-store.ts`).
  const on = useGlobeStore((s) => s.on);
  const layer = useGlobeStore((s) => s.layer);
  const assetId = useGlobeStore((s) => s.assetId);
  const url = useGlobeStore((s) => s.url);
  const imagery = useGlobeStore((s) => s.imagery);
  const phase = useGlobeStore((s) => s.phase);
  const pending = useGlobeStore((s) => s.pending);
  const setSettings = useGlobeStore((s) => s.setSettings);
  const setLayer = (next: LayerId) => setSettings({ layer: next });
  const setAssetId = (value: string) => setSettings({ assetId: value });
  const setUrl = (value: string) => setSettings({ url: value });
  const [tiles, setTiles] = useState<GlobeLoadingState>({ loading: false, pending: 0 });
  const busy = phase !== null;
  const [attribution, setAttribution] = useState("");

  const configured = ionConfigured();
  // Google Photorealistic covers the ground itself, so the map is not drawn under it.
  const mapApplies = layer !== "google-photorealistic";
  const showsGoogle = on && (layer === "google-photorealistic" || imagery !== "none");

  const chooseImagery = async (next: GlobeImageryId) => {
    const outcome = await useGlobeStore.getState().setImagery(next);
    if (!outcome.ok) toast.error(t("imagery.failed", { message: outcome.error }));
  };

  // Tell the store where the model is, for as long as this panel is the one
  // that knows; the globe keeps the last placement when the panel closes.
  useEffect(() => {
    useGlobeStore.getState().setPlacement(origin, northCorrection);
  }, [origin, northCorrection]);

  useEffect(() => {
    if (!on) return;
    const timer = setInterval(
      () => setAttribution(getGlobe()?.getAttribution() ?? ""),
      2_000,
    );
    return () => clearInterval(timer);
  }, [on]);

  // Tile streaming continues after setLayer resolves, and restarts when the
  // camera moves. Read Cesium's live queues without rerendering on every frame.
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => {
      const next = getGlobe()?.getLoadingState() ?? { loading: false, pending: 0 };
      setTiles((previous) => previous.loading === next.loading && previous.pending === next.pending ? previous : next);
    }, 200);
    return () => clearInterval(timer);
  }, [on]);

  const apply = async (enabled: boolean) => {
    if (enabled) setTiles({ loading: false, pending: 0 });
    else {
      setTiles({ loading: false, pending: 0 });
      setAttribution("");
    }
    const outcome = await useGlobeStore.getState().enable(enabled);
    if (!outcome.ok) toast.error(outcome.reason ? t(`restore.${outcome.reason}`) : outcome.error || t("loadFailed"));
    return outcome;
  };

  /*
    The globe from a restored project, once this panel knows where the model
    is. The project's consent was asked for when it was loaded; here it is only
    a matter of having somewhere to put it.
  */
  useEffect(() => {
    if (!pending || !ready) return;
    const store = useGlobeStore.getState();
    if (!configured) {
      store.finishPending({ ok: false, error: t("restore.notConfigured"), reason: "notConfigured" });
      return;
    }
    if (!origin) {
      store.finishPending({ ok: false, error: t("restore.noOrigin"), reason: "noOrigin" });
      return;
    }
    // Claimed before the await, so a re-render cannot start a second one.
    useGlobeStore.setState({ pending: false });
    void useGlobeStore
      .getState()
      .enable(true)
      .then((outcome) => useGlobeStore.getState().finishPending(outcome));
    // `t` is stable for a locale; `configured` cannot change while the page is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, ready, origin]);

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
        </Label>
        <Switch
          id="globe-toggle"
          checked={on}
          disabled={!on && (!configured || !origin || needsValue)}
          onCheckedChange={(next) => void apply(next)}
        />
      </div>

      {on && (busy || tiles.loading) && (
        <LoadingProgress
          label={t(`progress.${phase ?? "tiles"}`)}
          detail={tiles.pending > 0 ? t("tilesPending", { count: tiles.pending }) : undefined}
        />
      )}

      {configured && origin && (
        <>
          <Select
            value={layer}
            disabled={busy}
            onValueChange={(value) => {
              const next = value as LayerId;
              setLayer(next);
              if (on) void apply(true);
            }}
          >
            <SelectTrigger className="h-7 text-xs" aria-label={t("worldContext")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(LABELS) as LayerId[]).map((id) => (
                <SelectItem key={id} value={id}>
                  {LABELS[id]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-2">
            <Label htmlFor="globe-imagery" className="text-muted-foreground shrink-0 text-[11px] font-normal">
              {t("imagery.label")}
            </Label>
            <Select
              value={imagery}
              disabled={busy || !mapApplies}
              onValueChange={(value) => void chooseImagery(value as GlobeImageryId)}
            >
              <SelectTrigger id="globe-imagery" className="h-7 flex-1 text-xs" aria-label={t("imagery.label")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GLOBE_IMAGERY.map((id) => (
                  <SelectItem key={id} value={id}>
                    {t(`imagery.options.${id}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {!mapApplies && <p className="text-muted-foreground text-[11px]">{t("imagery.notUnderPhotorealistic")}</p>}

          {layer === "ion-asset" && (
            <div className="space-y-1">
              <Input
                value={assetId}
                disabled={busy}
                onChange={(event) => setAssetId(event.target.value)}
                onBlur={() => on && void apply(true)}
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
                disabled={busy}
                onChange={(event) => setUrl(event.target.value)}
                onBlur={() => on && void apply(true)}
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
        // Required wherever the data is shown, by both ion's and Google's terms;
        // Google's logo is on the map itself (`GlobeGoogleLogo`).
        <p className="text-muted-foreground text-[11px]" data-globe-attribution>
          {linkAttribution(attribution).map((part, index) => (
            <span key={`${part.text}-${index}`}>
              {index > 0 && " · "}
              {part.href ? (
                <a
                  href={part.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-foreground underline underline-offset-2"
                >
                  {part.text}
                </a>
              ) : (
                part.text
              )}
            </span>
          ))}
        </p>
      )}

      {showsGoogle && (
        <p className="text-muted-foreground text-[11px]" data-globe-google-terms>
          {t("googleTerms")}
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
