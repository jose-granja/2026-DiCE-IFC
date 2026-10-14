"use client";

/**
 * Opening a project — from a folder, a `.zip` or the copy kept in this browser
 * by Save — the same way whatever it came from.
 *
 * `offer` asks first when something is open (a project replaces the session)
 * or when the project would turn the 3D world context on, which sends the
 * building's location to a third party; then `restoreProject` does the work
 * and every problem it met becomes a toast. `ProjectActions` and
 * `WorkspaceActions` both open projects through this, so Restore and "Load
 * project folder" cannot drift apart.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ProjectFolderError, type ProjectSource } from "@/lib/project/folder";
import { parseProjectManifest, ProjectFormatError, type ProjectManifest } from "@/lib/project/manifest";
import {
  projectUsesGlobe,
  restoreProject,
  type RestoreProgress,
  type RestoreReport,
} from "@/lib/project/session";
import { useBcfStore } from "@/lib/bcf/store";
import { mapTilerConfigured } from "@/lib/viewer/globe";
import { usePointCloudStore } from "@/lib/viewer/pointcloud-store";
import { useViewerStore } from "@/lib/viewer/store";

export const PROJECT_TOAST_ID = "project-progress";
const TOAST_ID = PROJECT_TOAST_ID;

type PendingLoad = {
  source: ProjectSource;
  /** Set when the project had the 3D world context on — the dialog asks about it. */
  globe: NonNullable<ProjectManifest["viewer"]["globe"]> | null;
};

/** `viewer.globeControls.layers.*` for each layer id. */
const GLOBE_LAYER_KEYS = {
  terrain: "terrain",
  "osm-buildings": "osmBuildings",
  "google-photorealistic": "googlePhotorealistic",
  "ion-asset": "ionAsset",
  "tileset-url": "tilesetUrl",
} as const;

/** Who receives the tile requests for a layer, for the dialog to name. */
function providerKey(globe: NonNullable<PendingLoad["globe"]>): {
  key: "terrain" | "terrainMapTiler" | "ion" | "google" | "url";
  host?: string;
} {
  if (globe.layer === "terrain") return { key: mapTilerConfigured() ? "terrainMapTiler" : "terrain" };
  if (globe.layer === "google-photorealistic") return { key: "google" };
  if (globe.layer === "tileset-url") {
    let host = globe.url;
    try {
      host = new URL(globe.url).host;
    } catch {
      // Not a URL: name it as written.
    }
    return { key: "url", host };
  }
  return { key: "ion" };
}

export function useProjectLoader() {
  const t = useTranslations("viewer.project");
  const tGlobe = useTranslations("viewer.globeControls");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingLoad | null>(null);
  // Ticked by default: one click for the user's own project, but always seen.
  const [allowGlobe, setAllowGlobe] = useState(true);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const describe = (error: unknown): string => {
    if (error instanceof ProjectFolderError) return t(`errors.${error.code}`);
    if (error instanceof ProjectFormatError) {
      return t(`errors.${error.code}`, { detail: error.detail ?? "" });
    }
    return error instanceof Error ? error.message : String(error);
  };

  /**
   * Ask first when something is open — a project replaces the session — or
   * when the project would turn the 3D world context on, which sends the
   * building's location to a third party. A project.json that will not parse
   * is refused here, before any question is asked.
   */
  const offer = (source: ProjectSource) => {
    const globe = projectUsesGlobe(parseProjectManifest(source.manifestText));
    const hasWork =
      useViewerStore.getState().models.length > 0 ||
      usePointCloudStore.getState().clouds.length > 0 ||
      useBcfStore.getState().file.topics.length > 0;
    if (hasWork || globe) {
      setAllowGlobe(true);
      setPending({ source, globe });
    } else void load(source, false);
  };

  const progressText = (progress: RestoreProgress) =>
    progress.step === "models"
      ? t("progress.models", { done: progress.done, total: progress.total })
      : t(`progress.${progress.step}`);

  const reportResult = (report: RestoreReport) => {
    toast.success(
      t("loaded", { name: report.name, models: report.models.loaded, clouds: report.pointClouds.loaded }),
      { id: TOAST_ID },
    );
    const problems: string[] = [
      ...report.missing.map((path) => t("warnings.missing", { path })),
      ...report.models.failed.map((entry) => t("warnings.failed", { name: entry.name, error: entry.error })),
      ...report.pointClouds.failed.map((entry) =>
        t("warnings.failed", { name: entry.name, error: entry.error }),
      ),
      ...report.warnings.map((warning) =>
        "error" in warning
          ? t(`warnings.${warning.kind}`, { error: warning.error || t("warnings.noDetail") })
          : t(`warnings.${warning.kind}`),
      ),
    ];
    for (const problem of problems) toast.warning(problem, { duration: 12_000 });
  };

  const load = async (source: ProjectSource, globe: boolean) => {
    setPending(null);
    setBusy(true);
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    try {
      toast.loading(t("progress.reading"), { id: TOAST_ID });
      const report = await restoreProject(source, {
        allowGlobe: globe,
        signal: controller.signal,
        onProgress: (progress) => toast.loading(progressText(progress), { id: TOAST_ID }),
      });
      reportResult(report);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        toast.dismiss(TOAST_ID);
        return;
      }
      toast.error(t("loadFailed", { message: describe(error) }), { id: TOAST_ID });
    } finally {
      if (abort.current === controller) abort.current = null;
      setBusy(false);
    }
  };

  const dialog = (
      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent data-project-confirm>
          <DialogHeader>
            <DialogTitle>{t("confirm.title")}</DialogTitle>
            <DialogDescription>{t("confirm.description", { name: pending?.source.name ?? "" })}</DialogDescription>
          </DialogHeader>
          {pending?.globe && (
            <div className="flex items-start gap-2 rounded-md border p-3" data-project-globe-consent>
              <Checkbox
                id="project-globe-consent"
                checked={allowGlobe}
                onCheckedChange={(checked) => setAllowGlobe(checked === true)}
                className="mt-0.5"
              />
              <Label htmlFor="project-globe-consent" className="block text-sm leading-snug font-normal">
                {t("confirm.globe", {
                  layer: tGlobe(`layers.${GLOBE_LAYER_KEYS[pending.globe.layer]}`),
                  provider: (() => {
                    const provider = providerKey(pending.globe);
                    return t(`confirm.providers.${provider.key}`, { host: provider.host ?? "" });
                  })(),
                })}
              </Label>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>
              {t("confirm.cancel")}
            </Button>
            <Button
              onClick={() => pending && void load(pending.source, Boolean(pending.globe) && allowGlobe)}
            >
              {t("confirm.load")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  );

  return { busy, offer, describe, dialog };
}
