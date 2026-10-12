"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useQueries } from "@tanstack/react-query";
import {
  Calculator,
  Copy,
  Download,
  Filter,
  ListPlus,
  Loader2,
  Pencil,
  Plus,
  Play,
  ScanSearch,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
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
import type {
  ModelVocabulary,
  PropertyValue,
  QuantityQuery,
  QuantityQueryOperator,
  QuantityQueryRow,
  QuantityQuerySource,
} from "@/lib/ifc/types";
import { splitTextList } from "@/lib/ifc/text-match";
import {
  createQuantityWorkbook,
  readQuantityWorkbook,
} from "@/lib/spreadsheets/quantity-workbook";
import { getModelHandle } from "@/lib/viewer/loader";
import { useViewerStore, type EntityRef } from "@/lib/viewer/store";
import { classificationCodesFor } from "@/lib/viewer/use-model-vocabulary";

type ConditionRow = {
  id: string;
  setName: string;
  propertyName: string;
  operator: QuantityQueryOperator;
  value: string;
};

type SourceRow = QuantityQuerySource & {
  setName: string;
  valueName: string;
};

type ResultRow = QuantityQueryRow & { modelId: string; modelName: string };

type CombinedResult = {
  matchedCount: number;
  valueCount: number;
  missingValueCount: number;
  total: number | null;
  rows: ResultRow[];
  aliases: string[];
};

type QueryListItem = {
  id: string;
  code: string;
  description: string;
  query: QuantityQuery;
  result: CombinedResult | null;
};

type StoredQueryListItem = {
  id: string;
  code?: string;
  description?: string;
  /** Legacy field from the first version of the quantity list. */
  name?: string;
  query: QuantityQuery;
};

let rowSequence = 1;
const QUERY_LIST_STORAGE_KEY = "dice-ifc.quantity-query-list.v1";
const rowId = (prefix: string) => `${prefix}-${++rowSequence}`;
const splitValues = splitTextList;

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function displayValue(value: PropertyValue) {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number")
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 6,
    }).format(value);
  return value;
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function SuggestionInput({
  id,
  label,
  value,
  onChange,
  suggestions,
  placeholder,
  hint,
  disabled = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  placeholder?: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px]">
        {label}
      </Label>
      <Input
        id={id}
        list={`${id}-options`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="h-8 text-xs"
      />
      <datalist id={`${id}-options`}>
        {suggestions.map((suggestion) => (
          <option key={suggestion} value={suggestion} />
        ))}
      </datalist>
      {hint && (
        <p className="text-muted-foreground text-[10px] leading-snug">{hint}</p>
      )}
    </div>
  );
}

export function QuantityQueryPanel() {
  const t = useTranslations("viewer.quantityQuery");
  const models = useViewerStore((state) => state.models);
  const select = useViewerStore((state) => state.select);
  const isolate = useViewerStore((state) => state.isolate);
  const workbookInput = useRef<HTMLInputElement>(null);
  const ready = useMemo(
    () => models.filter((model) => model.load.status === "ready"),
    [models],
  );

  const vocabularyQueries = useQueries({
    queries: ready.map((model) => ({
      queryKey: ["quantity-query-vocabulary", model.summary.id],
      staleTime: Infinity,
      retry: false,
      queryFn: async () => {
        const handle = getModelHandle(model.summary.id);
        if (!handle) throw new Error(t("modelUnavailable"));
        return handle.getVocabulary({ sampleSize: 4_000 });
      },
    })),
  });

  const vocabulary = useMemo(() => {
    const propertySets = new Map<string, Set<string>>();
    const quantitySets = new Map<string, Set<string>>();
    const classes = new Set<string>();
    const predefinedTypes = new Set<string>();
    const objectTypes = new Set<string>();
    const materials = new Set<string>();
    const classificationSystems = new Set<string>();
    // Codes stay grouped by system: a code only means something inside one, and
    // one flat list would suggest pairs that match nothing.
    const classificationCodes = new Map<string, Set<string>>();
    const addSets = (
      target: Map<string, Set<string>>,
      sets: Array<{ name: string; values: string[] }>,
    ) => {
      for (const set of sets) {
        const values = target.get(set.name) ?? new Set<string>();
        set.values.forEach((value) => values.add(value));
        target.set(set.name, values);
      }
    };

    ready.forEach((model) =>
      model.entityTypes.forEach((entry) => classes.add(entry.type)),
    );
    for (const query of vocabularyQueries) {
      const data: ModelVocabulary | undefined = query.data;
      if (!data) continue;
      data.predefinedTypes.forEach((value) => predefinedTypes.add(value));
      data.objectTypes.forEach((value) => objectTypes.add(value));
      data.materials.forEach((value) => materials.add(value));
      data.classificationSystems.forEach((value) => classificationSystems.add(value));
      for (const entry of data.classificationCodes) {
        const codes = classificationCodes.get(entry.system) ?? new Set<string>();
        entry.codes.forEach((code) => codes.add(code));
        classificationCodes.set(entry.system, codes);
      }
      addSets(
        propertySets,
        data.propertySets.map((set) => ({
          name: set.name,
          values: set.properties,
        })),
      );
      addSets(
        quantitySets,
        data.quantitySets.map((set) => ({
          name: set.name,
          values: set.quantities,
        })),
      );
    }
    const sorted = (values: Iterable<string>) =>
      [...values].sort((a, b) => a.localeCompare(b));
    return {
      classes: sorted(classes),
      predefinedTypes: sorted(predefinedTypes),
      objectTypes: sorted(objectTypes),
      materials: sorted(materials),
      classificationSystems: sorted(classificationSystems),
      classificationCodes,
      propertySets,
      quantitySets,
    };
  }, [ready, vocabularyQueries]);

  const [classes, setClasses] = useState("");
  const [predefinedTypes, setPredefinedTypes] = useState("");
  const [objectTypes, setObjectTypes] = useState("");
  const [materials, setMaterials] = useState("");
  const [materialCategories, setMaterialCategories] = useState("");
  const [classificationSystem, setClassificationSystem] = useState("");
  const [classificationCodes, setClassificationCodes] = useState("");
  const codeSuggestions = useMemo(
    () => classificationCodesFor(vocabulary.classificationCodes, classificationSystem),
    [classificationSystem, vocabulary.classificationCodes],
  );

  const [conditions, setConditions] = useState<ConditionRow[]>([]);
  const [propertyCombination, setPropertyCombination] = useState<"all" | "any">(
    "all",
  );
  const [sources, setSources] = useState<SourceRow[]>([
    {
      id: "source-1",
      alias: "quantity",
      kind: "quantity",
      setName: "",
      valueName: "",
    },
  ]);
  const [formula, setFormula] = useState("");
  const [unit, setUnit] = useState("");
  const [queryCode, setQueryCode] = useState("");
  const [queryDescription, setQueryDescription] = useState(() =>
    t("list.defaultDescription", { number: 1 }),
  );
  const [queryItems, setQueryItems] = useState<QueryListItem[]>([]);
  const [queryListLoaded, setQueryListLoaded] = useState(false);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<
    "idle" | "view" | "edit" | "new"
  >("idle");
  const [running, setRunning] = useState(false);
  const [runningList, setRunningList] = useState(false);
  const [importingWorkbook, setImportingWorkbook] = useState(false);
  const [exportingWorkbook, setExportingWorkbook] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CombinedResult | null>(null);
  const [editorTab, setEditorTab] = useState<"filters" | "values" | "results">(
    "filters",
  );

  // Query definitions are small, user-authored data. Keep them local so a
  // list survives switching viewer tabs or reopening the page; model-derived
  // result rows can be large and are deliberately recalculated instead.
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        const stored = localStorage.getItem(QUERY_LIST_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as StoredQueryListItem[];
          if (Array.isArray(parsed)) {
            setQueryItems(
              parsed.map((item, index) => ({
                id: item.id,
                code: item.code ?? "",
                description:
                  item.description ??
                  item.name ??
                  t("list.defaultDescription", { number: index + 1 }),
                query: item.query,
                result: null,
              })),
            );
          }
        }
      } catch {
        // A corrupt local draft should not prevent a new list from being built.
      } finally {
        setQueryListLoaded(true);
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (!queryListLoaded) return;
    try {
      const definitions = queryItems.map(
        ({ id, code, description, query }) => ({
          id,
          code,
          description,
          query,
        }),
      );
      localStorage.setItem(QUERY_LIST_STORAGE_KEY, JSON.stringify(definitions));
    } catch {
      // Storage can be unavailable in private browsing; the in-memory list
      // still works for the current viewer session.
    }
  }, [queryItems, queryListLoaded]);

  const propertySetNames = useMemo(
    () =>
      [...vocabulary.propertySets.keys()].sort((a, b) => a.localeCompare(b)),
    [vocabulary.propertySets],
  );
  const quantitySetNames = useMemo(
    () =>
      [...vocabulary.quantitySets.keys()].sort((a, b) => a.localeCompare(b)),
    [vocabulary.quantitySets],
  );

  const patchCondition = (id: string, patch: Partial<ConditionRow>) =>
    setConditions((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  const patchSource = (id: string, patch: Partial<SourceRow>) =>
    setSources((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );

  const buildCurrentQuery = (): QuantityQuery | null => {
    const aliases = sources.map((source) => source.alias.trim());
    if (aliases.some((alias) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias))) {
      setError(t("errors.alias"));
      return null;
    }
    if (new Set(aliases).size !== aliases.length) {
      setError(t("errors.duplicateAlias"));
      return null;
    }
    if (
      sources.some(
        (source) =>
          source.kind !== "count" &&
          (!source.setName.trim() || !source.valueName.trim()),
      )
    ) {
      setError(t("errors.sourceFields"));
      return null;
    }
    if (sources.length > 1 && !formula.trim()) {
      setError(t("errors.formulaRequired"));
      return null;
    }
    if (
      conditions.some(
        (condition) =>
          !condition.setName.trim() || !condition.propertyName.trim(),
      )
    ) {
      setError(t("errors.conditionFields"));
      return null;
    }

    return {
      filters: {
        classes: splitValues(classes),
        predefinedTypes: splitValues(predefinedTypes),
        objectTypes: splitValues(objectTypes),
        materials: splitValues(materials),
        materialCategories: splitValues(materialCategories),
        classificationSystem: classificationSystem.trim(),
        classificationCodes: splitValues(classificationCodes),
        propertyCombination,
        properties: conditions.map(
          ({ setName, propertyName, operator, value }) => ({
            setName: setName.trim(),
            propertyName: propertyName.trim(),
            operator,
            value,
          }),
        ),
      },
      sources: sources.map(({ id, alias, kind, setName, valueName }) => ({
        id,
        alias: alias.trim(),
        kind,
        setName: setName.trim(),
        valueName: valueName.trim(),
      })),
      formula: formula.trim() || undefined,
      unit: unit.trim() || undefined,
    };
  };

  const evaluateQuery = async (
    query: QuantityQuery,
  ): Promise<CombinedResult> => {
    const outcomes = await Promise.all(
      ready.map(async (model) => {
        const handle = getModelHandle(model.summary.id);
        if (!handle) throw new Error(t("modelUnavailable"));
        const modelResult = await handle.evaluateQuantityQuery(query);
        return { model, modelResult };
      }),
    );
    const rows = outcomes.flatMap(({ model, modelResult }) =>
      modelResult.rows.map((row) => ({
        ...row,
        modelId: model.summary.id,
        modelName: model.summary.name,
      })),
    );
    const numericTotals = outcomes
      .map(({ modelResult }) => modelResult.total)
      .filter((value): value is number => value !== null);
    return {
      matchedCount: outcomes.reduce(
        (sum, { modelResult }) => sum + modelResult.matchedCount,
        0,
      ),
      valueCount: outcomes.reduce(
        (sum, { modelResult }) => sum + modelResult.valueCount,
        0,
      ),
      missingValueCount: outcomes.reduce(
        (sum, { modelResult }) => sum + modelResult.missingValueCount,
        0,
      ),
      total:
        numericTotals.length > 0
          ? numericTotals.reduce((sum, value) => sum + value, 0)
          : null,
      rows,
      aliases: query.sources.map((source) => source.alias),
    };
  };

  const runQuery = async () => {
    setError(null);
    if (ready.length === 0) return;
    const query = buildCurrentQuery();
    if (!query) return;

    setRunning(true);
    try {
      const nextResult = await evaluateQuery(query);
      setResult(nextResult);
      setEditorTab("results");
      if (editingItemId) {
        setQueryItems((current) =>
          current.map((item) =>
            item.id === editingItemId
              ? {
                  ...item,
                  code: queryCode.trim(),
                  description: queryDescription.trim() || item.description,
                  query,
                  result: nextResult,
                }
              : item,
          ),
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("errors.run"));
    } finally {
      setRunning(false);
    }
  };

  const resetEditor = () => {
    setEditingItemId(null);
    setEditorMode("new");
    setQueryCode("");
    setQueryDescription(
      t("list.defaultDescription", { number: queryItems.length + 1 }),
    );
    setClasses("");
    setPredefinedTypes("");
    setObjectTypes("");
    setMaterials("");
    setMaterialCategories("");
    setClassificationSystem("");
    setClassificationCodes("");
    setConditions([]);
    setPropertyCombination("all");
    setSources([
      {
        id: rowId("source"),
        alias: "quantity",
        kind: "quantity",
        setName: "",
        valueName: "",
      },
    ]);
    setFormula("");
    setUnit("");
    setResult(null);
    setError(null);
    setEditorTab("filters");
  };

  const loadItem = (item: QueryListItem, mode: "view" | "edit" = "view") => {
    setEditingItemId(item.id);
    setEditorMode(mode);
    setQueryCode(item.code);
    setQueryDescription(item.description);
    setClasses(item.query.filters.classes.join(", "));
    setPredefinedTypes(item.query.filters.predefinedTypes.join(", "));
    setObjectTypes(item.query.filters.objectTypes.join(", "));
    setMaterials(item.query.filters.materials.join(", "));
    setMaterialCategories((item.query.filters.materialCategories ?? []).join(", "));
    setClassificationSystem(item.query.filters.classificationSystem ?? "");
    setClassificationCodes((item.query.filters.classificationCodes ?? []).join(", "));
    setPropertyCombination(item.query.filters.propertyCombination ?? "all");
    setConditions(
      item.query.filters.properties.map((condition) => ({
        ...condition,
        id: rowId("condition"),
      })),
    );
    setSources(
      item.query.sources.map((source) => ({
        ...source,
        id: rowId("source"),
        setName: source.setName ?? "",
        valueName: source.valueName ?? "",
      })),
    );
    setFormula(item.query.formula ?? "");
    setUnit(item.query.unit ?? "");
    setResult(item.result);
    setError(null);
  };

  const saveItem = () => {
    setError(null);
    const query = buildCurrentQuery();
    if (!query) return;
    const code = queryCode.trim();
    const description =
      queryDescription.trim() ||
      t("list.defaultDescription", { number: queryItems.length + 1 });
    if (editingItemId && editorMode === "edit") {
      setQueryItems((current) =>
        current.map((item) =>
          item.id === editingItemId
            ? { ...item, code, description, query, result: null }
            : item,
        ),
      );
      setResult(null);
      setEditorMode("view");
      return;
    }
    const item: QueryListItem = {
      id: rowId("query"),
      code,
      description,
      query,
      result: null,
    };
    setQueryItems((current) => [...current, item]);
    setEditingItemId(item.id);
    setEditorMode("view");
  };

  const duplicateItem = (source: QueryListItem) => {
    const copy: QueryListItem = {
      ...source,
      id: rowId("query"),
      code: source.code,
      description: t("list.copyDescription", {
        description: source.description,
      }),
      query: structuredClone(source.query),
      result: null,
    };
    setQueryItems((current) => [...current, copy]);
    loadItem(copy, "edit");
  };

  const removeItem = (id: string) => {
    const remaining = queryItems.filter((item) => item.id !== id);
    setQueryItems(remaining);
    if (editingItemId !== id) return;
    const next = remaining[0];
    if (next) loadItem(next, "view");
    else {
      setEditingItemId(null);
      setEditorMode("idle");
      setResult(null);
      setError(null);
    }
  };

  const evaluateList = async (items: QueryListItem[]) => {
    const completed: QueryListItem[] = [];
    for (const item of items) {
      try {
        completed.push({ ...item, result: await evaluateQuery(item.query) });
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : t("errors.run");
        throw new Error(
          t("list.itemError", { description: item.description, message }),
        );
      }
    }
    return completed;
  };

  const showCompletedList = (completed: QueryListItem[]) => {
    setQueryItems(completed);
    const selected = completed.find((item) => item.id === editingItemId);
    if (selected) setResult(selected.result);
  };

  const runAll = async () => {
    if (queryItems.length === 0 || runningList) return;
    setError(null);
    setRunningList(true);
    try {
      showCompletedList(await evaluateList(queryItems));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("errors.run"));
    } finally {
      setRunningList(false);
    }
  };

  const importWorkbook = async (file: File) => {
    setError(null);
    setImportingWorkbook(true);
    try {
      const definitions = readQuantityWorkbook(
        new Uint8Array(await file.arrayBuffer()),
      );
      const imported = definitions.map((definition) => ({
        ...definition,
        id: rowId("query"),
        result: null,
      }));
      setQueryItems((current) => [...current, ...imported]);
      loadItem(imported[0], "view");
      toast.success(t("workbook.imported", { count: imported.length }));
    } catch {
      setError(t("workbook.importFailed"));
    } finally {
      setImportingWorkbook(false);
      if (workbookInput.current) workbookInput.current.value = "";
    }
  };

  const downloadWorkbook = async () => {
    if (queryItems.length === 0 || exportingWorkbook) return;
    setError(null);
    setExportingWorkbook(true);
    try {
      const completed = await evaluateList(queryItems);
      showCompletedList(completed);
      const bytes = createQuantityWorkbook(completed);
      downloadBlob(
        new Blob([new Uint8Array(bytes).buffer], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
        "ifc-quantities.xlsx",
      );
      toast.success(t("workbook.downloaded"));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("workbook.exportFailed"),
      );
    } finally {
      setExportingWorkbook(false);
    }
  };

  const resultRefs = (): EntityRef[] =>
    (result?.rows ?? []).map((row) => ({
      modelId: row.modelId,
      expressId: row.expressId,
    }));

  const downloadCsv = () => {
    if (!result) return;
    const header = [
      "Code",
      "Description",
      "Model",
      "ExpressId",
      "GlobalId",
      "IFC class",
      "Name",
      "PredefinedType",
      "ObjectType",
      "Materials",
      ...result.aliases,
      "Result",
      "Unit",
    ];
    const lines = [header.map(csvCell).join(",")];
    for (const row of result.rows) {
      lines.push(
        [
          queryCode,
          queryDescription,
          row.modelName,
          row.expressId,
          row.globalId,
          row.type,
          row.name,
          row.predefinedType,
          row.objectType,
          row.materials.join("; "),
          ...result.aliases.map((alias) => row.inputs[alias]),
          row.value,
          unit,
        ]
          .map(csvCell)
          .join(","),
      );
    }
    downloadBlob(
      new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" }),
      "ifc-quantity-query.csv",
    );
  };

  if (ready.length === 0) {
    return (
      <p className="text-muted-foreground p-3 text-xs">{t("loadModel")}</p>
    );
  }

  const readOnly = editorMode === "view";
  const hasEditor = editorMode !== "idle";

  return (
    <div
      className="flex min-h-0 flex-1 max-h-[-webkit-fill-available] flex-col"
      data-quantity-query-panel
    >
      <div className="flex items-center border-b p-2 text-xs font-medium justify-between">
        <div className="flex items-center gap-1.5">
          <Calculator className="h-3.5 w-3.5" aria-hidden />
          {t("title")}
          {vocabularyQueries.some((query) => query.isLoading) && (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          )}
        </div>
        <div className="flex flex-row gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                aria-label={t("list.new")}
                onClick={resetEditor}
              >
                <Plus className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("list.new")}</p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                aria-label={t("list.runAll")}
                disabled={queryItems.length === 0 || runningList}
                onClick={runAll}
              >
                {runningList ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Play className="h-3 w-3" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("list.runAll")}</p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                aria-label={t("workbook.import")}
                disabled={importingWorkbook}
                onClick={() => workbookInput.current?.click()}
              >
                {importingWorkbook ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Upload className="h-3 w-3" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("workbook.import")}</p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                aria-label={t("workbook.download")}
                disabled={queryItems.length === 0 || exportingWorkbook}
                onClick={() => void downloadWorkbook()}
              >
                {exportingWorkbook ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Download className="h-3 w-3" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("workbook.download")}</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2">
        <input
          ref={workbookInput}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          data-quantity-workbook-input
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importWorkbook(file);
          }}
        />
        <section
          className="shrink-0 space-y-2 rounded-lg border p-2"
          data-query-list
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold">
              <ListPlus className="h-3.5 w-3.5" />
              {t("list.title")}
            </h3>
          </div>

          {queryItems.length === 0 ? (
            <p className="text-muted-foreground text-[10px]">
              {t("list.empty")}
            </p>
          ) : (
            <div
              className="max-h-28 overflow-auto"
              role="list"
              aria-label={t("list.title")}
            >
              {queryItems.map((item) => (
                <div
                  key={item.id}
                  role="listitem"
                  aria-current={item.id === editingItemId ? "true" : undefined}
                  className={`flex w-full items-center rounded-md border text-[11px] transition-colors ${item.id === editingItemId ? "border-primary bg-primary/10" : "hover:bg-muted/50"}`}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center justify-between gap-2 px-1 py-0.5 text-left"
                    aria-label={t("list.viewItem", {
                      description: item.description,
                    })}
                    onClick={() => loadItem(item, "view")}
                  >
                    <span className="min-w-0 truncate font-medium">
                      {item.code && (
                        <span className="text-muted-foreground mr-1.5 font-mono">
                          {item.code}
                        </span>
                      )}
                      {item.description}
                    </span>
                    <span className="text-muted-foreground shrink-0 tabular-nums">
                      {item.result
                        ? item.result.total !== null
                          ? `${displayValue(item.result.total)} ${item.query.unit ?? ""}`
                          : t("list.matchCount", {
                              count: item.result.matchedCount,
                            })
                        : t("list.notRun")}
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center border-l pl-1">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          aria-label={t("list.editItem", {
                            description: item.description,
                          })}
                          onClick={() => loadItem(item, "edit")}
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{t("list.edit")}</p>
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          aria-label={t("list.duplicateItem", {
                            description: item.description,
                          })}
                          onClick={() => duplicateItem(item)}
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{t("list.duplicate")}</p>
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="text-destructive h-6 w-6"
                          aria-label={t("list.deleteItem", {
                            description: item.description,
                          })}
                          onClick={() => removeItem(item.id)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{t("list.remove")}</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              ))}
            </div>
          )}
          {(editorMode === "new" || editorMode === "edit") && (
            <div className="space-y-1 border-t pt-2" data-query-metadata-editor>
              <div className="grid grid-cols-[minmax(5rem,0.7fr)_minmax(0,1.3fr)] gap-1.5">
                <div className="space-y-1">
                  <Label htmlFor="quantity-query-code" className="text-[11px]">
                    {t("list.code")}
                  </Label>
                  <Input
                    id="quantity-query-code"
                    value={queryCode}
                    onChange={(event) => setQueryCode(event.target.value)}
                    className="h-8 min-w-0 font-mono text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label
                    htmlFor="quantity-query-description"
                    className="text-[11px]"
                  >
                    {t("list.description")}
                  </Label>
                  <Input
                    id="quantity-query-description"
                    value={queryDescription}
                    onChange={(event) =>
                      setQueryDescription(event.target.value)
                    }
                    className="h-8 min-w-0 text-xs"
                  />
                </div>
              </div>
              <div className="flex gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  className="h-8 px-2 text-[11px]"
                  onClick={saveItem}
                >
                  <ListPlus className="h-3 w-3" />
                  {editorMode === "edit" ? t("list.update") : t("list.add")}
                </Button>
              </div>
            </div>
          )}
          {editorMode === "view" && editingItemId && (
            <div
              className="grid grid-cols-[minmax(5rem,0.7fr)_minmax(0,1.3fr)] gap-1.5 border-t pt-2 text-[11px]"
              data-query-metadata-view
            >
              <div className="min-w-0">
                <p className="text-muted-foreground text-[10px]">
                  {t("list.code")}
                </p>
                <p className="truncate font-mono">{queryCode || "—"}</p>
              </div>
              <div className="min-w-0">
                <p className="text-muted-foreground text-[10px]">
                  {t("list.description")}
                </p>
                <p className="truncate font-medium">{queryDescription}</p>
              </div>
            </div>
          )}
        </section>

        {error && (
          <p
            role="alert"
            className="text-destructive shrink-0 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-[11px]"
          >
            {error}
          </p>
        )}

        {hasEditor ? (
          <>
            <Tabs
              value={editorTab}
              onValueChange={(value) =>
                setEditorTab(value as "filters" | "values" | "results")
              }
              className="min-h-0 flex-1 gap-2 overflow-auto"
            >
              <TabsList className="grid w-full shrink-0 grid-cols-3">
                <TabsTrigger value="filters" className="text-[11px]">
                  {t("tabs.filters")}
                </TabsTrigger>
                <TabsTrigger value="values" className="text-[11px]">
                  {t("tabs.values")}
                </TabsTrigger>
                <TabsTrigger value="results" className="text-[11px]">
                  {t("tabs.results")}
                </TabsTrigger>
              </TabsList>

              <TabsContent
                value="filters"
                className="min-h-0 overflow-auto pr-1"
              >
                <section
                  className="space-y-2 rounded-lg border p-2"
                  data-query-filters
                >
                  <h3 className="flex items-center gap-1.5 text-xs font-semibold">
                    <Filter className="h-3.5 w-3.5" />
                    {t("filters.title")}
                  </h3>
                  <p className="text-muted-foreground text-[10px] leading-snug">
                    {t("filters.rule")}
                  </p>
                  <SuggestionInput
                    id="quantity-query-classes"
                    label={t("filters.class")}
                    value={classes}
                    onChange={setClasses}
                    suggestions={vocabulary.classes}
                    hint={t("filters.multipleHint")}
                    disabled={readOnly}
                  />
                  <SuggestionInput
                    id="quantity-query-predefined"
                    label={t("filters.predefinedType")}
                    value={predefinedTypes}
                    onChange={setPredefinedTypes}
                    suggestions={vocabulary.predefinedTypes}
                    hint={t("filters.multipleHint")}
                    disabled={readOnly}
                  />
                  <SuggestionInput
                    id="quantity-query-object"
                    label={t("filters.objectType")}
                    value={objectTypes}
                    onChange={setObjectTypes}
                    suggestions={vocabulary.objectTypes}
                    hint={t("filters.multipleHint")}
                    disabled={readOnly}
                  />
                  <SuggestionInput
                    id="quantity-query-material"
                    label={t("filters.material")}
                    value={materials}
                    onChange={setMaterials}
                    suggestions={vocabulary.materials}
                    hint={t("filters.multipleHint")}
                    disabled={readOnly}
                  />
                  <SuggestionInput
                    id="quantity-query-material-category"
                    label={t("filters.materialCategory")}
                    value={materialCategories}
                    onChange={setMaterialCategories}
                    suggestions={[]}
                    placeholder="Concrete"
                    hint={t("filters.multipleHint")}
                    disabled={readOnly}
                  />
                  <SuggestionInput
                    id="quantity-query-classification-system"
                    label={t("filters.classificationSystem")}
                    value={classificationSystem}
                    onChange={setClassificationSystem}
                    suggestions={vocabulary.classificationSystems}
                    hint={t("filters.classificationSystemHint")}
                    disabled={readOnly}
                  />
                  <SuggestionInput
                    id="quantity-query-classification-code"
                    label={t("filters.classificationCode")}
                    value={classificationCodes}
                    onChange={setClassificationCodes}
                    suggestions={codeSuggestions}
                    hint={t("filters.classificationCodeHint")}
                    disabled={readOnly}
                  />

                  <div className="space-y-2 pt-1">
                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-[11px]">
                        {t("filters.propertyConditions")}
                      </Label>
                      <div className="flex gap-1">
                        <Select
                          value={propertyCombination}
                          disabled={readOnly}
                          onValueChange={(value) =>
                            setPropertyCombination(value as "all" | "any")
                          }
                        >
                          <SelectTrigger
                            size="sm"
                            className="h-7 w-20 text-[11px]"
                            aria-label={t("filters.propertyRule")}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">
                              {t("filters.propertyAll")}
                            </SelectItem>
                            <SelectItem value="any">
                              {t("filters.propertyAny")}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        {!readOnly && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-[11px]"
                            onClick={() =>
                              setConditions((current) => [
                                ...current,
                                {
                                  id: rowId("condition"),
                                  setName: "",
                                  propertyName: "",
                                  operator: "equals",
                                  value: "",
                                },
                              ])
                            }
                          >
                            <Plus className="h-3 w-3" />
                            {t("add")}
                          </Button>
                        )}
                      </div>
                    </div>
                    {conditions.length === 0 && (
                      <p className="text-muted-foreground text-[10px]">
                        {t("filters.noConditions")}
                      </p>
                    )}
                    {conditions.map((condition) => {
                      const names = [
                        ...(vocabulary.propertySets.get(condition.setName) ??
                          []),
                      ].sort();
                      return (
                        <div
                          key={condition.id}
                          className="space-y-1.5 rounded-md bg-muted/40 p-2"
                        >
                          <div className="grid grid-cols-2 gap-1.5">
                            <SuggestionInput
                              id={`${condition.id}-set`}
                              label={t("set")}
                              value={condition.setName}
                              onChange={(value) =>
                                patchCondition(condition.id, { setName: value })
                              }
                              suggestions={propertySetNames}
                              disabled={readOnly}
                            />
                            <SuggestionInput
                              id={`${condition.id}-property`}
                              label={t("property")}
                              value={condition.propertyName}
                              onChange={(value) =>
                                patchCondition(condition.id, {
                                  propertyName: value,
                                })
                              }
                              suggestions={names}
                              disabled={readOnly}
                            />
                          </div>
                          <div className="flex gap-1.5">
                            <Select
                              value={condition.operator}
                              disabled={readOnly}
                              onValueChange={(value) =>
                                patchCondition(condition.id, {
                                  operator: value as QuantityQueryOperator,
                                })
                              }
                            >
                              <SelectTrigger
                                size="sm"
                                className="min-w-0 flex-1 text-xs"
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {(
                                  [
                                    "equals",
                                    "notEquals",
                                    "contains",
                                    "greaterThan",
                                    "greaterOrEqual",
                                    "lessThan",
                                    "lessOrEqual",
                                    "exists",
                                  ] as const
                                ).map((operator) => (
                                  <SelectItem key={operator} value={operator}>
                                    {t(`operators.${operator}`)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {condition.operator !== "exists" && (
                              <Input
                                aria-label={t("value")}
                                value={condition.value}
                                disabled={readOnly}
                                onChange={(event) =>
                                  patchCondition(condition.id, {
                                    value: event.target.value,
                                  })
                                }
                                className="h-8 min-w-0 flex-1 text-xs"
                              />
                            )}
                            {!readOnly && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 shrink-0"
                                aria-label={t("removeCondition")}
                                onClick={() =>
                                  setConditions((current) =>
                                    current.filter(
                                      (row) => row.id !== condition.id,
                                    ),
                                  )
                                }
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              </TabsContent>

              <TabsContent
                value="values"
                className="min-h-0 overflow-auto pr-1"
              >
                <section
                  className="space-y-2 rounded-lg border p-2"
                  data-query-sources
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-semibold">
                      {t("sources.title")}
                    </h3>
                    {!readOnly && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        onClick={() =>
                          setSources((current) => [
                            ...current,
                            {
                              id: rowId("source"),
                              alias: `value${current.length + 1}`,
                              kind: "quantity",
                              setName: "",
                              valueName: "",
                            },
                          ])
                        }
                      >
                        <Plus className="h-3 w-3" />
                        {t("add")}
                      </Button>
                    )}
                  </div>
                  <p className="text-muted-foreground text-[10px] leading-snug">
                    {t("sources.hint")}
                  </p>
                  {sources.map((source) => {
                    const sets =
                      source.kind === "property"
                        ? vocabulary.propertySets
                        : vocabulary.quantitySets;
                    const setNames =
                      source.kind === "property"
                        ? propertySetNames
                        : quantitySetNames;
                    const valueNames = [
                      ...(sets.get(source.setName) ?? []),
                    ].sort();
                    return (
                      <div
                        key={source.id}
                        className="space-y-1.5 rounded-md bg-muted/40 p-2"
                      >
                        <div className="flex gap-1.5">
                          <Input
                            aria-label={t("sources.alias")}
                            value={source.alias}
                            disabled={readOnly}
                            onChange={(event) =>
                              patchSource(source.id, {
                                alias: event.target.value,
                              })
                            }
                            placeholder="area"
                            className="h-8 min-w-0 flex-1 font-mono text-xs"
                          />
                          <Select
                            value={source.kind}
                            disabled={readOnly}
                            onValueChange={(value) =>
                              patchSource(source.id, {
                                kind: value as SourceRow["kind"],
                                setName: "",
                                valueName: "",
                              })
                            }
                          >
                            <SelectTrigger
                              size="sm"
                              className="min-w-24 text-xs"
                              aria-label={t("sources.kind")}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="count">
                                {t("sources.count")}
                              </SelectItem>
                              <SelectItem value="property">
                                {t("sources.property")}
                              </SelectItem>
                              <SelectItem value="quantity">
                                {t("sources.quantity")}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                          {!readOnly && sources.length > 1 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 shrink-0"
                              aria-label={t("removeSource")}
                              onClick={() =>
                                setSources((current) =>
                                  current.filter((row) => row.id !== source.id),
                                )
                              }
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                        {source.kind !== "count" && (
                          <div className="grid grid-cols-2 gap-1.5">
                            <SuggestionInput
                              id={`${source.id}-set`}
                              label={t("set")}
                              value={source.setName}
                              onChange={(value) =>
                                patchSource(source.id, { setName: value })
                              }
                              suggestions={setNames}
                              disabled={readOnly}
                            />
                            <SuggestionInput
                              id={`${source.id}-value`}
                              label={
                                source.kind === "property"
                                  ? t("property")
                                  : t("quantity")
                              }
                              value={source.valueName}
                              onChange={(value) =>
                                patchSource(source.id, { valueName: value })
                              }
                              suggestions={valueNames}
                              disabled={readOnly}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <SuggestionInput
                    id="quantity-query-formula"
                    label={t("formula")}
                    value={formula}
                    onChange={setFormula}
                    suggestions={[]}
                    placeholder={sources
                      .map((source) => source.alias || "value")
                      .join(" + ")}
                    hint={t("formulaHint")}
                    disabled={readOnly}
                  />
                  <SuggestionInput
                    id="quantity-query-unit"
                    label={t("unit")}
                    value={unit}
                    onChange={setUnit}
                    suggestions={["m", "m²", "m³", "kg", "h", "€"]}
                    placeholder="m²"
                    hint={t("unitHint")}
                    disabled={readOnly}
                  />
                </section>
              </TabsContent>

              <TabsContent
                value="results"
                className="min-h-0 overflow-auto pr-1"
              >
                {result ? (
                  <section
                    className="space-y-2 rounded-lg border p-2"
                    data-query-results
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h3 className="text-xs font-semibold">
                          {t("results.title")}
                        </h3>
                        <p className="text-muted-foreground text-[10px]">
                          {t("results.summary", {
                            matched: result.matchedCount,
                            values: result.valueCount,
                            missing: result.missingValueCount,
                          })}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={t("results.downloadCsv")}
                        disabled={result.rows.length === 0}
                        onClick={downloadCsv}
                      >
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    {result.total !== null && (
                      <div className="rounded-md bg-primary/10 p-2">
                        <p className="text-muted-foreground text-[10px]">
                          {t("results.total")}
                        </p>
                        <p className="text-base font-semibold tabular-nums">
                          {displayValue(result.total)} {unit}
                        </p>
                      </div>
                    )}
                    <div className="flex gap-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 flex-1 text-[11px]"
                        disabled={result.rows.length === 0}
                        onClick={() => select(resultRefs(), "replace")}
                      >
                        {t("results.select")}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 flex-1 text-[11px]"
                        disabled={result.rows.length === 0}
                        onClick={() => isolate(resultRefs())}
                      >
                        {t("results.isolate")}
                      </Button>
                    </div>
                    {result.rows.length === 0 ? (
                      <p className="text-muted-foreground py-2 text-center text-[11px]">
                        {t("results.none")}
                      </p>
                    ) : (
                      <>
                        <div className="max-h-64 overflow-auto rounded-md border">
                          <table className="w-full min-w-90 text-[10px]">
                            <thead className="bg-muted sticky top-0">
                              <tr>
                                <th className="px-2 py-1.5 text-left font-medium">
                                  {t("results.element")}
                                </th>
                                <th className="px-2 py-1.5 text-left font-medium">
                                  {t("results.class")}
                                </th>
                                <th className="px-2 py-1.5 text-right font-medium">
                                  {t("results.value")}
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {result.rows.slice(0, 250).map((row) => (
                                <tr
                                  key={`${row.modelId}-${row.expressId}`}
                                  className="border-t"
                                >
                                  <td
                                    className="max-w-40 truncate px-2 py-1.5"
                                    title={`${row.modelName} · ${row.name}`}
                                  >
                                    {row.name || `#${row.expressId}`}
                                    <span className="text-muted-foreground block truncate">
                                      {row.modelName}
                                    </span>
                                  </td>
                                  <td className="px-2 py-1.5">{row.type}</td>
                                  <td className="px-2 py-1.5 text-right tabular-nums">
                                    {displayValue(row.value)}{" "}
                                    {row.value !== null ? unit : ""}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {result.rows.length > 250 && (
                          <p className="text-muted-foreground text-[10px]">
                            {t("results.previewLimit", {
                              count: result.rows.length,
                            })}
                          </p>
                        )}
                      </>
                    )}
                  </section>
                ) : (
                  <p className="text-muted-foreground rounded-lg border p-4 text-center text-[11px]">
                    {t("results.runHint")}
                  </p>
                )}
              </TabsContent>
            </Tabs>

            <Button
              className="w-full shrink-0"
              size="sm"
              disabled={running || runningList}
              onClick={runQuery}
            >
              {running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ScanSearch className="h-3.5 w-3.5" />
              )}
              {running ? t("running") : t("run")}
            </Button>
          </>
        ) : (
          <p className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center rounded-lg border p-4 text-center text-[11px]">
            {t("list.selectHint")}
          </p>
        )}
      </div>
    </div>
  );
}
