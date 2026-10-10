"use client";

import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { FolderOpen } from "lucide-react";

import {
  filesFromDataTransfer,
  loadModelFiles,
  pickIfcFiles,
  supportsFileSystemAccess,
} from "@/lib/viewer/loader";
import { IFC_FILE_EXTENSIONS } from "@/config";
import { POINT_CLOUD_ACCEPT } from "@/lib/pointcloud/formats";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Drop target covering the whole viewer, plus the "Add models" button.
 *
 * Files go straight to a worker; nothing here may ever grow a network call
 * (AGENTS.md §1). Dropping a folder walks it, so a coordinator can drag in a
 * directory of discipline models and get a federation.
 */
export function ModelDropZone({ children }: { children: React.ReactNode }) {
  const t = useTranslations("viewer.dropZone");
  const [dragging, setDragging] = useState(false);
  // Drag events fire for every child element; a counter is what keeps the
  // overlay from flickering as the pointer crosses the panels.
  const depth = useRef(0);

  const report = useCallback(
    (results: Awaited<ReturnType<typeof loadModelFiles>>) => {
      const failed = results.filter((r) => !r.ok);
      const loaded = results.length - failed.length;

      if (loaded > 0) {
        toast.success(t("loaded", { count: loaded }));
      }
      for (const failure of failed) {
        if (!failure.ok) {
          toast.error(t("failedItem", { file: failure.file, error: failure.error }));
        }
      }
      if (results.length === 0) {
        toast.info(t("noneFound", {
          extensions: [...IFC_FILE_EXTENSIONS, ...POINT_CLOUD_ACCEPT.split(",")].join(", "),
        }));
      }
    },
    [t],
  );

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      depth.current = 0;
      setDragging(false);

      const files = await filesFromDataTransfer(event.dataTransfer);
      report(await loadModelFiles(files));
    },
    [report],
  );

  return (
    <div
      onDragEnter={(e) => {
        e.preventDefault();
        depth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault();
        depth.current -= 1;
        if (depth.current <= 0) setDragging(false);
      }}
      onDrop={onDrop}
      // `flex-1 min-h-0`, not `h-full`. As a flex child, `height: 100%`
      // resolves against the whole column — including the header above it — so
      // the zone ends up taller than the space it has and overflows the page.
      // That was invisible while the panels were docked and the canvas was one
      // cell of a grid; a full-bleed canvas pushed the viewport controls off
      // the bottom of the screen.
      className="relative flex w-full min-h-0 flex-1 flex-col"
    >
      {children}

      {dragging && (
        <div
          className={cn(
            "border-primary bg-background/80 pointer-events-none absolute inset-2 z-50",
            "flex items-center justify-center rounded-lg border-2 border-dashed backdrop-blur-sm",
          )}
        >
          <p className="text-sm font-medium">{t("hint")}</p>
        </div>
      )}
    </div>
  );
}

export function AddModelsButton() {
  const t = useTranslations("viewer.dropZone");
  const inputRef = useRef<HTMLInputElement>(null);

  const onPick = async () => {
    // The File System Access API yields handles, which is what makes workspace
    // restore possible; the input fallback yields Files only.
    if (supportsFileSystemAccess()) {
      const picked = await pickIfcFiles();
      if (picked.length === 0) return;
      // Pass the handles through, not just the files: they are what lets the
      // workspace be restored after a reload.
      await loadModelFiles(picked);
      return;
    }
    inputRef.current?.click();
  };

  return (
    <>
      {/*
        The icon must NOT depend on `supportsFileSystemAccess()`: that reads
        `window`, so the server renders one icon and the client another, and
        React throws a hydration error and re-renders the whole page tree. Which
        file API is used is an implementation detail the user cannot act on, so
        the capability check belongs in the handler, where it runs client-side
        only.
      */}
      <Button variant="secondary" size="sm" onClick={onPick}>
        <FolderOpen className="h-4 w-4" />
        {t("addModels")}
      </Button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={`${IFC_FILE_EXTENSIONS.join(",")},${POINT_CLOUD_ACCEPT}`}
        className="hidden"
        onChange={async (event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length > 0) await loadModelFiles(files);
        }}
      />
    </>
  );
}

export default ModelDropZone;
