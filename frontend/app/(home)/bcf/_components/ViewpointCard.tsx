"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Eye, Loader2, PenLine, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { captureViewpoint } from "@/lib/bcf/actions";
import { composeAnnotatedSnapshot, readAnnotatedSnapshot } from "@/lib/bcf/annotations";
import { useBcfStore } from "@/lib/bcf/store";
import { describeViewpoint } from "@/lib/bcf/viewpoint";
import type { BcfTopic, BcfViewpoint } from "@/lib/bcf/types";
import { useSnapshotUrl } from "@/lib/bcf/use-snapshot-url";
import { useOpenViewpoint } from "./useOpenViewpoint";

/**
 * One viewpoint: its snapshot, what it will do, and the buttons that act on it.
 *
 * "Open viewpoint" is the reason this module and the viewer share one store.
 * "Update" puts the viewer's current view into this viewpoint instead of a new
 * one — same guid and file name, so comments that point at it still do.
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
  const removeViewpoint = useBcfStore((s) => s.removeViewpoint);
  const updateViewpoint = useBcfStore((s) => s.updateViewpoint);
  const { openViewpoint, openingGuid } = useOpenViewpoint();
  const snapshotUrl = useSnapshotUrl(viewpoint);
  const [updating, setUpdating] = useState(false);

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
    <div className="overflow-hidden rounded-md border" data-viewpoint={viewpoint.guid}>
      {snapshotUrl ? (
        // A plain <img>: this is a blob: URL for the user's own snapshot, and
        // next/image would route it through the server optimiser — which is
        // precisely what must never happen to a payload (AGENTS.md §1).
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={snapshotUrl}
          alt={t("snapshotFor", { title: topic.title })}
          className="bg-muted aspect-video w-full object-cover"
        />
      ) : (
        <div className="bg-muted text-muted-foreground flex aspect-video w-full items-center justify-center text-xs">
          {t("noSnapshot")}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 p-2">
        <p className="text-muted-foreground min-w-0 flex-1 truncate text-[11px]">
          {describeViewpoint(viewpoint)}
        </p>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => openViewpoint(topic, viewpoint)}
            disabled={openingGuid === viewpoint.guid}
          >
            <Eye className="h-3.5 w-3.5" />
            {t("openViewpoint")}
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
    </div>
  );
}

export default ViewpointCard;
