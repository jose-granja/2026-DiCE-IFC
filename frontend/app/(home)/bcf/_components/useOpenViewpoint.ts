"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { restoreViewpoint } from "@/lib/bcf/actions";
import type { BcfTopic, BcfViewpoint } from "@/lib/bcf/types";

/** Restore a BCF viewpoint with one consistent set of user-facing outcomes. */
export function useOpenViewpoint() {
  const t = useTranslations("bcf.viewpointCard");
  const [openingGuid, setOpeningGuid] = useState<string | null>(null);

  const openViewpoint = useCallback(
    async (topic: BcfTopic, viewpoint: BcfViewpoint) => {
      setOpeningGuid(viewpoint.guid);
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

        if (caveats.length > 0) {
          toast.warning(
            t("viewpointRestoredWithCaveats", {
              caveats: caveats.join("; "),
            }),
          );
        } else {
          toast.success(t("viewpointRestored"));
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("couldNotOpen"));
      } finally {
        setOpeningGuid(null);
      }
    },
    [t],
  );

  return { openViewpoint, openingGuid };
}

