"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Eye, ImageUp, Loader2, Maximize2, PenLine, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { captureViewpoint } from "@/lib/bcf/actions";
import { composeAnnotatedSnapshot, readAnnotatedSnapshot } from "@/lib/bcf/annotations";
import { hasViewToRestore } from "@/lib/bcf/snapshot-file";
import { useBcfStore } from "@/lib/bcf/store";
import { describeViewpoint } from "@/lib/bcf/viewpoint";
import type { BcfTopic, BcfViewpoint } from "@/lib/bcf/types";
import { useSnapshotUrl } from "@/lib/bcf/use-snapshot-url";
import { useOpenViewpoint } from "./useOpenViewpoint";
import { usePictureFile } from "./usePictureFile";

/**
 * One viewpoint: its snapshot, what it will do, and the buttons that act on it.
 *
 * "Open viewpoint" is the reason this module and the viewer share one store.
 * "Update" puts the viewer's current view into this viewpoint instead of a new
 * one — same guid and file name, so comments that point at it still do.
 * The snapshot can also be a picture from the computer, and opened large.
 */
export function ViewpointCard({
  topic,
  viewpoint,
  onAnnotate,
}: {
  topic: BcfTopic;
  viewpoint: BcfViewpoint;
  onAnnotate?: (viewpoint: BcfViewpoint) => void;
}) {
  const t = useTranslations("bcf.viewpointCard");
  const tPicture = useTranslations("bcf.picture");
  const removeViewpoint = useBcfStore((s) => s.removeViewpoint);
  const updateViewpoint = useBcfStore((s) => s.updateViewpoint);
  const { openViewpoint, openingGuid } = useOpenViewpoint();
  const snapshotUrl = useSnapshotUrl(viewpoint);
  const [updating, setUpdating] = useState(false);
  const [viewing, setViewing] = useState(false);
  const restorable = hasViewToRestore(viewpoint);

  // A picture replaces the snapshot, annotations and all: they were drawn on another image.
  const picture = usePictureFile((snapshot, file) => {
    const previous = viewpoint.snapshot;
    updateViewpoint(topic.guid, viewpoint.guid, {
      snapshot: { fileName: previous?.fileName ?? snapshot.fileName, bytes: snapshot.bytes },
    });
    toast.success(tPicture("replaced", { name: file.name }), {
      action: {
        label: t("undo"),
        onClick: () => updateViewpoint(topic.guid, viewpoint.guid, { snapshot: previous }),
      },
    });
  });

  const onUpdate = async () => {
    setUpdating(true);
    try {
      const captured = await captureViewpoint(topic.headerFiles[0]?.filename);
      if (!captured) {
        toast.warning(t("loadModelFirst"));
        return;
      }
      const previous = viewpoint;
      // Annotations are kept, drawn again on the new image: they are proportional
      // to it, and losing someone's markup is worse than an arrow to move.
      const kept = previous.snapshot ? (readAnnotatedSnapshot(previous.snapshot.bytes)?.shapes ?? []) : [];
      const snapshot = captured.snapshot
        ? {
            fileName: previous.snapshot?.fileName ?? captured.snapshot.fileName,
            bytes: kept.length > 0
              ? await composeAnnotatedSnapshot(captured.snapshot.bytes, kept)
              : captured.snapshot.bytes,
          }
        : previous.snapshot;
      updateViewpoint(topic.guid, previous.guid, {
        camera: captured.camera,
        components: captured.components,
        clippingPlanes: captured.clippingPlanes,
        snapshot,
      });
      toast.success(kept.length > 0 ? t("updatedWithAnnotations", { count: kept.length }) : t("updated"), {
        action: {
          label: t("undo"),
          onClick: () => updateViewpoint(topic.guid, previous.guid, previous),
        },
      });
    } catch (error) {
      toast.error(t("updateFailed", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="@container overflow-hidden rounded-md border" data-viewpoint={viewpoint.guid}>
      {picture.input}
      {snapshotUrl ? (
        <div className="group relative">
          <button
            type="button"
            className="block w-full cursor-zoom-in"
            onClick={() => setViewing(true)}
            title={tPicture("view")}
          >
            {/* A plain <img>: this is a blob: URL for the user's own snapshot, and
                next/image would route it through the server optimiser — which is
                precisely what must never happen to a payload (AGENTS.md §1). */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={snapshotUrl}
              alt={t("snapshotFor", { title: topic.title })}
              className="bg-muted aspect-video w-full object-cover"
            />
          </button>
          <Button
            variant="secondary"
            size="sm"
            className="absolute top-1.5 right-1.5 h-7 w-7 p-0 opacity-80 shadow-sm hover:opacity-100"
            onClick={() => setViewing(true)}
            aria-label={tPicture("view")}
            title={tPicture("view")}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <div className="bg-muted text-muted-foreground flex aspect-video w-full items-center justify-center text-xs">
          {t("noSnapshot")}
        </div>
      )}

      <div className="space-y-1.5 p-2">
        <p className="text-muted-foreground truncate text-[11px]">
          {restorable ? describeViewpoint(viewpoint) : tPicture("pictureOnly")}
        </p>

        <div className="flex flex-wrap items-center gap-1">
          <Button
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => openViewpoint(topic, viewpoint)}
            disabled={openingGuid === viewpoint.guid || !restorable}
            aria-label={t("openViewpoint")}
            title={restorable ? t("openViewpoint") : tPicture("nothingToOpen")}
          >
            <Eye className="h-3.5 w-3.5" />
            {/* Just the eye in a card too narrow for the words and the other five buttons. */}
            <span className="hidden @2xs:inline">{t("openViewpoint")}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => void onUpdate()}
            disabled={updating}
            aria-label={t("update")}
            title={t("update")}
          >
            {updating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={picture.choose}
            disabled={picture.reading}
            aria-label={tPicture("replace")}
            title={tPicture("replace")}
          >
            {picture.reading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImageUp className="h-3.5 w-3.5" />}
          </Button>
          {onAnnotate && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => onAnnotate(viewpoint)}
              disabled={!viewpoint.snapshot}
              aria-label={t("annotate")}
              title={viewpoint.snapshot ? t("annotate") : t("annotateNoSnapshot")}
            >
              <PenLine className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => removeViewpoint(topic.guid, viewpoint.guid)}
            aria-label={t("deleteViewpoint")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <PictureDialog
        open={viewing && Boolean(snapshotUrl)}
        onOpenChange={setViewing}
        url={snapshotUrl}
        title={topic.title}
        onAnnotate={onAnnotate && viewpoint.snapshot ? () => {
          setViewing(false);
          onAnnotate(viewpoint);
        } : undefined}
        onReplace={picture.choose}
      />
    </div>
  );
}

/** The snapshot as large as the window allows, to read what a thumbnail cannot show. */
function PictureDialog({
  open,
  onOpenChange,
  url,
  title,
  onAnnotate,
  onReplace,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string | null;
  title: string;
  onAnnotate?: () => void;
  onReplace: () => void;
}) {
  const t = useTranslations("bcf.picture");
  const tCard = useTranslations("bcf.viewpointCard");
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[calc(100vh-2rem)] flex-col gap-3 p-4 sm:max-w-[calc(100%-2rem)] lg:max-w-6xl"
        data-picture-dialog
      >
        <DialogHeader>
          <DialogTitle className="truncate pr-6">{t("viewTitle", { title: title || t("untitled") })}</DialogTitle>
          <DialogDescription>{size ? t("size", size) : "\u00a0"}</DialogDescription>
        </DialogHeader>
        {url && (
          <div className="bg-muted flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-md">
            {/* eslint-disable-next-line @next/next/no-img-element -- a blob: URL, see the card above */}
            <img
              src={url}
              alt={tCard("snapshotFor", { title })}
              className="max-h-[calc(100vh-12rem)] max-w-full object-contain"
              onLoad={(event) =>
                setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
              }
            />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onReplace}>
            <ImageUp className="h-3.5 w-3.5" />
            {t("replaceShort")}
          </Button>
          {onAnnotate && (
            <Button variant="outline" size="sm" onClick={onAnnotate}>
              <PenLine className="h-3.5 w-3.5" />
              {t("annotate")}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default ViewpointCard;
