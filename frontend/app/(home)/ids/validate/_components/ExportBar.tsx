"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Download, FileCode2, Printer } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DEFAULT_MAX_SNAPSHOTS,
  reportToBcf,
  type BcfExportGrouping,
} from "@/lib/ids/bcf-export";
import { renderHtmlReport, reportFileName } from "@/lib/ids/html-report";
import type { ValidationRun } from "@/lib/ids/report";
import { useBcfStore } from "@/lib/bcf/store";
import { bcfFileName, serializeBcf } from "@/lib/bcf/serialize";

/**
 * The two deliverables: a report a human reads, and an issue set a tool opens.
 */
export function ExportBar({ run }: { run: ValidationRun }) {
  const t = useTranslations("viewer.idsPanel.exportBar");
  const tReport = useTranslations("idsReport");
  const tFailure = useTranslations("idsFailureDescription");
  const locale = useLocale();
  const author = useBcfStore((s) => s.author);
  const setBcfFile = useBcfStore((s) => s.setFile);

  const [grouping, setGrouping] = useState<BcfExportGrouping>("per-failure");
  const [snapshots, setSnapshots] = useState(false);
  const [busy, setBusy] = useState(false);

  const onHtml = () => {
    const html = renderHtmlReport(run, tReport, tFailure, locale);
    download(
      new Blob([html], { type: "text/html;charset=utf-8" }),
      reportFileName(run),
    );
    toast.success(t("reportDownloaded"));
  };

  const onPrint = () => {
    // A new window with the same self-contained HTML, then the browser's own
    // print dialogue. See lib/ids/html-report.ts for why this beats bundling a
    // PDF renderer for a document that is mostly tables.
    const win = window.open("", "_blank");
    if (!win) {
      toast.error(t("allowPopups"));
      return;
    }
    win.document.write(renderHtmlReport(run, tReport, tFailure, locale));
    win.document.close();
    win.addEventListener("load", () => win.print());
  };

  const onBcf = async () => {
    setBusy(true);
    try {
      const file = await reportToBcf(run, {
        grouping,
        author,
        captureSnapshots: snapshots,
        onProgress: (done, total) => {
          if (snapshots && done % 25 === 0) {
            toast.info(t("capturingViewpoints", { done, total }), { id: "bcf-progress" });
          }
        },
        onSnapshotBudgetExceeded: () => {
          toast.warning(
            t("snapshotBudgetExceeded", { max: DEFAULT_MAX_SNAPSHOTS }),
            { duration: 10_000 },
          );
        },
      });

      const { bytes, notes } = serializeBcf(file);
      download(
        new Blob([bytes as BlobPart], { type: "application/octet-stream" }),
        bcfFileName(file),
      );

      // Hand it to the BCF module too, so it can be triaged without a round
      // trip through the filesystem.
      setBcfFile(file);

      toast.success(t("exportedBcf", { count: file.topics.length }));
      for (const note of notes.slice(0, 3)) toast.warning(note.message);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("bcfExportFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" size="sm" onClick={onHtml}>
        <FileCode2 className="h-4 w-4" />
        {t("htmlReport")}
      </Button>

      <Button variant="ghost" size="sm" onClick={onPrint}>
        <Printer className="h-4 w-4" />
        {t("printPdf")}
      </Button>

      <Popover>
        <PopoverTrigger asChild>
          <Button size="sm" disabled={busy || run.summary.failingEntities === 0}>
            <Download className="h-4 w-4" />
            {busy ? t("exporting") : t("exportBcf")}
          </Button>
        </PopoverTrigger>

        <PopoverContent align="end" className="w-80 space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">{t("oneTopicPer")}</Label>
            <Select
              value={grouping}
              onValueChange={(value) => setGrouping(value as BcfExportGrouping)}
            >
              <SelectTrigger className="h-8 text-xs" aria-label={t("topicGrouping")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="per-failure">{t("failingElement")}</SelectItem>
                <SelectItem value="per-specification">{t("specification")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-[11px]">
              {grouping === "per-failure"
                ? t("elementLevelTopics", { count: run.summary.failingEntities })
                : t("summaryTopics", { count: run.summary.failed })}
            </p>
          </div>

          <div className="flex items-start gap-2">
            <Checkbox
              id="bcf-snapshots"
              checked={snapshots}
              onCheckedChange={(value) => setSnapshots(value === true)}
            />
            <div className="space-y-0.5">
              <Label htmlFor="bcf-snapshots" className="text-xs font-medium">
                {t("captureSnapshot")}
              </Label>
              <p className="text-muted-foreground text-[11px]">
                {t("captureSnapshotHint", { max: DEFAULT_MAX_SNAPSHOTS })}
              </p>
            </div>
          </div>

          <Button size="sm" className="w-full" onClick={onBcf} disabled={busy}>
            {t("export")}
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export default ExportBar;
