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

import { useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { FolderDown, FolderOpen, FolderTree, FileArchive } from "lucide-react";

import { Button } from "@/components/ui/button";
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
  readProjectFromFileList,
  readProjectFromZip,
  writeProjectFolder,
} from "@/lib/project/folder";
import { buildCurrentProject } from "@/lib/project/session";
import { PROJECT_TOAST_ID, useProjectLoader } from "./useProjectLoader";

const TOAST_ID = PROJECT_TOAST_ID;

/** Whether a browser can write folders does not change while the page is open. */
const noSubscription = () => () => {};

export function ProjectActions() {
  const t = useTranslations("viewer.project");
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const [saving, setBusy] = useState(false);
  const loader = useProjectLoader();
  const { offer, describe } = loader;
  const busy = saving || loader.busy;
  // The server has no `window` to ask, so it renders the folder label and the
  // client corrects it after hydration.
  const writesFolders = useSyncExternalStore(noSubscription, canWriteFolders, () => true);

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

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" disabled={busy} data-project-menu title={t("button")}>
            <FolderTree className="h-4 w-4" aria-hidden />
            <span className="sr-only lg:not-sr-only">{t("button")}</span>
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

      {loader.dialog}
    </>
  );
}

export default ProjectActions;
