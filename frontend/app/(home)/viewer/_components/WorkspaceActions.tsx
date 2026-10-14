"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { RotateCcw, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { buildCurrentProject } from "@/lib/project/session";
import { hasWorkspace, readWorkspace, saveWorkspace, WorkspaceUnavailableError } from "@/lib/viewer/workspace";
import { usePointCloudStore } from "@/lib/viewer/pointcloud-store";
import { useViewerStore } from "@/lib/viewer/store";
import { PROJECT_TOAST_ID, useProjectLoader } from "./useProjectLoader";

/**
 * Save and Restore: the whole session, kept in this browser.
 *
 * The same project the "Project" menu writes to a folder — models, point
 * clouds, the context model, IDS, BCF, quantities, the clash matrix, filters,
 * planes, measurements, the camera — through the same builder and the same
 * restore (`lib/viewer/workspace.ts`), so the two never differ in what they
 * keep. Restore opens through the same dialog as a project folder, asking first
 * when it would replace what is open or turn the 3D world context on.
 *
 * Restore is a button, not something that happens on load: re-opening a stored
 * file handle needs the user's permission, and the permission prompt requires
 * transient activation. Called from an effect it would resolve to "prompt"
 * without ever prompting, and every model would silently fail to restore.
 */
export function WorkspaceActions() {
  const t = useTranslations("viewer.workspaceActions");
  const tProject = useTranslations("viewer.project");
  const models = useViewerStore((s) => s.models);
  const cloudCount = usePointCloudStore((s) => s.clouds.length);
  const [restorable, setRestorable] = useState(false);
  const [saving, setSaving] = useState(false);
  const loader = useProjectLoader();
  const busy = saving || loader.busy;

  useEffect(() => {
    hasWorkspace().then(setRestorable).catch(() => setRestorable(false));
  }, [models.length]);

  const onSave = async () => {
    setSaving(true);
    try {
      toast.loading(t("saving"), { id: PROJECT_TOAST_ID });
      const project = buildCurrentProject();
      await saveWorkspace(project);
      setRestorable(true);
      toast.success(
        t("saved", {
          models: project.manifest.models.length,
          clouds: project.manifest.pointClouds.length,
        }),
        { id: PROJECT_TOAST_ID },
      );
      if (project.skipped.length > 0) {
        // Never let a partial save look complete.
        toast.warning(
          tProject("skipped", { names: project.skipped.map((entry) => entry.name).join(", ") }),
          { duration: 10_000 },
        );
      }
    } catch (error) {
      const quota = error instanceof DOMException && error.name === "QuotaExceededError";
      toast.error(
        error instanceof WorkspaceUnavailableError
          ? t("unavailable")
          : quota
            ? t("quota")
            : t("saveFailed", { message: error instanceof Error ? error.message : String(error) }),
        { id: PROJECT_TOAST_ID, duration: 10_000 },
      );
    } finally {
      setSaving(false);
    }
  };

  const onRestore = async () => {
    try {
      // Straight from the click: reopening a stored file needs its activation.
      const source = await readWorkspace(t("savedName"));
      if (!source) {
        toast.info(t("noSavedWorkspace"));
        return;
      }
      loader.offer(source);
    } catch (error) {
      toast.error(t("restoreFailed", { message: loader.describe(error) }));
    }
  };

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        // With nothing open there is nothing to keep, and saving would replace
        // the session already kept with an empty one.
        disabled={busy || (models.length === 0 && cloudCount === 0)}
        onClick={onSave}
        title={t("saveHint")}
        data-workspace-save
      >
        <Save className="h-4 w-4" />
        {t("save")}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy || !restorable}
        onClick={onRestore}
        title={t("restoreHint")}
        data-workspace-restore
      >
        <RotateCcw className="h-4 w-4" />
        {t("restore")}
      </Button>
      {loader.dialog}
    </div>
  );
}

export default WorkspaceActions;
