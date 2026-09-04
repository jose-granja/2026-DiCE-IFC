"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Eye, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { restoreViewpoint } from "@/lib/bcf/actions";
import { useBcfStore } from "@/lib/bcf/store";
import { describeViewpoint } from "@/lib/bcf/viewpoint";
import type { BcfTopic, BcfViewpoint } from "@/lib/bcf/types";
import { useSnapshotUrl } from "@/lib/bcf/use-snapshot-url";

/**
 * One viewpoint: its snapshot, what it will do, and the button that does it.
 *
 * "Open viewpoint" is the reason this module and the viewer share one store.
 */
export function ViewpointCard({
  topic,
  viewpoint,
}: {
  topic: BcfTopic;
  viewpoint: BcfViewpoint;
}) {
  const t = useTranslations("bcf.viewpointCard");
  const removeViewpoint = useBcfStore((s) => s.removeViewpoint);
  const [opening, setOpening] = useState(false);
  const snapshotUrl = useSnapshotUrl(viewpoint);

  const onOpen = async () => {
    setOpening(true);
    try {
      const outcome = await restoreViewpoint(
        viewpoint,
        topic.headerFiles[0]?.filename,
      );

      if (!outcome.applied) {
        toast.warning(t("loadModelFirst"));
        return;
      }

      const caveats: string[] = [];
      if (outcome.missing > 0) {
        caveats.push(t("missingElements", { count: outcome.missing }));
      }
      if (outcome.skippedPlanes > 0) {
        caveats.push(t("skippedPlanes", { count: outcome.skippedPlanes }));
      }

      if (caveats.length > 0) toast.warning(t("viewpointRestoredWithCaveats", { caveats: caveats.join("; ") }));
      else toast.success(t("viewpointRestored"));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("couldNotOpen"),
      );
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-md border">
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
          <Button size="sm" className="h-7 px-2 text-xs" onClick={onOpen} disabled={opening}>
            <Eye className="h-3.5 w-3.5" />
            {t("openViewpoint")}
          </Button>
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
