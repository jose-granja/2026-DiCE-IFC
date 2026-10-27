"use client";

import { useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Crosshair,
  Download,
  Eye,
  LayoutTemplate,
  ListChecks,
  Loader2,
  Maximize2,
  Play,
  Plus,
  Square,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { bcfFileName, serializeBcf } from "@/lib/bcf/serialize";
import { useBcfStore } from "@/lib/bcf/store";
import { DEFAULT_MAX_CLASH_SNAPSHOTS, clashesToBcf } from "@/lib/clash/bcf-export";
import { CLASH_COLOUR_A, CLASH_COLOUR_B } from "@/lib/clash/colours";
import { showClash } from "@/lib/clash/highlight";
import { findRule, modelDiscipline } from "@/lib/clash/matrix";
import { useClashStore } from "@/lib/clash/store";
import { buildTemplate } from "@/lib/clash/templates";
import type { ClashGroup, ClashKind, ClashResultItem, ClashTolerance } from "@/lib/clash/types";
import type { ElementFilter } from "@/lib/ifc/types";
import { createClashWorkbook, readClashWorkbook } from "@/lib/clash/workbook";
import { isEmptyElementFilter } from "@/lib/ifc/element-filter";
import { useViewerStore } from "@/lib/viewer/store";
import { useModelVocabulary } from "@/lib/viewer/use-model-vocabulary";
import { cn } from "@/lib/utils";
import ElementFilterEditor from "./ElementFilterEditor";
import { PanelHeader } from "./PanelHeader";

const KIND_TONE: Record<ClashKind, string> = {
  hard: "border-destructive/40 text-destructive",
  clearance: "border-warning/40 text-warning",
  inside: "border-primary/40 text-primary",
  duplicate: "border-muted-foreground/40 text-muted-foreground",
};

/** Millimetres in the fields, metres in the matrix. */
const toMm = (metres: number) => Math.round(metres * 1000 * 100) / 100;
const fromMm = (mm: number) => mm / 1000;

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * The built-in starting matrix, as two actions: use it, or take it as a workbook.
 *
 * Using it replaces the matrix on screen, so when there was one the toast offers
 * to put it back — loading a template should never be the click that costs
 * someone an afternoon of group definitions.
 */
function useResidentialTemplate() {
  const t = useTranslations("viewer.clash");
  const templateT = useTranslations("viewer.clash.template");
  const setMatrix = useClashStore((s) => s.setMatrix);

  const label = (key: string) => templateT(key as never);

  const use = () => {
    const previous = useClashStore.getState().matrix;
    const template = buildTemplate("residential", label);
    // The classification is about the models open, not the matrix: keep it.
    setMatrix({ ...template, modelDisciplines: previous.modelDisciplines });
    toast.success(
      templateT("applied", { groups: template.groups.length, cells: template.rules.length }),
      previous.groups.length > 0
        ? { action: { label: t("undo"), onClick: () => setMatrix(previous) } }
        : undefined,
    );
  };

  const downloadWorkbook = () => {
    download(
      new Blob([createClashWorkbook(buildTemplate("residential", label)) as BlobPart], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      "clash-matrix-residential-template.xlsx",
    );
  };

  return { use, downloadWorkbook };
}

/** Shown where a matrix is missing: the way in for someone who has none. */
function TemplateOffer() {
  const t = useTranslations("viewer.clash.template");
  const { use, downloadWorkbook } = useResidentialTemplate();

  return (
    <div className="space-y-1.5 rounded border border-dashed p-2.5" data-clash-template-offer>
      <p className="text-xs font-medium">{t("title")}</p>
      <p className="text-muted-foreground text-[11px] leading-snug">{t("hint")}</p>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="secondary" className="h-7" onClick={use}>
          <LayoutTemplate className="h-3.5 w-3.5" />
          {t("use")}
        </Button>
        <Button size="sm" variant="ghost" className="h-7" onClick={downloadWorkbook}>
          <Download className="h-3.5 w-3.5" />
          {t("download")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Clash detection.
 *
 * Groups of elements are picked by filters; the matrix says which pairs of
 * groups are tested against each other and with what tolerance; the results
 * can be walked in the viewer and exported to BCF with an image per clash.
 */
export function ClashPanel() {
  const t = useTranslations("viewer.clash");
  const models = useViewerStore((state) => state.models);
  const ready = models.some((model) => model.load.status === "ready");

  const matrix = useClashStore((s) => s.matrix);
  const result = useClashStore((s) => s.result);
  const running = useClashStore((s) => s.running);
  const progress = useClashStore((s) => s.progress);
  const error = useClashStore((s) => s.error);
  const run = useClashStore((s) => s.run);
  const cancel = useClashStore((s) => s.cancel);
  const setMatrix = useClashStore((s) => s.setMatrix);
  const clearResult = useClashStore((s) => s.clearResult);

  const [tab, setTab] = useState("groups");
  // The groups and the matrix in a large window, where there is room for both.
  const [windowOpen, setWindowOpen] = useState(false);
  const [windowTab, setWindowTab] = useState<"groups" | "matrix">("groups");
  const template = useResidentialTemplate();
  const fileInput = useRef<HTMLInputElement>(null);

  const runMatrix = () => {
    void run().then(() => {
      if (useClashStore.getState().result) setTab("results");
    });
  };

  const importWorkbook = async (file: File) => {
    try {
      const read = readClashWorkbook(new Uint8Array(await file.arrayBuffer()));
      // A workbook without a Models sheet (a Solibri one, an older one of ours)
      // says nothing about the models open, so their classification is kept.
      const imported = Object.keys(read.modelDisciplines ?? {}).length > 0
        ? read
        : { ...read, modelDisciplines: useClashStore.getState().matrix.modelDisciplines };
      setMatrix(imported);
      toast.success(
        t("matrixImported", { groups: imported.groups.length, cells: imported.rules.length }),
      );
      setTab("matrix");
      setWindowTab("matrix");
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : t("importFailed"));
    }
  };

  const exportWorkbook = () => {
    download(
      new Blob([createClashWorkbook(matrix) as BlobPart], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      "clash-detection-matrix.xlsx",
    );
  };

  if (!ready) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PanelHeader tab="clash" />
        <p className="text-muted-foreground p-3 text-xs">{t("loadModel")}</p>
      </div>
    );
  }

  const percent =
    progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="flex h-full min-h-0 flex-col" data-clash-panel>
      <PanelHeader tab="clash">
          
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label={t("window.open")}
                onClick={() => setWindowOpen(true)}
                data-clash-window-open
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("window.open")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              {running ? (
          <Button size="sm" variant="secondary" className="h-7" onClick={cancel} aria-label={t("stop")}>
            <Square className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            size="sm"
            className="h-7"
            variant="ghost"
            onClick={runMatrix}
            disabled={matrix.rules.length === 0}
            aria-label={t("run")}
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
        )}
            </TooltipTrigger>
            <TooltipContent>{t(running ? "stop" : "run")}</TooltipContent>
          </Tooltip>
         
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label={t("importMatrix")}
                onClick={() => fileInput.current?.click()}
              >
                <Upload className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("importMatrix")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label={t("exportMatrix")}
                onClick={exportWorkbook}
              >
                <Download className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("exportMatrix")}</TooltipContent>
          </Tooltip>
          {result && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label={t("clearResults")}
                  onClick={clearResult}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("clearResults")}</TooltipContent>
            </Tooltip>
          )}
             <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label={t("template.use")}
                onClick={template.use}
                data-clash-template-use
              >
                <LayoutTemplate className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("template.use")}</TooltipContent>
          </Tooltip>
        <input
          ref={fileInput}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          data-clash-workbook-input
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void importWorkbook(file);
          }}
        />
      </PanelHeader>

      {running && progress && (
        <div className="border-b px-2 py-1.5" role="status">
          <div className="flex items-center gap-1.5 text-[11px]">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t(`progress.${progress.phase}`)}
            <span className="text-muted-foreground ml-auto tabular-nums">{percent}%</span>
          </div>
          <div className="bg-muted mt-1 h-1 overflow-hidden rounded">
            <div className="bg-primary h-full transition-[width]" style={{ width: `${percent}%` }} />
          </div>
        </div>
      )}
      {error && (
        <p className="text-destructive border-b px-2 py-1.5 text-xs" role="alert">
          {error}
        </p>
      )}

      {windowOpen ? (
        <p className="text-muted-foreground m-2 rounded-lg border p-4 text-center text-[11px]">
          {t("window.editingThere")}
        </p>
      ) : (
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-2 mt-2 grid grid-cols-3">
          <TabsTrigger value="groups" className="text-xs">
            {t("tabs.groups")} ({matrix.groups.length})
          </TabsTrigger>
          <TabsTrigger value="matrix" className="text-xs">
            {t("tabs.matrix")}
          </TabsTrigger>
          <TabsTrigger value="results" className="text-xs">
            {t("tabs.results")}
            {result ? ` (${result.items.length})` : ""}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="groups" className="min-h-0 flex-1 overflow-auto">
          <GroupsTab />
        </TabsContent>
        <TabsContent value="matrix" className="min-h-0 flex-1 overflow-auto">
          <MatrixTab />
        </TabsContent>
        <TabsContent value="results" className="min-h-0 flex-1 overflow-auto">
          <ResultsTab />
        </TabsContent>
      </Tabs>
      )}

      <Dialog open={windowOpen} onOpenChange={setWindowOpen}>
        <DialogContent
          className="flex h-[85vh] max-h-[95vh] w-full max-w-[calc(100%-2rem)] flex-col gap-3 p-4 sm:max-w-[calc(100%-2rem)]"
          data-clash-window
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5 text-base">
              <Crosshair className="h-4 w-4" aria-hidden />
              {t("window.title")}
            </DialogTitle>
            <DialogDescription>{t("window.hint")}</DialogDescription>
          </DialogHeader>

          <Tabs
            value={windowTab}
            onValueChange={(value) => setWindowTab(value as "groups" | "matrix")}
            className="flex min-h-0 flex-1 flex-col gap-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <TabsList className="grid w-64 grid-cols-2">
                <TabsTrigger value="groups" className="text-xs">
                  {t("tabs.groups")} ({matrix.groups.length})
                </TabsTrigger>
                <TabsTrigger value="matrix" className="text-xs">
                  {t("tabs.matrix")}
                </TabsTrigger>
              </TabsList>
              <div className="ml-auto flex flex-wrap gap-1.5">
                {running ? (
                  <Button size="sm" variant="secondary" className="h-8 text-xs" onClick={cancel}>
                    <Square className="h-3.5 w-3.5" />
                    {t("stop")}
                  </Button>
                ) : (
                  <Button size="sm" className="h-8 text-xs" onClick={runMatrix} disabled={matrix.rules.length === 0}>
                    <Play className="h-3.5 w-3.5" />
                    {t("run")}
                  </Button>
                )}
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={template.use}>
                  <LayoutTemplate className="h-3.5 w-3.5" />
                  {t("template.use")}
                </Button>
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => fileInput.current?.click()}>
                  <Upload className="h-3.5 w-3.5" />
                  {t("importMatrix")}
                </Button>
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={exportWorkbook}>
                  <Download className="h-3.5 w-3.5" />
                  {t("exportMatrix")}
                </Button>
              </div>
            </div>

            {running && progress && (
              <div role="status" className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t(`progress.${progress.phase}`)}
                  <span className="text-muted-foreground ml-auto tabular-nums">{percent}%</span>
                </div>
                <div className="bg-muted h-1 overflow-hidden rounded">
                  <div className="bg-primary h-full transition-[width]" style={{ width: `${percent}%` }} />
                </div>
              </div>
            )}
            {error && (
              <p className="text-destructive text-xs" role="alert">
                {error}
              </p>
            )}
            {/* The results act on the 3D view, so they are read in the panel beside it. */}
            {result && !running && (
              <div
                className="bg-muted/60 flex items-center gap-2 rounded-md px-2 py-1.5 text-xs"
                role="status"
                data-clash-window-results
              >
                <span className="min-w-0 flex-1">
                  {t("results.summary", {
                    count: result.items.length,
                    seconds: (result.durationMs / 1000).toFixed(1),
                  })}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => {
                    setTab("results");
                    setWindowOpen(false);
                  }}
                >
                  <ListChecks className="h-3.5 w-3.5" />
                  {t("window.showResults")}
                </Button>
              </div>
            )}

            <TabsContent value="groups" className="min-h-0 flex-1">
              <GroupsWindow />
            </TabsContent>
            <TabsContent value="matrix" className="min-h-0 flex-1 overflow-auto rounded-lg border">
              <MatrixTab wide />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The large window's groups: every group in a table, the selected one beside it
// ---------------------------------------------------------------------------

/** One datalist for every discipline field — models' and groups' — so the words match. */
const disciplineListId = "clash-discipline-options";

/** The disciplines to offer: the template's, then any a group or model already uses. */
function useDisciplineSuggestions(): string[] {
  const templateT = useTranslations("viewer.clash.template.disciplines");
  const groups = useClashStore((s) => s.matrix.groups);
  const modelDisciplines = useClashStore((s) => s.matrix.modelDisciplines);
  return useMemo(() => {
    const keys = ["architecture", "structure", "hvac", "plumbing", "electrical", "fire", "elv", "transport", "civil"];
    const out = new Map<string, string>();
    const add = (value: string | undefined) => {
      const text = (value ?? "").trim();
      if (text && !out.has(text.toLocaleLowerCase())) out.set(text.toLocaleLowerCase(), text);
    };
    keys.forEach((key) => add(templateT(key as never)));
    groups.forEach((group) => add(group.discipline));
    Object.values(modelDisciplines ?? {}).forEach(add);
    return [...out.values()];
  }, [templateT, groups, modelDisciplines]);
}

/**
 * Each open model's discipline. A group with a discipline then picks elements
 * only from models of that discipline — the architectural model's walls, not the
 * structural model's — and a model left blank is tested by every group, so
 * nothing changes until something is classified.
 */
function ModelDisciplines({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const t = useTranslations("viewer.clash.disciplines");
  const models = useViewerStore((s) => s.models);
  const groups = useClashStore((s) => s.matrix.groups);
  const modelDisciplines = useClashStore((s) => s.matrix.modelDisciplines);
  const setModelDiscipline = useClashStore((s) => s.setModelDiscipline);
  const suggestions = useDisciplineSuggestions();
  // Each name once: two loads of one file share a classification.
  const names = [...new Map(models.map((model) => [model.summary.name, model])).values()];
  const classified = names.filter((model) => (modelDisciplines?.[model.summary.name] ?? "").trim()).length;

  // Group disciplines no classified model has: those groups pick from unclassified models only.
  const modelKeys = new Set(
    names.map((model) => (modelDisciplines?.[model.summary.name] ?? "").trim().toLocaleLowerCase()).filter(Boolean),
  );
  const unmatched = classified === 0
    ? []
    : [...new Set(groups.map((group) => (group.discipline ?? "").trim()).filter(Boolean))].filter(
        (discipline) => !modelKeys.has(discipline.toLocaleLowerCase()),
      );

  return (
    <Collapsible defaultOpen={defaultOpen} className="rounded-lg border" data-clash-disciplines>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="hover:bg-muted/50 group flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs font-medium"
        >
          <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
          <span className="flex-1">{t("title")}</span>
          <span className="text-muted-foreground font-normal tabular-nums" data-clash-disciplines-summary>
            {t("summary", { classified, total: names.length })}
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 border-t p-2">
        <p className="text-muted-foreground text-[10px] leading-snug">{t("hint")}</p>
        {names.map((model) => (
          <div key={model.summary.name} className="flex items-center gap-2" data-clash-model={model.summary.name}>
            <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: model.colour }} />
            <span className="min-w-0 flex-1 truncate text-[11px]" title={model.summary.name}>
              {model.summary.name}
            </span>
            <Input
              list={disciplineListId}
              value={modelDisciplines?.[model.summary.name] ?? ""}
              onChange={(event) => setModelDiscipline(model.summary.name, event.target.value)}
              placeholder={t("unclassified")}
              aria-label={t("modelLabel", { name: model.summary.name })}
              className="h-7 w-36 shrink-0 text-xs"
            />
          </div>
        ))}
        {unmatched.length > 0 && (
          <p className="text-warning text-[10px] leading-snug" data-clash-disciplines-unmatched>
            {t("unmatched", { list: unmatched.join(", ") })}
          </p>
        )}
      </CollapsibleContent>
      <datalist id={disciplineListId}>
        {suggestions.map((value) => (
          <option key={value} value={value} />
        ))}
      </datalist>
    </Collapsible>
  );
}

function GroupsWindow() {
  const t = useTranslations("viewer.clash");
  const groups = useClashStore((s) => s.matrix.groups);
  const result = useClashStore((s) => s.result);
  const addGroup = useClashStore((s) => s.addGroup);
  const removeGroup = useClashStore((s) => s.removeGroup);
  const duplicateGroup = useClashStore((s) => s.duplicateGroup);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // The first group until one is picked, and again if the picked one goes.
  const selected = groups.find((group) => group.id === selectedId) ?? groups[0] ?? null;
  const term = search.trim().toLocaleLowerCase();
  const shown = term
    ? groups.filter((group) =>
        [group.name, group.discipline ?? "", group.note ?? ""].join(" ").toLocaleLowerCase().includes(term),
      )
    : groups;

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 md:grid-cols-[minmax(0,1.35fr)_minmax(22rem,1fr)]">
      <div className="flex min-h-0 flex-col gap-2 rounded-lg border p-2">
        <ModelDisciplines defaultOpen />
        <div className="flex items-center gap-2">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("window.search")}
            aria-label={t("window.search")}
            className="h-8 max-w-xs text-xs"
          />
          <span className="text-muted-foreground text-xs tabular-nums">
            {t("window.count", { shown: shown.length, total: groups.length })}
          </span>
          <Button
            size="sm"
            variant="secondary"
            className="ml-auto h-8 text-xs"
            onClick={() => setSelectedId(addGroup())}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("groups.add")}
          </Button>
        </div>
        {groups.length === 0 ? (
          <div className="space-y-2">
            <p className="text-muted-foreground text-xs">{t("groups.empty")}</p>
            <TemplateOffer />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto" role="list" aria-label={t("tabs.groups")} data-clash-window-groups>
            <div className="text-muted-foreground flex items-center gap-3 px-2 pb-1 text-[11px] font-medium" aria-hidden>
              <span className="w-48 shrink-0">{t("groups.name")}</span>
              <span className="w-28 shrink-0">{t("groups.discipline")}</span>
              <span className="flex-1">{t("window.selects")}</span>
              <span className="w-24 shrink-0 text-right">{t("window.elements")}</span>
              <span className="w-16 shrink-0" />
            </div>
            {shown.length === 0 && <p className="text-muted-foreground p-2 text-xs">{t("window.noMatch")}</p>}
            <div className="space-y-1">
              {shown.map((group) => {
                const count = result?.groupCounts[group.id];
                const current = group.id === selected?.id;
                return (
                  <div
                    key={group.id}
                    role="listitem"
                    aria-current={current ? "true" : undefined}
                    className={cn(
                      "flex items-center rounded-md border text-xs transition-colors",
                      current ? "border-primary bg-primary/10" : "hover:bg-muted/50",
                    )}
                    data-clash-window-group={group.name}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-3 px-2 py-1.5 text-left"
                      aria-label={t("window.select", { name: group.name })}
                      onClick={() => setSelectedId(group.id)}
                    >
                      <span className="w-48 shrink-0 font-medium break-words">{group.name || "—"}</span>
                      <span className="text-muted-foreground w-28 shrink-0 truncate">{group.discipline || "—"}</span>
                      <FilterSummary filter={group.filter} />
                      <span className="text-muted-foreground w-24 shrink-0 text-right tabular-nums">
                        {count === undefined ? "—" : t("groups.elements", { count })}
                      </span>
                    </button>
                    <div className="flex w-16 shrink-0 items-center justify-end border-l pr-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        aria-label={`${t("groups.duplicate")}: ${group.name}`}
                        title={t("groups.duplicate")}
                        onClick={() => duplicateGroup(group.id)}
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive h-6 w-6"
                        aria-label={`${t("groups.remove")}: ${group.name}`}
                        title={t("groups.remove")}
                        onClick={() => removeGroup(group.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <aside
        className="min-h-0 overflow-auto rounded-lg border p-3"
        aria-label={t("window.selected")}
        data-clash-window-editor
      >
        {selected ? (
          <GroupEditor key={selected.id} group={selected} />
        ) : (
          <p className="text-muted-foreground text-xs">{t("window.pick")}</p>
        )}
      </aside>
    </div>
  );
}

/** What a group's filter picks, in a line — enough to tell groups apart in a list. */
function FilterSummary({ filter }: { filter: ElementFilter }) {
  const t = useTranslations("viewer.clash");
  if (isEmptyElementFilter(filter)) {
    return <span className="text-warning min-w-0 flex-1 truncate">{t("window.nothing")}</span>;
  }
  const parts = [
    filter.classes.join(", "),
    ...filter.names.map((value) => `${t("filter.names")}: ${value}`),
    filter.predefinedTypes.length > 0 ? `${t("filter.predefinedTypes")}: ${filter.predefinedTypes.join(", ")}` : "",
    filter.objectTypes.length > 0 ? `${t("filter.objectTypes")}: ${filter.objectTypes.join(", ")}` : "",
    filter.materials.length > 0 ? `${t("filter.materials")}: ${filter.materials.join(", ")}` : "",
    filter.materialCategories.length > 0
      ? `${t("filter.materialCategories")}: ${filter.materialCategories.join(", ")}`
      : "",
    (filter.classificationCodes ?? []).length > 0
      ? `${filter.classificationSystem || t("filter.classificationCode")}: ${(filter.classificationCodes ?? []).join(", ")}`
      : filter.classificationSystem ?? "",
    filter.properties.length > 0 ? t("window.conditions", { count: filter.properties.length }) : "",
  ].filter(Boolean);
  const text = parts.join(" · ");
  return (
    <span className="text-muted-foreground min-w-0 flex-1 truncate" title={text}>
      {text}
    </span>
  );
}

/** The selected group, every field of it, in the window's side panel. */
function GroupEditor({ group }: { group: ClashGroup }) {
  const t = useTranslations("viewer.clash");
  const updateGroup = useClashStore((s) => s.updateGroup);
  const vocabulary = useModelVocabulary();
  const empty = isEmptyElementFilter(group.filter);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-2">
        <div className="space-y-1">
          <Label htmlFor="clash-window-name" className="text-[11px]">
            {t("groups.name")}
          </Label>
          <Input
            id="clash-window-name"
            value={group.name}
            onChange={(event) => updateGroup(group.id, { name: event.target.value })}
            className="h-8 text-xs font-medium"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="clash-window-discipline" className="text-[11px]">
            {t("groups.discipline")}
          </Label>
          <Input
            id="clash-window-discipline"
            list={disciplineListId}
            value={group.discipline ?? ""}
            onChange={(event) => updateGroup(group.id, { discipline: event.target.value || undefined })}
            className="h-8 text-xs"
          />
        </div>
      </div>
      {group.note && (
        <p className="bg-muted/50 rounded p-1.5 text-[11px] leading-snug" data-clash-group-note>
          {group.note}
        </p>
      )}
      <ElementFilterEditor
        filter={group.filter}
        vocabulary={vocabulary}
        onChange={(filter) => updateGroup(group.id, { filter })}
      />
      {empty && <p className="text-warning text-[11px]">{t("groups.noFilter")}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

function GroupsTab() {
  const t = useTranslations("viewer.clash");
  const groups = useClashStore((s) => s.matrix.groups);
  const result = useClashStore((s) => s.result);
  const addGroup = useClashStore((s) => s.addGroup);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="space-y-2 p-2">
      <ModelDisciplines />
      {groups.length === 0 && (
        <>
          <p className="text-muted-foreground text-xs">{t("groups.empty")}</p>
          <TemplateOffer />
        </>
      )}
      {groups.map((group) => (
        <GroupCard
          key={group.id}
          group={group}
          count={result?.groupCounts[group.id]}
          open={open === group.id}
          onToggle={() => setOpen(open === group.id ? null : group.id)}
        />
      ))}
      <Button
        variant="secondary"
        size="sm"
        className="w-full"
        onClick={() => setOpen(addGroup())}
      >
        <Plus className="h-3.5 w-3.5" />
        {t("groups.add")}
      </Button>
    </div>
  );
}

function GroupCard({
  group,
  count,
  open,
  onToggle,
}: {
  group: ClashGroup;
  count: number | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations("viewer.clash");
  const updateGroup = useClashStore((s) => s.updateGroup);
  const removeGroup = useClashStore((s) => s.removeGroup);
  const duplicateGroup = useClashStore((s) => s.duplicateGroup);
  const vocabulary = useModelVocabulary();
  const empty = isEmptyElementFilter(group.filter);

  return (
    <section className="rounded-lg border" data-clash-group>
      <div className="flex items-center gap-1 p-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label={group.name}
          aria-expanded={open}
          onClick={onToggle}
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </Button>
        <Input
          aria-label={t("groups.name")}
          value={group.name}
          onChange={(event) => updateGroup(group.id, { name: event.target.value })}
          className="h-7 min-w-0 flex-1 text-xs font-medium"
        />
        {count !== undefined && (
          <Badge variant="outline" className="shrink-0 text-[10px]">
            {t("groups.elements", { count })}
          </Badge>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label={t("groups.duplicate")}
          onClick={() => duplicateGroup(group.id)}
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label={t("groups.remove")}
          onClick={() => removeGroup(group.id)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {empty && !open && (
        <p className="text-warning px-2 pb-1.5 text-[10px]">{t("groups.noFilter")}</p>
      )}

      {group.note && !open && (
        <p
          className="text-muted-foreground px-2 pb-1.5 text-[10px] leading-snug"
          data-clash-group-note
        >
          {group.note}
        </p>
      )}

      {open && (
        <div className="space-y-2 border-t p-2">
          {group.note && (
            <p className="bg-muted/50 rounded p-1.5 text-[10px] leading-snug" data-clash-group-note>
              {group.note}
            </p>
          )}
          <div className="space-y-1">
            <Label htmlFor={`${group.id}-discipline`} className="text-[11px]">
              {t("groups.discipline")}
            </Label>
            <Input
              id={`${group.id}-discipline`}
              list={disciplineListId}
              value={group.discipline ?? ""}
              onChange={(event) =>
                updateGroup(group.id, { discipline: event.target.value || undefined })
              }
              className="h-8 text-xs"
            />
          </div>
          <ElementFilterEditor
            filter={group.filter}
            vocabulary={vocabulary}
            onChange={(filter) => updateGroup(group.id, { filter })}
          />
          {empty && <p className="text-warning text-[10px]">{t("groups.noFilter")}</p>}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

/** `wide`: the large window's layout — the grid beside its tolerances and settings, not above them. */
function MatrixTab({ wide = false }: { wide?: boolean }) {
  const t = useTranslations("viewer.clash");
  const matrix = useClashStore((s) => s.matrix);
  const setRule = useClashStore((s) => s.setRule);
  const addTolerance = useClashStore((s) => s.addTolerance);
  const updateSettings = useClashStore((s) => s.updateSettings);
  const models = useViewerStore((s) => s.models);
  const { groups, tolerances, settings } = matrix;
  // The same-discipline setting has nothing to compare until an open model is classified.
  const anyClassified = models.some((model) => modelDiscipline(matrix, model.summary.name));

  const check = (
    key: "checkOverlap" | "checkInside" | "checkDuplicate" | "ignoreSameModel" | "ignoreSameDiscipline",
  ) => (
    <div className="flex items-center gap-2">
      <Checkbox
        id={`clash-${key}`}
        checked={settings[key]}
        onCheckedChange={(checked) => updateSettings({ [key]: checked === true })}
      />
      <Label htmlFor={`clash-${key}`} className="cursor-pointer text-[11px] font-normal">
        {t(`settings.${key}`)}
      </Label>
    </div>
  );

  return (
    <div
      className={cn(
        "p-2",
        wide ? "grid items-start gap-4 md:grid-cols-[minmax(0,1.5fr)_minmax(22rem,1fr)]" : "space-y-3",
      )}
    >
      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold">{t("matrix.title")}</h3>
        <p className="text-muted-foreground text-[10px] leading-snug">{t("matrix.hint")}</p>
        {groups.length === 0 ? (
          <div className="space-y-2">
            <p className="text-muted-foreground rounded border border-dashed p-2 text-center text-[11px]">
              {t("matrix.empty")}
            </p>
            <TemplateOffer />
          </div>
        ) : (
          <div className="overflow-auto rounded border" data-clash-matrix>
            <table className="border-collapse text-[10px]">
              <thead>
                <tr>
                  <th className="bg-muted/40 sticky left-0 z-10 min-w-24 border-b border-r p-1" />
                  {groups.map((group) => (
                    <th
                      key={group.id}
                      className="bg-muted/40 max-h-28 border-b border-r p-1 align-bottom font-medium"
                      title={group.name}
                    >
                      <span className="block max-h-28 overflow-hidden whitespace-nowrap [writing-mode:vertical-rl]">
                        {group.name}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map((row, i) => (
                  <tr key={row.id}>
                    <th
                      scope="row"
                      className="bg-muted/40 sticky left-0 z-10 max-w-28 truncate border-b border-r px-1 py-0.5 text-left font-medium"
                      title={row.name}
                    >
                      {row.name}
                    </th>
                    {groups.map((column, j) => {
                      if (j > i) return <td key={column.id} className="bg-muted/20 border-b border-r" />;
                      const rule = findRule(matrix, row.id, column.id);
                      return (
                        <td key={column.id} className="border-b border-r p-0.5">
                          <select
                            aria-label={t("matrix.cell", { row: row.name, column: column.name })}
                            value={rule?.toleranceId ?? ""}
                            onChange={(event) => setRule(row.id, column.id, event.target.value || null)}
                            className={cn(
                              "h-6 w-16 rounded border bg-transparent px-0.5 text-[10px]",
                              rule && "border-primary/50 bg-primary/10 font-medium",
                            )}
                          >
                            <option value="">{t("matrix.none")}</option>
                            {tolerances.map((tolerance) => (
                              <option key={tolerance.id} value={tolerance.id}>
                                {tolerance.name}
                              </option>
                            ))}
                          </select>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="space-y-3">
      <section className="space-y-1.5">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold">{t("tolerances.title")}</h3>
          <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={addTolerance}>
            <Plus className="h-3 w-3" />
            {t("tolerances.add")}
          </Button>
        </div>
        <p className="text-muted-foreground text-[10px] leading-snug">{t("tolerances.hint")}</p>
        {tolerances.map((tolerance) => (
          <ToleranceRow key={tolerance.id} tolerance={tolerance} />
        ))}
      </section>

      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold">{t("settings.title")}</h3>
        {check("checkOverlap")}
        {check("checkInside")}
        {check("checkDuplicate")}
        {check("ignoreSameModel")}
        {check("ignoreSameDiscipline")}
        {settings.ignoreSameDiscipline && models.length > 0 && !anyClassified ? (
          <p className="text-muted-foreground pl-6 text-[10px] leading-snug" data-clash-same-discipline-hint>
            {t("settings.ignoreSameDisciplineHint")}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <Input
            id="clash-max"
            type="number"
            min={1}
            max={100000}
            value={settings.maxClashes}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isFinite(value) && value >= 1) updateSettings({ maxClashes: Math.floor(value) });
            }}
            className="h-7 w-20 text-xs"
          />
          <Label htmlFor="clash-max" className="text-[11px] font-normal">
            {t("settings.maxClashes")}
          </Label>
        </div>
      </section>
      </div>
    </div>
  );
}

function MmField({
  id,
  label,
  metres,
  onChange,
}: {
  id: string;
  label: string;
  metres: number;
  onChange: (metres: number) => void;
}) {
  return (
    <div className="space-y-0.5">
      <Label htmlFor={id} className="text-[10px]">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min={0}
        step={1}
        value={toMm(metres)}
        onChange={(event) => {
          const value = Number(event.target.value);
          if (event.target.value !== "" && Number.isFinite(value) && value >= 0) onChange(fromMm(value));
        }}
        className="h-7 text-xs"
      />
    </div>
  );
}

function ToleranceRow({ tolerance }: { tolerance: ClashTolerance }) {
  const t = useTranslations("viewer.clash");
  const update = useClashStore((s) => s.updateTolerance);
  const remove = useClashStore((s) => s.removeTolerance);

  return (
    <div className="space-y-1.5 rounded border p-1.5" data-clash-tolerance>
      <div className="flex items-center gap-1">
        <Input
          aria-label={t("tolerances.name")}
          value={tolerance.name}
          onChange={(event) => update(tolerance.id, { name: event.target.value })}
          className="h-7 min-w-0 flex-1 text-xs font-medium"
        />
        <Select
          value={tolerance.mode}
          onValueChange={(mode) => update(tolerance.id, { mode: mode as ClashTolerance["mode"] })}
        >
          <SelectTrigger size="sm" className="h-7 w-28 shrink-0 text-[11px]" aria-label={t("tolerances.mode")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hard">{t("tolerances.hard")}</SelectItem>
            <SelectItem value="clearance">{t("tolerances.clearance")}</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label={t("tolerances.remove")}
          onClick={() => remove(tolerance.id)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      {tolerance.mode === "hard" ? (
        <>
          <div className="grid grid-cols-2 gap-1.5">
            <MmField id={`${tolerance.id}-h`} label={t("tolerances.horizontal")} metres={tolerance.horizontal} onChange={(horizontal) => update(tolerance.id, { horizontal })} />
            <MmField id={`${tolerance.id}-v`} label={t("tolerances.vertical")} metres={tolerance.vertical} onChange={(vertical) => update(tolerance.id, { vertical })} />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${tolerance.id}-use-volume`}
              checked={tolerance.useVolume}
              onCheckedChange={(checked) => update(tolerance.id, { useVolume: checked === true })}
            />
            <Label htmlFor={`${tolerance.id}-use-volume`} className="cursor-pointer text-[11px] font-normal">
              {t("tolerances.useVolume")}
            </Label>
            <Input
              aria-label={t("tolerances.volume")}
              type="number"
              min={0}
              step={0.001}
              disabled={!tolerance.useVolume}
              value={tolerance.volume}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (event.target.value !== "" && Number.isFinite(value) && value >= 0) {
                  update(tolerance.id, { volume: value });
                }
              }}
              className="ml-auto h-7 w-20 text-xs"
            />
            <span className="text-muted-foreground text-[10px]">m³</span>
          </div>
        </>
      ) : (
        <MmField id={`${tolerance.id}-c`} label={t("tolerances.clearanceMm")} metres={tolerance.clearance} onChange={(clearance) => update(tolerance.id, { clearance })} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function ResultsTab() {
  const t = useTranslations("viewer.clash");
  const result = useClashStore((s) => s.result);
  const ignored = useClashStore((s) => s.ignored);
  const toggleIgnored = useClashStore((s) => s.toggleIgnored);
  const [active, setActive] = useState<string | null>(null);

  const byRule = useMemo(() => {
    const groups = new Map<string, ClashResultItem[]>();
    for (const item of result?.items ?? []) {
      const list = groups.get(item.rule) ?? [];
      list.push(item);
      groups.set(item.rule, list);
    }
    return [...groups];
  }, [result]);

  if (!result) {
    return <p className="text-muted-foreground p-3 text-xs">{t("results.empty")}</p>;
  }

  return (
    <div className="space-y-2 p-2">
      <div className="space-y-0.5 text-xs" role="status">
        <p className="font-medium">
          {t("results.summary", {
            count: result.items.length,
            seconds: (result.durationMs / 1000).toFixed(1),
          })}
        </p>
        {result.items.length === 0 && (
          <p className="text-muted-foreground">{t("results.none")}</p>
        )}
        {result.truncated && (
          <p className="text-warning">
            {t("results.truncated", { max: useClashStore.getState().matrix.settings.maxClashes })}
          </p>
        )}
        {result.withoutGeometry > 0 && (
          <p className="text-muted-foreground">
            {t("results.withoutGeometry", { count: result.withoutGeometry })}
          </p>
        )}
      </div>

      {byRule.map(([rule, items]) => (
        <section key={rule} className="space-y-1">
          <h3 className="text-muted-foreground truncate text-[11px] font-semibold" title={rule}>
            {rule} · {items.length}
          </h3>
          <ul className="divide-y rounded border" data-clash-list>
            {items.map((item) => (
              <li
                key={item.id}
                data-clash-item
                className={cn(
                  "flex items-start gap-1.5 p-1.5 text-xs",
                  active === item.id && "bg-accent/60",
                  ignored.has(item.id) && "opacity-50",
                )}
              >
                <Checkbox
                  checked={!ignored.has(item.id)}
                  onCheckedChange={() => toggleIgnored(item.id)}
                  aria-label={t("results.ignore")}
                  className="mt-0.5"
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    setActive(item.id);
                    showClash(item, false);
                  }}
                >
                  <span className="flex items-center gap-1">
                    <Badge variant="outline" className={cn("px-1 text-[9px]", KIND_TONE[item.kind])}>
                      {t(`results.kind.${item.kind}`)}
                    </Badge>
                    <span className="text-muted-foreground text-[10px] tabular-nums">
                      {item.kind === "clearance"
                        ? t("results.gap", { mm: Math.round(item.distance * 1000) })
                        : item.kind === "hard"
                          ? t("results.depth", { mm: Math.round(item.depth * 1000) })
                          : t("results.region", { size: Math.max(...item.extent).toFixed(2) })}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate" title={`${item.elementA.name} / ${item.elementB.name}`}>
                    <span style={{ color: CLASH_COLOUR_A }}>●</span> {item.elementA.type}{" "}
                    {item.elementA.name}
                  </span>
                  <span className="block truncate">
                    <span style={{ color: CLASH_COLOUR_B }}>●</span> {item.elementB.type}{" "}
                    {item.elementB.name}
                  </span>
                </button>
                <div className="flex shrink-0 flex-col">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        aria-label={t("results.show")}
                        onClick={() => {
                          setActive(item.id);
                          showClash(item, false);
                        }}
                      >
                        <Crosshair className="h-3 w-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("results.show")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        aria-label={t("results.isolate")}
                        onClick={() => {
                          setActive(item.id);
                          showClash(item, true);
                        }}
                      >
                        <Eye className="h-3 w-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("results.isolate")}</TooltipContent>
                  </Tooltip>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {result.items.length > 0 && <ExportBar />}
    </div>
  );
}

function ExportBar() {
  const t = useTranslations("viewer.clash");
  const result = useClashStore((s) => s.result);
  const ignored = useClashStore((s) => s.ignored);
  const author = useBcfStore((s) => s.author);
  const setBcfFile = useBcfStore((s) => s.setFile);
  const [snapshots, setSnapshots] = useState(true);
  const [isolate, setIsolate] = useState(true);
  const [busy, setBusy] = useState(false);

  const included = (result?.items ?? []).filter((item) => !ignored.has(item.id));

  const onExport = async () => {
    if (included.length === 0) {
      toast.error(t("export.none"));
      return;
    }
    setBusy(true);
    try {
      const file = await clashesToBcf(included, {
        author,
        captureSnapshots: snapshots,
        isolate,
        onProgress: (done, total) => {
          if (snapshots && done % 5 === 0) {
            toast.info(t("export.progress", { done, total }), { id: "clash-bcf-progress" });
          }
        },
        onSnapshotBudgetExceeded: () =>
          toast.warning(t("export.budget", { max: DEFAULT_MAX_CLASH_SNAPSHOTS }), { duration: 10_000 }),
      });

      const { bytes, notes } = serializeBcf(file);
      download(new Blob([bytes as BlobPart], { type: "application/octet-stream" }), bcfFileName(file));
      // Hand it to the BCF manager too, so the issues can be triaged at once.
      setBcfFile(file);
      toast.success(t("export.exported", { count: file.topics.length }), { id: "clash-bcf-progress" });
      for (const note of notes.slice(0, 3)) toast.warning(note.message);
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : t("export.failed"), {
        id: "clash-bcf-progress",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-1.5 rounded-lg border p-2" data-clash-export>
      <h3 className="text-xs font-semibold">{t("export.title")}</h3>
      <div className="flex items-start gap-2">
        <Checkbox id="clash-snapshots" checked={snapshots} onCheckedChange={(v) => setSnapshots(v === true)} />
        <div className="space-y-0.5">
          <Label htmlFor="clash-snapshots" className="cursor-pointer text-[11px] font-medium">
            {t("export.snapshots")}
          </Label>
          <p className="text-muted-foreground text-[10px] leading-snug">
            {t("export.snapshotsHint", { max: DEFAULT_MAX_CLASH_SNAPSHOTS })}
          </p>
        </div>
      </div>
      {snapshots && (
        <div className="flex items-center gap-2">
          <Checkbox id="clash-isolate" checked={isolate} onCheckedChange={(v) => setIsolate(v === true)} />
          <Label htmlFor="clash-isolate" className="cursor-pointer text-[11px] font-normal">
            {t("export.isolate")}
          </Label>
        </div>
      )}
      <Button size="sm" className="w-full" onClick={() => void onExport()} disabled={busy || included.length === 0}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
        {busy ? t("export.exporting") : `${t("export.button")} (${included.length})`}
      </Button>
      {ignored.size > 0 && (
        <p className="text-muted-foreground text-[10px]">{t("results.ignored", { count: ignored.size })}</p>
      )}
    </section>
  );
}

export default ClashPanel;
