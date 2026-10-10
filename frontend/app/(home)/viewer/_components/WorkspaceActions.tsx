"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { RotateCcw, Save } from "lucide-react";

import { getFileHandle, loadModelFiles } from "@/lib/viewer/loader";
import { useViewerStore } from "@/lib/viewer/store";
import {
  hasWorkspace,
  restoreWorkspace,
  saveWorkspace,
} from "@/lib/viewer/workspace";
import { Button } from "@/components/ui/button";
import { getActiveRenderer } from "@/lib/viewer/active-renderer";

/**
 * Save and restore the federation.
 *
 * Restore is a button, not something that happens on load: re-opening a stored
 * file handle needs the user's permission, and the permission prompt requires
 * transient activation. Called from an effect it would resolve to "prompt"
 * without ever prompting, and every model would silently fail to restore.
 */
export function WorkspaceActions() {
  const t = useTranslations("viewer.workspaceActions");
  const models = useViewerStore((s) => s.models);
  const [restorable, setRestorable] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    hasWorkspace().then(setRestorable).catch(() => setRestorable(false));
  }, [models.length]);

  const onSave = async () => {
    setBusy(true);
    try {
      const { saved, unsaveable } = await saveWorkspace(
        models.map((model) => ({
          name: model.summary.name,
          colour: model.colour,
          visible: model.visible,
          manualOffset: model.manualOffset,
          handle: getFileHandle(model.summary.id),
        })),
        getActiveRenderer()?.getCameraState(),
      );

      if (saved > 0) {
        toast.success(t("saved", { count: saved }));
        setRestorable(true);
      }
      if (unsaveable.length > 0) {
        // Never pretend a partial save was complete.
        toast.warning(t("unsaveable", { names: unsaveable.join(", ") }), {
          duration: 10_000,
        });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const onRestore = async () => {
    setBusy(true);
    try {
      const result = await restoreWorkspace();
      if (!result) {
        toast.info(t("noSavedWorkspace"));
        return;
      }

      if (result.models.length > 0) {
        await loadModelFiles(
          result.models.map((m) => ({ file: m.file, handle: m.handle })),
        );
        if (result.camera) getActiveRenderer()?.setCameraState(result.camera);
        toast.success(t("restored", { count: result.models.length }));
      }

      for (const skipped of result.skipped) {
        toast.error(`${skipped.name}: ${skipped.reason}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("restoreFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        disabled={busy || models.length === 0}
        onClick={onSave}
      >
        <Save className="h-4 w-4" />
        {t("save")}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy || !restorable}
        onClick={onRestore}
      >
        <RotateCcw className="h-4 w-4" />
        {t("restore")}
      </Button>
    </div>
  );
}

export default WorkspaceActions;
