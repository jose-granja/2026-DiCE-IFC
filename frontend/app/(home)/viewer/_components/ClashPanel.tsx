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
  Loader2,
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
import { findRule } from "@/lib/clash/matrix";
import { useClashStore } from "@/lib/clash/store";
import { buildTemplate } from "@/lib/clash/templates";
import type { ClashGroup, ClashKind, ClashResultItem, ClashTolerance } from "@/lib/clash/types";
import { createClashWorkbook, readClashWorkbook } from "@/lib/clash/workbook";
import { isEmptyElementFilter } from "@/lib/ifc/element-filter";
import { useViewerStore } from "@/lib/viewer/store";
import { useModelVocabulary } from "@/lib/viewer/use-model-vocabulary";
import { cn } from "@/lib/utils";
import ElementFilterEditor from "./ElementFilterEditor";

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
    setMatrix(template);
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
  const template = useResidentialTemplate();
  const fileInput = useRef<HTMLInputElement>(null);

  const importWorkbook = async (file: File) => {
    try {
      const imported = readClashWorkbook(new Uint8Array(await file.arrayBuffer()));
      setMatrix(imported);
      toast.success(
        t("matrixImported", { groups: imported.groups.length, cells: imported.rules.length }),
      );
      setTab("matrix");
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
    return <p className="text-muted-foreground p-3 text-xs">{t("loadModel")}</p>;
  }

  const percent =
    progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="flex h-full min-h-0 flex-col" data-clash-panel>
      <div className="flex items-center gap-1 border-b p-2">
        {running ? (
          <Button size="sm" variant="secondary" className="h-7" onClick={cancel}>
            <Square className="h-3.5 w-3.5" />
            {t("stop")}
          </Button>
        ) : (
          <Button
            size="sm"
            className="h-7"
            onClick={() => {
              void run().then(() => {
                if (useClashStore.getState().result) setTab("results");
              });
            }}
            disabled={matrix.rules.length === 0}
          >
            <Play className="h-3.5 w-3.5" />
            {t("run")}
          </Button>
        )}

        <div className="ml-auto flex items-center gap-0.5">
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
        </div>
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
      </div>

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

      {open && (
        <div className="space-y-2 border-t p-2">
          <div className="space-y-1">
            <Label htmlFor={`${group.id}-discipline`} className="text-[11px]">
              {t("groups.discipline")}
            </Label>
            <Input
              id={`${group.id}-discipline`}
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

function MatrixTab() {
  const t = useTranslations("viewer.clash");
  const matrix = useClashStore((s) => s.matrix);
  const setRule = useClashStore((s) => s.setRule);
  const addTolerance = useClashStore((s) => s.addTolerance);
  const updateSettings = useClashStore((s) => s.updateSettings);
  const { groups, tolerances, settings } = matrix;

  const check = (key: "checkOverlap" | "checkInside" | "checkDuplicate" | "ignoreSameModel") => (
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
    <div className="space-y-3 p-2">
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
