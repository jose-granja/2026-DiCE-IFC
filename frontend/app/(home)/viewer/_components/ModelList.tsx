"use client";

import { useTranslations } from "next-intl";
import { AlertTriangle, Eye, EyeOff, MapPin, X } from "lucide-react";

import { unloadModel } from "@/lib/viewer/loader";
import { useViewerStore } from "@/lib/viewer/store";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import SignatureBadge from "@/components/SignatureBadge";

export function ModelList() {
  const t = useTranslations("viewer.modelList");
  const models = useViewerStore((s) => s.models);
  const placements = useViewerStore((s) => s.placements);
  const worldOrigin = useViewerStore((s) => s.worldOrigin);
  const setModelVisible = useViewerStore((s) => s.setModelVisible);

  const CONFIDENCE_LABEL = {
    exact: t("aligned"),
    approximate: t("approximate"),
    unaligned: t("notAligned"),
  } as const;

  if (models.length === 0) {
    return (
      <p className="text-muted-foreground p-3 text-xs">
        {t("noModelsLoaded")}
      </p>
    );
  }

  return (
    <div className="flex flex-col">
      {worldOrigin && (
        <p className="text-muted-foreground border-b px-3 py-2 text-xs">
          {worldOrigin.source === "mapConversion" ? (
            <>
              {t("originFromMapConversion")} <code>IfcMapConversion</code>
              {worldOrigin.crs ? ` (${worldOrigin.crs})` : ""}.
            </>
          ) : worldOrigin.source === "siteLocation" ? (
            <>{t("originFromSite")}</>
          ) : (
            <>{t("noGeoreferencing")}</>
          )}
        </p>
      )}

      <ul className="divide-y">
        {models.map((model) => {
          const placement = placements[model.summary.id];
          const isLoading =
            model.load.status === "parsing" || model.load.status === "geometry";

          return (
            <li key={model.summary.id} className="px-3 py-2.5">
              <div className="flex items-start gap-2">
                <span
                  aria-hidden
                  className="mt-1 h-3 w-3 shrink-0 rounded-sm"
                  style={{ backgroundColor: model.colour }}
                />

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={model.summary.name}>
                    {model.summary.name}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {model.summary.schemaToken ?? model.summary.schema} ·{" "}
                    {t("entityCount", { count: model.summary.entityCount })}
                  </p>

                  <SignatureBadge signature={model.signature} className="mt-1" />

                  {isLoading && (
                    <div className="mt-1.5">
                      <Progress
                        value={
                          model.load.status === "parsing"
                            ? model.load.percent
                            : undefined
                        }
                        className="h-1"
                      />
                      <p className="text-muted-foreground mt-1 text-[11px]">
                        {model.load.status === "parsing"
                          ? t("parsing", { phase: model.load.phase })
                          : t("buildingGeometry")}
                      </p>
                    </div>
                  )}

                  {model.load.status === "failed" && (
                    <p className="text-destructive mt-1 flex items-start gap-1 text-[11px]">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      {model.load.error}
                    </p>
                  )}

                  {placement && model.load.status === "ready" && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge
                          variant={
                            placement.confidence === "exact"
                              ? "secondary"
                              : "outline"
                          }
                          className={cn(
                            "mt-1.5 cursor-help gap-1 font-normal",
                            placement.confidence === "unaligned" &&
                              "border-warning/40 text-warning",
                          )}
                        >
                          <MapPin className="h-3 w-3" />
                          {CONFIDENCE_LABEL[placement.confidence]}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-72">
                        {placement.reason}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>

                <div className="flex shrink-0 items-center">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={
                      model.visible
                        ? t("hideModel", { name: model.summary.name })
                        : t("showModel", { name: model.summary.name })
                    }
                    aria-pressed={!model.visible}
                    onClick={() =>
                      setModelVisible(model.summary.id, !model.visible)
                    }
                  >
                    {model.visible ? (
                      <Eye className="h-4 w-4" />
                    ) : (
                      <EyeOff className="text-muted-foreground h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("closeModel", { name: model.summary.name })}
                    onClick={() => unloadModel(model.summary.id)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default ModelList;
