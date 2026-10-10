"use client";

import { useEffect, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, CheckCircle2, FileCheck2, Play, Square, Upload } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IDS_FILE_EXTENSIONS } from "@/config";
import { serializeIds } from "@/lib/ids/serialize";
import { useIdsStore } from "@/lib/ids/store";
import { useValidateStore } from "@/lib/ids/validate-store";
import { useViewerStore } from "@/lib/viewer/store";
import { cn } from "@/lib/utils";

import ExportBar from "@/app/(home)/ids/validate/_components/ExportBar";
import FailureTable from "@/app/(home)/ids/validate/_components/FailureTable";

/**
 * IDS validation, in the viewer.
 *
 * It lives here rather than on its own page because the two halves of the job
 * are the specification and the model, and the useful action on a failure is
 * "show me that element" — which needs the viewport that was one navigation
 * away before.
 *
 * The panel is narrow, so it carries the parts that drive work: what is being
 * validated, the verdict, and the failures with their jump into the 3D view.
 * The charts are a reporting view and live in the exported HTML report, where
 * there is room for them.
 */
export function IdsPanel() {
  const t = useTranslations("viewer.idsPanel");
  const idsTitle = useValidateStore((s) => s.idsTitle);
  const source = useValidateStore((s) => s.source);
  const status = useValidateStore((s) => s.status);
  const progress = useValidateStore((s) => s.progress);
  const error = useValidateStore((s) => s.error);
  const run = useValidateStore((s) => s.run);
  const setIds = useValidateStore((s) => s.setIds);
  const validate = useValidateStore((s) => s.validate);
  const cancel = useValidateStore((s) => s.cancel);
  const focused = useValidateStore((s) => s.focusedSpecification);
  const focusSpecification = useValidateStore((s) => s.focusSpecification);

  const authored = useIdsStore((s) => s.document);
  const models = useViewerStore((s) => s.models);
  const fileInput = useRef<HTMLInputElement>(null);

  // Derived, not synced: filtering inside a zustand selector returns a new
  // array on every read and never settles.
  const ready = useMemo(
    () => models.filter((model) => model.load.status === "ready").length,
    [models],
  );

  // A run describes the models that were loaded when it happened. Opening or
  // closing one makes it stale, and showing stale results next to a changed
  // federation is worse than showing none.
  const modelKey = models.map((model) => model.summary.id).join(",");
  const lastKey = useRef(modelKey);
  useEffect(() => {
    if (lastKey.current === modelKey) return;
    lastKey.current = modelKey;
    if (useValidateStore.getState().run) useValidateStore.getState().reset();
  }, [modelKey]);

  const onImport = async (file: File) => {
    try {
      setIds(await file.text(), file.name.replace(/\.(ids|xml)$/i, ""), "file");
      toast.success(t("loaded", { name: file.name }));
    } catch {
      toast.error(t("readFailed"));
    }
  };

  const useAuthored = () => {
    if (authored.specifications.length === 0) {
      toast.warning(t("noSpecifications"));
      return;
    }
    setIds(
      serializeIds(authored, { generator: "DiCE-IFC" }),
      authored.info.title || t("untitledSpecification"),
      "editor",
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 border-b p-2">
        <div className="flex flex-row justify-between gap-1.5">
          <h2 className="flex-1 text-sm">{t("title")}</h2>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                aria-label={t("loadIds")}
                onClick={() => fileInput.current?.click()}
              >
                <Upload className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("loadIds")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={useAuthored}
            title={t("useDraftTitle")}
          >
            <FileCheck2 className="h-3.5 w-3.5" />
          </Button>
          </TooltipTrigger>
            <TooltipContent>{t("draft")}</TooltipContent>
          </Tooltip>
          {status === "running" ? (
            <Tooltip>
            <TooltipTrigger asChild>
          <Button

            size="sm"
            variant="destructive"
            className="h-7 px-2 text-xs"
            aria-label={t("stop")}
            onClick={cancel}
          >
            <Square className="h-3.5 w-3.5" />
          </Button>
          </TooltipTrigger>
            <TooltipContent>{t("stop")}</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
          <Button
          variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            aria-label={t("validate")}
            onClick={validate}
            disabled={!idsTitle || ready === 0}
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
          </TooltipTrigger>
            <TooltipContent>{t("validate")}</TooltipContent>
          </Tooltip>
        )}
        </div>

        <p className="text-xs">
          <span className="font-medium">{idsTitle || t("noSpecificationLoaded")}</span>
          {source === "editor" && (
            <span className="text-muted-foreground"> · {t("fromEditor")}</span>
          )}
        </p>



        {ready === 0 && (
          <p className="text-muted-foreground text-[11px]">
            {t("loadModelToValidate")}
          </p>
        )}
      </div>

      {status === "running" && progress && (
        <div className="space-y-1.5 border-b p-2">
          <p className="truncate text-[11px] font-medium">{progress.modelName}</p>
          <Progress value={progress.percent} className="h-1" />
          <p className="text-muted-foreground text-[11px]">
            {t("modelProgress", { index: progress.modelIndex + 1, total: progress.totalModels })}
            {progress.totalSpecifications > 0 &&
              ` · ${t("specificationProgress", {
                index: progress.specificationIndex + 1,
                total: progress.totalSpecifications,
              })}`}
          </p>
        </div>
      )}

      {status === "failed" && error && (
        <p
          className="border-destructive/40 bg-destructive/10 text-destructive m-2 rounded-md border p-2 text-[11px]"
          role="alert"
        >
          {error}
        </p>
      )}

      {run ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="space-y-2 border-b p-2 max-h-[50%] overflow-auto">
            <div
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium",
                run.summary.failed === 0
                  ? "border-emerald-600/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  : "border-destructive/40 bg-destructive/10 text-destructive",
              )}
              role="status"
            >
              {run.summary.failed === 0 ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
              )}
              {run.summary.failed === 0
                ? t("allSatisfied")
                : t("someNotSatisfied", {
                    failed: run.summary.failed,
                    total: run.summary.totalSpecifications,
                  })}
            </div>

            <ul className="space-y-0.5">
              {run.specifications.map((specification) => {
                const open = focused === specification.index;
                return (
                  <li key={specification.index}>
                    <button
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px]",
                        open && "bg-accent",
                        specification.failures.length === 0 && "cursor-default",
                      )}
                      aria-pressed={open}
                      onClick={() =>
                        specification.failures.length > 0 &&
                        focusSpecification(open ? null : specification.index)
                      }
                    >
                      <StatusDot status={specification.status} />
                      <span className="min-w-0 flex-1 truncate">
                        {specification.name}
                      </span>
                      {specification.failedCount > 0 && (
                        <Badge
                          variant="destructive"
                          className="h-4 shrink-0 px-1 text-[10px]"
                        >
                          {specification.failedCount}
                        </Badge>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="min-h-0 flex-1 p-2">
            <FailureTable run={run} />
          </div>

          <div className="border-t p-2">
            <ExportBar run={run} />
          </div>
        </div>
      ) : (
        status !== "running" && (
          <p className="text-muted-foreground p-3 text-xs">
            {t.rich("emptyHint", { code: (chunks) => <code>{chunks}</code> })}
          </p>
        )
      )}

      <input
        ref={fileInput}
        type="file"
        accept={IDS_FILE_EXTENSIONS.join(",")}
        className="hidden"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) await onImport(file);
        }}
      />
    </div>
  );
}

function StatusDot({ status }: { status: "pass" | "fail" | "not_applicable" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        status === "pass" && "bg-emerald-500",
        status === "fail" && "bg-destructive",
        status === "not_applicable" && "bg-muted-foreground/50",
      )}
    />
  );
}

export default IdsPanel;
