"use client";

/**
 * Save the whole viewer session as a project folder, and open one again.
 *
 * The folder holds the files the user opened — models, point clouds, the
 * context model, IDS and BCF — and a `project.json` with everything else. It is
 * written to and read from the user's own disk; nothing is uploaded
 * (AGENTS.md §1).
 *
 * Saving goes straight into a folder where the browser can write one
 * (Chromium's File System Access API). Firefox and Safari cannot, so there the
 * same folder is downloaded as a `.zip`, and loading takes either.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { FolderDown, FolderOpen, FolderTree, FileArchive } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  canWriteFolders,
  pickParentDirectory,
  projectFolderName,
  projectZip,
  ProjectFolderError,
  readProjectFromFileList,
  readProjectFromZip,
  writeProjectFolder,
  type ProjectSource,
} from "@/lib/project/folder";
import { parseProjectManifest, ProjectFormatError, type ProjectManifest } from "@/lib/project/manifest";
import {
  buildCurrentProject,
  projectUsesGlobe,
  restoreProject,
  type RestoreProgress,
  type RestoreReport,
} from "@/lib/project/session";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { mapTilerConfigured } from "@/lib/viewer/globe";
import { useBcfStore } from "@/lib/bcf/store";
import { usePointCloudStore } from "@/lib/viewer/pointcloud-store";
import { useViewerStore } from "@/lib/viewer/store";

const TOAST_ID = "project-progress";

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

/** Whether a browser can write folders does not change while the page is open. */
const noSubscription = () => () => {};

export function ProjectActions() {
  const t = useTranslations("viewer.project");
  const tGlobe = useTranslations("viewer.globeControls");
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingLoad | null>(null);
  // Ticked by default: one click for the user's own project, but always seen.
  const [allowGlobe, setAllowGlobe] = useState(true);
  // The server has no `window` to ask, so it renders the folder label and the
  // client corrects it after hydration.
  const writesFolders = useSyncExternalStore(noSubscription, canWriteFolders, () => true);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  // ---- save

  const onSave = async () => {
    setBusy(true);
    try {
      // Picked first: the folder picker needs the click's user activation,
      // which is spent by the time anything slow has run.
      const parent = writesFolders ? await pickParentDirectory() : null;
      if (writesFolders && !parent) return;

      const project = buildCurrentProject();
      const name = projectFolderName();
      toast.loading(t("saving"), { id: TOAST_ID });

      if (parent) {
        const written = await writeProjectFolder(parent, name, project.files, (done, total) => {
          toast.loading(t("savingProgress", { percent: total > 0 ? Math.round((done / total) * 100) : 100 }), {
            id: TOAST_ID,
          });
        });
        toast.success(t("saved", { name: written }), { id: TOAST_ID });
      } else {
        const zip = await projectZip(name, project.files);
        const url = URL.createObjectURL(zip);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${name}.zip`;
        link.click();
        // Revoked on the next turn: the download has its own reference by then.
        setTimeout(() => URL.revokeObjectURL(url), 0);
        toast.success(t("savedZip", { name: `${name}.zip` }), { id: TOAST_ID });
      }

      if (project.skipped.length > 0) {
        // Never let a partial save look complete.
        toast.warning(t("skipped", { names: project.skipped.map((entry) => entry.name).join(", ") }), {
          duration: 10_000,
        });
      }
    } catch (error) {
      toast.error(t("saveFailed", { message: error instanceof Error ? error.message : String(error) }), {
        id: TOAST_ID,
      });
    } finally {
      setBusy(false);
    }
  };

  // ---- load

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

  const onFolder = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    try {
      offer(await readProjectFromFileList([...files]));
    } catch (error) {
      toast.error(describe(error));
    } finally {
      if (folderInput.current) folderInput.current.value = "";
    }
  };

  const onZip = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      toast.loading(t("progress.reading"), { id: TOAST_ID });
      const source = await readProjectFromZip(file);
      toast.dismiss(TOAST_ID);
      offer(source);
    } catch (error) {
      toast.error(describe(error), { id: TOAST_ID });
    } finally {
      setBusy(false);
      if (zipInput.current) zipInput.current.value = "";
    }
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

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" disabled={busy} data-project-menu>
            <FolderTree className="h-4 w-4" aria-hidden />
            {t("button")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
            {t("menuHint")}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void onSave()}>
            <FolderDown className="h-4 w-4" aria-hidden />
            {writesFolders ? t("save") : t("saveZip")}
          </DropdownMenuItem>
          {!writesFolders && (
            <p className="text-muted-foreground px-2 pb-1 text-[11px] leading-snug">{t("saveZipHint")}</p>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => folderInput.current?.click()}>
            <FolderOpen className="h-4 w-4" aria-hidden />
            {t("load")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => zipInput.current?.click()}>
            <FileArchive className="h-4 w-4" aria-hidden />
            {t("loadZip")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        ref={folderInput}
        type="file"
        className="hidden"
        data-project-folder-input
        // Not in React's types; every current browser supports it.
        {...{ webkitdirectory: "", directory: "" }}
        multiple
        onChange={(event) => void onFolder(event.target.files)}
      />
      <input
        ref={zipInput}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        data-project-zip-input
        onChange={(event) => void onZip(event.target.files?.[0])}
      />

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
    </>
  );
}

export default ProjectActions;
