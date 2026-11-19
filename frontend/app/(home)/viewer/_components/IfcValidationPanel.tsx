"use client";

/**
 * IFC validation, as buildingSMART's validation service does it, on this device
 * (ADR 018, `lib/validation/`). One model at a time: its stages in the service's
 * order, each stage's findings grouped by rule, every instance a click away.
 */

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertTriangle, CheckCircle2, ChevronRight, CircleSlash, Download, ExternalLink, FileText, Loader2, MessagesSquare, Play, Square, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { VALIDATION_STAGES, type StageResult, type ValidatorBuild } from "@/lib/validation/stages";
import { describeValue, findingGroups, type FindingGroup } from "@/lib/validation/findings";
import { docLabel, groupExplanation, groupTitle, outcomeNote, outcomeTechnical } from "@/lib/validation/explain";
import { useIfcValidationStore, type ValidationRun } from "@/lib/validation/store";
import { DEFAULT_MAX_VALIDATION_SNAPSHOTS, validationToBcf, type ValidationBcfGrouping } from "@/lib/validation/bcf-export";
import { buildValidationReport, validationReportFileName } from "@/lib/validation/pdf-report";
import { bcfFileName, serializeBcf } from "@/lib/bcf/serialize";
import { useBcfStore } from "@/lib/bcf/store";
import { getActiveRenderer } from "@/lib/viewer/active-renderer";
import { useViewerStore } from "@/lib/viewer/store";
import { validatorBuild } from "@/lib/workers/ifc-validation-client";
import { cn } from "@/lib/utils";
import { PanelHeader } from "./PanelHeader";

/** Rows shown per group before "show more": a rule can have thousands. */
const PAGE = 100;

export default function IfcValidationPanel() {
  const t = useTranslations("viewer.validation");
  const models = useViewerStore((s) => s.models);
  const { run, start, cancel, clear } = useIfcValidationStore();
  const [build, setBuild] = useState<ValidatorBuild | null | undefined>(undefined);
  const [chosen, setChosen] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    void validatorBuild().then((found) => alive && setBuild(found));
    return () => {
      alive = false;
    };
  }, []);

  const ready = models.filter((m) => m.load.status === "ready");
  const modelId = chosen && ready.some((m) => m.summary.id === chosen) ? chosen : ready[0]?.summary.id ?? null;
  const running = !!run && !run.finishedAt;

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  // A result describes a model that is open; when it goes, so does the result.
  useEffect(() => {
    if (run && !models.some((m) => m.summary.id === run.modelId)) clear();
  }, [models, run, clear]);

  const elapsed = run ? Math.round(((run.finishedAt ?? now) - run.startedAt) / 1000) : 0;

  const exportJson = () => {
    if (!run) return;
    const blob = new Blob([JSON.stringify({ model: run.modelName, validated: new Date(run.startedAt).toISOString(), service: build?.service,
      stages: VALIDATION_STAGES.map((s) => run.results[s]).filter(Boolean) }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${run.modelName.replace(/\.[^.]+$/, "")}-validation.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-ifc-validation>
      <PanelHeader tab="validation" busy={running}>
        {run?.finishedAt && !run.cancelled && (
          <Button size="sm" variant="ghost" className="h-7" onClick={exportJson} aria-label={t("export")} title={t("export")}>
            <Download className="h-3.5 w-3.5" />
          </Button>
        )}
      </PanelHeader>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2 text-xs">
        <p className="text-muted-foreground leading-snug">{t("intro")}</p>
        {build === null ? (
          <p className="rounded border border-dashed p-2" data-ifc-validation-unavailable>{t("unavailable")}</p>
        ) : ready.length === 0 ? (
          <p className="text-muted-foreground rounded border border-dashed p-2">{t("noModel")}</p>
        ) : (
          <div className="space-y-2">
            {ready.length > 1 && (
              <Select value={modelId ?? undefined} onValueChange={setChosen} disabled={running}>
                <SelectTrigger aria-label={t("model")} className="h-7 w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ready.map((m) => <SelectItem key={m.summary.id} value={m.summary.id}>{m.summary.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            <div className="flex items-center gap-2">
              {running ? (
                <Button size="sm" variant="outline" className="h-7" onClick={cancel}>
                  <Square className="h-3.5 w-3.5" />
                  {t("cancel")}
                </Button>
              ) : (
                <Button size="sm" className="h-7" disabled={!modelId || build === undefined}
                  onClick={() => {
                    const model = ready.find((m) => m.summary.id === modelId);
                    if (model) void start(model.summary.id, model.summary.name);
                  }}>
                  <Play className="h-3.5 w-3.5" />
                  {t("run")}
                </Button>
              )}
              {build && <span className="text-muted-foreground">{t("download", { mb: Math.round(build.bytes / 1e6) })}</span>}
            </div>
          </div>
        )}

        {run && (
          <div className="space-y-2" data-ifc-validation-run data-status={running ? "running" : run.error ? "error" : run.cancelled ? "cancelled" : "done"}>
            <p className="font-medium">
              {run.modelName}
              <span className="text-muted-foreground font-normal"> · {t("elapsed", { seconds: elapsed })}</span>
            </p>
            {running && (
              <p className="text-muted-foreground flex items-center gap-1.5" data-ifc-validation-progress>
                <Loader2 className="h-3 w-3 animate-spin" />
                {run.loading
                  ? (t as unknown as (key: string, values: Record<string, number>) => string)(`loading.${run.loading.step}`, { done: run.loading.done, total: run.loading.total })
                  : run.current
                    ? t("running", { stage: t(`stages.${run.current}` as never) })
                    : t("starting")}
              </p>
            )}
            {run.finishedAt && !run.cancelled && !run.error && <ExportSection run={run} build={build ?? null} />}
            {run.error && <p className="text-destructive">{t("error", { error: run.error })}</p>}
            {run.cancelled && <p className="text-muted-foreground">{t("cancelled")}</p>}
            <ul className="space-y-1.5">
              {VALIDATION_STAGES.map((stage) => {
                const result = run.results[stage];
                if (!result) {
                  return running ? (
                    <li key={stage} className="text-muted-foreground flex items-center gap-1.5 rounded border px-2 py-1.5">
                      {run.current === stage ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <span className="h-3.5 w-3.5" />}
                      {t(`stages.${stage}` as never)}
                    </li>
                  ) : null;
                }
                return <StageCard key={stage} result={result} modelId={run.modelId} />;
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: StageResult["status"] }) {
  if (status === "valid") return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden />;
  if (status === "warning") return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />;
  if (status === "skipped") return <CircleSlash className="text-muted-foreground h-3.5 w-3.5 shrink-0" aria-hidden />;
  return <XCircle className="text-destructive h-3.5 w-3.5 shrink-0" aria-hidden />;
}

function StageCard({ result, modelId }: { result: StageResult; modelId: string }) {
  const t = useTranslations("viewer.validation");
  const groups = useMemo(() => findingGroups({ [result.stage]: result }), [result]);
  const count = groups.reduce((n, g) => n + g.outcomes.length, 0);
  const crashed = result.info.crashed ?? [];
  const open = groups.length > 0 || crashed.length > 0 || result.status === "failed" || result.status === "skipped";
  return (
    <li data-ifc-validation-stage={result.stage} data-status={result.status} data-count={count}>
      <Collapsible defaultOpen={false} className="rounded border">
        <CollapsibleTrigger className="hover:bg-muted/50 group flex w-full items-center gap-1.5 px-2 py-1.5 text-left" disabled={!open}>
          <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90", !open && "invisible")} />
          <StatusIcon status={result.status} />
          <span className="flex-1 font-medium">{t(`stages.${result.stage}` as never)}</span>
          {count > 0 && <Badge variant={result.status === "invalid" ? "destructive" : "secondary"} className="h-4 px-1 text-[10px]">{count}</Badge>}
          <span className="text-muted-foreground tabular-nums">{t(`status.${result.status}` as never)}</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-1.5 border-t p-1.5">
          {result.status === "skipped" && <p className="text-muted-foreground">{t("skippedBecause", { stage: t(`stages.${result.info.reason}` as never) })}</p>}
          {result.status === "failed" && <p className="text-destructive whitespace-pre-wrap">{t("stageFailed", { reason: result.info.reason ?? "" })}</p>}
          {crashed.map((c) => (
            <p key={c.rule} className="text-muted-foreground" data-ifc-validation-crashed={c.rule}>
              {t("ruleCrashed", { rule: c.rule, error: c.error })}
            </p>
          ))}
          {groups.map((group) => <OutcomeGroup key={group.key} group={group} modelId={modelId} />)}
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function OutcomeGroup({ group, modelId }: { group: FindingGroup; modelId: string }) {
  const t = useTranslations("viewer.validation");
  const tExplain = useTranslations("validationExplain");
  const explain = (key: string, values?: Record<string, string | number>) => tExplain(key as never, values as never);
  const [shown, setShown] = useState(PAGE);
  const explanation = groupExplanation(group, explain);
  // A rule's title already says what it is about; the code is kept beside it.
  const title = groupTitle(group, explain);
  return (
    <Collapsible className="rounded border" data-ifc-validation-rule={group.label} data-kind={group.kind}>
      <CollapsibleTrigger className="hover:bg-muted/50 group flex w-full items-start gap-1.5 px-1.5 py-1 text-left">
        <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        {group.severity === "ERROR" ? <XCircle className="text-destructive mt-0.5 h-3 w-3 shrink-0" /> : <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />}
        <span className="min-w-0 flex-1">
          <span className="font-medium">{title}</span>
          {(group.kind !== "header" || group.outcomes.length > 1) && (
            <span className="text-muted-foreground"> · {t("occurrences", { count: group.outcomes.length })}</span>
          )}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t">
        {(explanation || group.doc) && (
          <div className="bg-muted/30 space-y-1 border-b px-1.5 py-1.5 leading-snug" data-ifc-validation-explanation>
            {explanation && <p className="whitespace-pre-line">{explanation}</p>}
            {group.doc && (
              <a href={group.doc} target="_blank" rel="noopener noreferrer" className="text-primary inline-flex items-center gap-1 hover:underline">
                <ExternalLink className="h-3 w-3" />
                {docLabel(group, explain)}
              </a>
            )}
          </div>
        )}
        <ul className="divide-y">
          {group.outcomes.slice(0, shown).map((o, i) => {
            const note = outcomeNote(o, group, explain);
            // A schema message as IfcOpenShell prints it: the instance, the rule and its evaluation.
            const technical = group.kind === "schema" ? [outcomeTechnical(o), describeValue(o.observed, 4000)].filter(Boolean).join("\n\n") : null;
            return (
              <li key={i} className="space-y-0.5 px-1.5 py-1">
                {(o.inst || o.entity) && (
                  <div className="flex items-center gap-1.5">
                    {o.inst ? (
                      <button type="button" className="text-primary font-mono hover:underline" onClick={() => showInstance(modelId, o.inst!, t("notFound"))} title={t("show")}>
                        #{o.inst}
                      </button>
                    ) : null}
                    {o.entity && <span className="text-muted-foreground">{o.entity}</span>}
                  </div>
                )}
                {note ? (
                  <p className="break-words" data-ifc-validation-note>{note}</p>
                ) : group.kind !== "schema" && (
                  <>
                    {o.expected != null && <p className="break-words"><span className="text-muted-foreground">{t("expected")}</span> {describeValue(o.expected, 600)}</p>}
                    {o.observed != null && <p className="break-words"><span className="text-muted-foreground">{t("observed")}</span> {describeValue(o.observed, 600)}</p>}
                  </>
                )}
                {technical && (
                  <details className="text-muted-foreground">
                    <summary className="cursor-pointer select-none">{explain("technical")}</summary>
                    <pre className="mt-1 overflow-x-auto whitespace-pre text-[10px] leading-tight">{technical}</pre>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
        {group.outcomes.length > shown && (
          <Button size="sm" variant="ghost" className="h-6 w-full text-[11px]" onClick={() => setShown(shown + PAGE)}>
            {t("showMore", { count: group.outcomes.length - shown })}
          </Button>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Isolate, select, colour and frame one instance, as the IDS results do. */
function showInstance(modelId: string, expressId: number, notFound: string) {
  const store = useViewerStore.getState();
  if (!store.models.some((m) => m.summary.id === modelId)) {
    toast.warning(notFound);
    return;
  }
  const ref = { modelId, expressId };
  store.isolate([ref]);
  store.select([ref]);
  store.setColouring([{ ref, colour: "#d24b4b" }]);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const renderer = getActiveRenderer();
      const bounds = renderer?.boundsOfRefs([ref]);
      if (renderer && bounds) renderer.fitToBounds(bounds);
    }),
  );
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The two deliverables, as for IDS and clashes: an issue set a BCF tool opens
 * (also handed to the BCF manager), and a PDF someone without one can read.
 */
function ExportSection({ run, build }: { run: ValidationRun; build: ValidatorBuild | null }) {
  const t = useTranslations("viewer.validation.export");
  const tBcf = useTranslations("validationExport");
  const tPdf = useTranslations("validationReport");
  const tExplain = useTranslations("validationExplain");
  const explain = (key: string, values?: Record<string, string | number>) => tExplain(key as never, values as never);
  const locale = useLocale();
  const author = useBcfStore((s) => s.author);
  const setBcfFile = useBcfStore((s) => s.setFile);
  const [grouping, setGrouping] = useState<ValidationBcfGrouping>("per-rule");
  const [snapshots, setSnapshots] = useState(false);
  const [busy, setBusy] = useState<"bcf" | "pdf" | null>(null);
  const findings = Object.values(run.results).reduce(
    (n, r) => n + (r?.outcomes.filter((o) => o.severity === "ERROR" || o.severity === "WARNING").length ?? 0), 0);

  const onBcf = async () => {
    setBusy("bcf");
    const progress = toast.loading(t("bcfPreparing"));
    try {
      const translate = (key: string, values?: Record<string, string | number>) => tBcf(key as never, values as never);
      const file = await validationToBcf(
        { modelId: run.modelId, modelName: run.modelName, validatedAt: new Date(run.startedAt), results: run.results },
        translate,
        {
          grouping, author, captureSnapshots: snapshots, explain,
          onProgress: (done, total) => {
            if (snapshots && done % 5 === 0) toast.loading(t("bcfProgress", { done, total }), { id: progress });
          },
          onSnapshotBudgetExceeded: () => toast.warning(t("bcfBudget", { max: DEFAULT_MAX_VALIDATION_SNAPSHOTS }), { duration: 10_000 }),
        },
      );
      const { bytes, notes } = serializeBcf(file);
      download(new Blob([bytes as BlobPart], { type: "application/octet-stream" }), bcfFileName(file));
      setBcfFile(file);
      toast.success(t("bcfDone", { count: file.topics.length }), { id: progress });
      for (const note of notes.slice(0, 3)) toast.warning(note.message);
    } catch (error) {
      toast.error(t("failed", { message: error instanceof Error ? error.message : String(error) }), { id: progress });
    } finally {
      setBusy(null);
    }
  };

  const onPdf = async () => {
    setBusy("pdf");
    const progress = toast.loading(t("pdfPreparing"));
    try {
      // The PDF engine and its fonts load only when a report is asked for.
      const [pdfMakeModule, fontsModule] = await Promise.all([import("pdfmake/build/pdfmake"), import("pdfmake/build/vfs_fonts")]);
      const pdfMake = pdfMakeModule.default;
      pdfMake.addVirtualFileSystem(fontsModule.default);
      const translate = (key: string, values?: Record<string, string | number>) => tPdf(key as never, values as never);
      const definition = buildValidationReport({
        modelName: run.modelName, validatedAt: new Date(run.startedAt),
        seconds: ((run.finishedAt ?? run.startedAt) - run.startedAt) / 1000,
        results: run.results, build, generatedAt: new Date(), locale, explain,
      }, translate);
      const name = validationReportFileName(run.modelName);
      await pdfMake.createPdf(definition).download(name);
      toast.success(t("pdfDone", { name }), { id: progress });
    } catch (error) {
      toast.error(t("failed", { message: error instanceof Error ? error.message : String(error) }), { id: progress });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-1.5 rounded-lg border p-2" data-ifc-validation-export>
      <h3 className="text-xs font-semibold">{t("title")}</h3>
      {findings > 0 && (
        <>
          <Select value={grouping} onValueChange={(v) => setGrouping(v as ValidationBcfGrouping)} disabled={!!busy}>
            <SelectTrigger aria-label={t("grouping")} className="h-7 w-full text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="per-rule">{t("perRule")}</SelectItem>
              <SelectItem value="per-occurrence">{t("perOccurrence", { count: findings })}</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-start gap-2">
            <Checkbox id="validation-snapshots" checked={snapshots} onCheckedChange={(v) => setSnapshots(v === true)} disabled={!!busy} />
            <div className="space-y-0.5">
              <Label htmlFor="validation-snapshots" className="cursor-pointer text-[11px] font-medium">{t("snapshots")}</Label>
              <p className="text-muted-foreground text-[10px] leading-snug">{t("snapshotsHint", { max: DEFAULT_MAX_VALIDATION_SNAPSHOTS })}</p>
            </div>
          </div>
        </>
      )}
      <div className="flex gap-1.5">
        {findings > 0 && (
          <Button size="sm" variant="secondary" className="h-7 flex-1" onClick={() => void onBcf()} disabled={!!busy}>
            {busy === "bcf" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessagesSquare className="h-3.5 w-3.5" />}
            {t("bcf")}
          </Button>
        )}
        <Button size="sm" variant="secondary" className="h-7 flex-1" onClick={() => void onPdf()} disabled={!!busy}>
          {busy === "pdf" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
          {t("pdf")}
        </Button>
      </div>
    </section>
  );
}
