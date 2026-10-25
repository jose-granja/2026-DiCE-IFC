"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useQueries } from "@tanstack/react-query";
import {
  Calculator,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Download,
  FileSpreadsheet,
  Filter,
  ListPlus,
  Loader2,
  Maximize2,
  Pencil,
  Plus,
  Play,
  ScanSearch,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { getActiveRenderer } from "@/lib/viewer/active-renderer";
import { PanelHeader } from "./PanelHeader";
import { useDisplaySettingsStore } from "@/lib/viewer/display-settings";
import { DEFAULT_PROPERTY_DECIMALS, MAX_PROPERTY_DECIMALS } from "@/lib/viewer/property-format";
import {
  MAX_QUANTITY_LEVEL,
  elementsUnder,
  groupQuery,
  isGroupQuery,
  linesUnder,
  newLinePlacement,
  quantityHierarchy,
  quantityLevel,
  visibleQuantityLines,
} from "@/lib/spreadsheets/quantity-hierarchy";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
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
import { DEFAULT_QUANTITY_TEMPLATE_URL, readDefaultQuantityTemplate } from "@/lib/spreadsheets/quantity-template";
import { getModelHandle } from "@/lib/viewer/loader";
import { useViewerStore, type EntityRef } from "@/lib/viewer/store";
import { classificationCodesFor } from "@/lib/viewer/use-model-vocabulary";
import {
  QUERY_LIST_CHANGED_EVENT,
  QUERY_LIST_STORAGE_KEY,
  readStoredQueryList,
  type StoredQueryListItem,
} from "@/lib/viewer/quantity-list-storage";

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
  /** Hierarchy level, 1 at the top (`quantity-hierarchy.ts`). */
  level: number;
  code: string;
  description: string;
  query: QuantityQuery;
  result: CombinedResult | null;
};

let rowSequence = 1;
const rowId = (prefix: string) => `${prefix}-${++rowSequence}`;
const splitValues = splitTextList;

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const numberFormats = new Map<number, Intl.NumberFormat>();

/**
 * A value as the panel shows it: numbers rounded to the viewer's "Decimal
 * places" setting, as the properties panel does. Display only — the results,
 * the CSV and the workbook keep full precision.
 */
function displayValue(value: PropertyValue, decimalPlaces: number) {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    const digits =
      Number.isInteger(decimalPlaces) && decimalPlaces >= 0 && decimalPlaces <= MAX_PROPERTY_DECIMALS
        ? decimalPlaces
        : DEFAULT_PROPERTY_DECIMALS;
    let format = numberFormats.get(digits);
    if (!format) {
      // "negative": a small negative rounded to zero reads "0", not "-0".
      format = new Intl.NumberFormat(undefined, { maximumFractionDigits: digits, signDisplay: "negative" });
      numberFormats.set(digits, format);
    }
    return format.format(value);
  }
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
  const locale = useLocale();
  const models = useViewerStore((state) => state.models);
  const select = useViewerStore((state) => state.select);
  const isolate = useViewerStore((state) => state.isolate);
  const hiddenKeys = useViewerStore((state) => state.hidden);
  const decimalPlaces = useDisplaySettingsStore((state) => state.propertyDecimalPlaces);
  // The list in a dialog, with the selected line beside it — room to read a long list.
  const [listDialogOpen, setListDialogOpen] = useState(false);
  const [listSearch, setListSearch] = useState("");
  const workbookInput = useRef<HTMLInputElement>(null);
  const templateRequest = useRef<AbortController | null>(null);
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
  const [queryLevel, setQueryLevel] = useState(1);
  // A grouping line: a heading with no filter and no quantity, never run.
  const [queryIsGroup, setQueryIsGroup] = useState(false);
  // Where "New" puts its line: after the selected line's branch, or under it.
  const [newPlacement, setNewPlacement] = useState<{ index: number; level: number } | null>(null);
  // Lines whose branch is folded away, by id.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // The list an Excel import replaced, for Undo. Shown in the list rather than
  // on the toast: the list window is modal, and a toast is outside it.
  const [lastReplace, setLastReplace] = useState<
    { list: QueryListItem[]; previous: QueryListItem[]; previousId: string | null } | null
  >(null);
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
  const [loadingTemplate, setLoadingTemplate] = useState(false);
  const [exportingWorkbook, setExportingWorkbook] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CombinedResult | null>(null);
  const [editorTab, setEditorTab] = useState<"filters" | "values" | "results">(
    "filters",
  );

  useEffect(() => () => templateRequest.current?.abort(), []);

  // Query definitions are small, user-authored data. Keep them local so a
  // list survives switching viewer tabs or reopening the page; model-derived
  // result rows can be large and are deliberately recalculated instead.
  useEffect(() => {
    const adopt = (stored: StoredQueryListItem[]) =>
      setQueryItems(
        stored.map((item, index) => ({
          id: item.id,
          level: quantityLevel(item.level),
          code: item.code ?? "",
          description:
            item.description ??
            item.name ??
            t("list.defaultDescription", { number: index + 1 }),
          query: item.query,
          result: null,
        })),
      );
    const timeout = window.setTimeout(() => {
      // A corrupt local draft reads as an empty list, so a new one can be built.
      adopt(readStoredQueryList());
      setQueryListLoaded(true);
    }, 0);
    // A restored project replaces the list while this panel may be open.
    const onReplaced = (event: Event) => {
      templateRequest.current?.abort();
      templateRequest.current = null;
      setLoadingTemplate(false);
      adopt((event as CustomEvent<StoredQueryListItem[]>).detail);
      setEditingItemId(null);
      setResult(null);
    };
    window.addEventListener(QUERY_LIST_CHANGED_EVENT, onReplaced);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener(QUERY_LIST_CHANGED_EVENT, onReplaced);
    };
    // `t` is only read for a default description.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!queryListLoaded) return;
    try {
      const definitions = queryItems.map(
        ({ id, level, code, description, query }) => ({
          id,
          level,
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
    if (queryIsGroup) return groupQuery();
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
    if (ready.length === 0 || queryIsGroup) return;
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
    const placement = newLinePlacement(queryItems, editingItemId);
    setNewPlacement(placement);
    setQueryLevel(placement.level);
    setQueryIsGroup(false);
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
    setQueryLevel(item.level);
    setQueryIsGroup(isGroupQuery(item.query));
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
    const level = quantityLevel(queryLevel);
    if (editingItemId && editorMode === "edit") {
      setQueryItems((current) =>
        current.map((item) =>
          item.id === editingItemId
            ? { ...item, level, code, description, query, result: null }
            : item,
        ),
      );
      setResult(null);
      setEditorMode("view");
      return;
    }
    const item: QueryListItem = {
      id: rowId("query"),
      level,
      code,
      description,
      query,
      result: null,
    };
    const at = newPlacement?.index ?? queryItems.length;
    setQueryItems((current) => [...current.slice(0, at), item, ...current.slice(at)]);
    setNewPlacement(null);
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
    // Beside the original, after anything under it — not at the end of the list,
    // where it would land under some other chapter.
    setQueryItems((current) => {
      const at = current.findIndex((item) => item.id === source.id);
      if (at < 0) return [...current, copy];
      const end = at + 1 + quantityHierarchy(current)[at].descendants;
      return [...current.slice(0, end), copy, ...current.slice(end)];
    });
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
      // A heading is not run: it has nothing to select and nothing to measure.
      if (isGroupQuery(item.query)) {
        completed.push({ ...item, result: null });
        continue;
      }
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
        level: quantityLevel(definition.level),
        id: rowId("query"),
        result: null,
      }));
      // A workbook is the whole list, as it is everywhere else (a project's
      // quantities, Download Excel): loading one replaces what is open, with an
      // Undo for the list that was there.
      const previous = queryItems;
      setQueryItems(imported);
      setCollapsed(new Set());
      setNewPlacement(null);
      setLastReplace(previous.length > 0 ? { list: imported, previous, previousId: editingItemId } : null);
      loadItem(imported[0], "view");
      // A replacement is announced by its Undo bar in the list; a toast as well
      // would say it twice.
      if (previous.length === 0) toast.success(t("workbook.imported", { count: imported.length }));
    } catch {
      setError(t("workbook.importFailed"));
    } finally {
      setImportingWorkbook(false);
      if (workbookInput.current) workbookInput.current.value = "";
    }
  };

  const loadDefaultTemplate = async () => {
    if (templateRequest.current || !queryListLoaded || importingWorkbook || exportingWorkbook || running || runningList) return;
    const request = new AbortController();
    templateRequest.current = request;
    setLoadingTemplate(true);
    setError(null);
    try {
      // A bundled public asset; no model or user data is sent with this request.
      const response = await fetch(DEFAULT_QUANTITY_TEMPLATE_URL, { signal: request.signal });
      if (!response.ok) throw new Error("Template unavailable.");
      const definitions = readDefaultQuantityTemplate(new Uint8Array(await response.arrayBuffer()), locale);
      request.signal.throwIfAborted();
      const existingIds = new Set(queryItems.map((item) => item.id));
      const imported: QueryListItem[] = definitions.filter((item) => !existingIds.has(item.id))
        .map((item) => ({ ...item, level: quantityLevel(item.level), result: null }));
      if (!imported.length) {
        toast.info(t("template.alreadyLoaded"));
        return;
      }
      setQueryItems((current) => {
        const ids = new Set(current.map((item) => item.id));
        return [...current, ...imported.filter((item) => !ids.has(item.id))];
      });
      loadItem(imported[0], "view");
      toast.success(t("template.loaded", { count: imported.length }));
    } catch {
      if (!request.signal.aborted) setError(t("template.failed"));
    } finally {
      if (templateRequest.current === request) templateRequest.current = null;
      if (!request.signal.aborted) setLoadingTemplate(false);
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

  // The isolation a row click made, so a second click on the same row — and
  // only that — undoes it, leaving any isolation set elsewhere alone (§9).
  const [focus, setFocus] = useState<{ isolated: Set<string>; key: string } | null>(null);
  const isolated = useViewerStore((state) => state.isolated);
  const focusedKey = focus && isolated === focus.isolated ? focus.key : null;

  /**
   * Show one result element in context: the query's whole result isolated,
   * this element solid and selected, the rest see-through, and the camera on it.
   */
  const focusRow = (ref: EntityRef, refs: EntityRef[] = resultRefs()) => {
    const store = useViewerStore.getState();
    const key = `${ref.modelId}#${ref.expressId}`;
    if (focusedKey === key) {
      store.clearIsolation();
      setFocus(null);
      return;
    }
    store.isolate(
      refs,
      "replace",
      refs.filter((other) => other.modelId !== ref.modelId || other.expressId !== ref.expressId),
    );
    setFocus({ isolated: useViewerStore.getState().isolated!, key });
    store.select([ref], "replace");
    // The bounds only reflect the isolation once the renderer has drawn with it.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const renderer = getActiveRenderer();
        renderer?.fitToBounds(renderer.boundsOfRefs([ref]));
      }),
    );
  };

  // ---- a grouping line: the elements of every measured line under it
  const selectedGroup =
    queryIsGroup && editingItemId ? (queryItems.find((item) => item.id === editingItemId) ?? null) : null;
  const groupLines = selectedGroup ? linesUnder(queryItems, selectedGroup.id).map((index) => queryItems[index]) : [];
  const pendingLines = groupLines.filter((item) => !item.result);
  const pendingKey = pendingLines.map((item) => item.id).join("|");
  const [groupError, setGroupError] = useState<string | null>(null);
  const groupRun = useRef<string | null>(null);
  const groupElements = elementsUnder(
    groupLines
      .filter((item) => item.result)
      .map((item) => ({ label: item.code || item.description, rows: item.result!.rows })),
  );
  const groupRefs = groupElements.map(({ row }) => ({ modelId: row.modelId, expressId: row.expressId }));
  const groupHidden = groupRefs.length > 0 && groupRefs.every((ref) => hiddenKeys.has(`${ref.modelId}#${ref.expressId}`));

  // Lines under the group that have not been run are run now, once each, and
  // keep their results — the list shows their values too.
  useEffect(() => {
    if (!selectedGroup || !pendingKey || ready.length === 0 || runningList) return;
    const key = `${selectedGroup.id}:${pendingKey}`;
    if (groupRun.current === key) return;
    groupRun.current = key;
    void (async () => {
      try {
        const done = new Map<string, CombinedResult>();
        for (const item of pendingLines) done.set(item.id, await evaluateQuery(item.query));
        setGroupError(null);
        setQueryItems((current) =>
          current.map((item) => (done.has(item.id) ? { ...item, result: done.get(item.id)! } : item)),
        );
      } catch (cause) {
        setGroupError(cause instanceof Error ? cause.message : t("errors.run"));
      } finally {
        if (groupRun.current === key) groupRun.current = null;
      }
    })();
    // `pendingKey` stands for `pendingLines`; the evaluator reads the models it runs on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroup?.id, pendingKey, ready.length, runningList]);

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
      <div className="flex min-h-0 flex-1 flex-col">
        <PanelHeader tab="quantities" />
        <p className="text-muted-foreground p-3 text-xs">{t("loadModel")}</p>
      </div>
    );
  }

  const search = listSearch.trim().toLocaleLowerCase();
  const shownItems = search
    ? queryItems.filter((item) =>
        `${item.code ?? ""} ${item.description}`.toLocaleLowerCase().includes(search),
      )
    : queryItems;

  const readOnly = editorMode === "view";
  const hasEditor = editorMode !== "idle";

  const undoReplace = () => {
    if (!lastReplace) return;
    const { previous, previousId } = lastReplace;
    setLastReplace(null);
    setQueryItems(previous);
    setCollapsed(new Set());
    const restored = previous.find((item) => item.id === previousId);
    if (restored) loadItem(restored, "view");
    else {
      setEditingItemId(null);
      setEditorMode("idle");
      setResult(null);
    }
  };
  // Only while the list is still the one imported: an edit or a run makes it a
  // new list, and undoing past that would lose the work.
  const replaceNotice = lastReplace && lastReplace.list === queryItems && (
    <div
      role="status"
      className="bg-muted/60 flex items-center gap-2 rounded-md px-2 py-1 text-[11px]"
      data-query-undo-import
    >
      <span className="min-w-0 flex-1">
        {t("workbook.replaced", { count: lastReplace.list.length, previous: lastReplace.previous.length })}
      </span>
      <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={undoReplace}>
        {t("workbook.undo")}
      </Button>
      <Button type="button" size="icon" variant="ghost" className="h-6 w-6" aria-label={t("workbook.dismiss")}
        onClick={() => setLastReplace(null)}>
        <X className="h-3 w-3" />
      </Button>
    </div>
  );

  const hierarchy = quantityHierarchy(queryItems);
  const indexById = new Map(queryItems.map((item, index) => [item.id, index]));
  const hasHierarchy = hierarchy.some((line) => line.descendants > 0);
  const visibleLines = visibleQuantityLines(queryItems, collapsed).map((index) => queryItems[index]);
  const toggleCollapsed = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const collapseAll = () =>
    setCollapsed(new Set(queryItems.filter((_, index) => hierarchy[index].descendants > 0).map((item) => item.id)));
  const expandAll = () => setCollapsed(new Set());

  /**
   * One line of the query list. `wide` is the dialog's version: the level and
   * the code in columns of their own and the description in full instead of
   * truncated. Lines are indented by level; one with lines under it can fold
   * them away, and a grouping line is a heading with no value.
   */
  const renderListItem = (item: (typeof queryItems)[number], wide: boolean) => {
    const line = hierarchy[indexById.get(item.id) ?? 0];
    const group = isGroupQuery(item.query);
    const folded = collapsed.has(item.id);
    return (
                <div
                  key={item.id}
                  role="listitem"
                  aria-current={item.id === editingItemId ? "true" : undefined}
                  aria-level={line.level}
                  data-query-level={line.level}
                  data-query-group={group ? "true" : undefined}
                  className={`flex w-full items-center rounded-md border transition-colors ${wide ? "text-xs" : "text-[11px]"} ${item.id === editingItemId ? "border-primary bg-primary/10" : group ? "bg-muted/40 hover:bg-muted/70" : "hover:bg-muted/50"}`}
                >
                  {wide && (
                    <>
                      <span className="text-muted-foreground w-10 shrink-0 text-center tabular-nums" data-query-level-cell>
                        {line.level}
                      </span>
                      {/* Level and code stay columns; only the description steps in. */}
                      <span
                        className="text-muted-foreground w-28 shrink-0 cursor-pointer truncate px-2 font-mono"
                        onClick={() => loadItem(item, "view")}
                      >
                        {item.code || "—"}
                      </span>
                    </>
                  )}
                  {(hasHierarchy || line.level > 1) && (
                    <>
                      <span aria-hidden className="shrink-0" style={{ width: (line.level - 1) * (wide ? 16 : 10) }} />
                      {line.descendants > 0 ? (
                        <button
                          type="button"
                          className="hover:bg-muted flex h-5 w-5 shrink-0 items-center justify-center rounded"
                          aria-expanded={!folded}
                          aria-label={t(folded ? "list.expand" : "list.collapse", { description: item.description })}
                          title={t(folded ? "list.expand" : "list.collapse", { description: item.description })}
                          onClick={() => toggleCollapsed(item.id)}
                          data-query-toggle
                        >
                          {folded ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        </button>
                      ) : (
                        <span aria-hidden className="w-5 shrink-0" />
                      )}
                    </>
                  )}
                  <button
                    type="button"
                    className={`flex min-w-0 flex-1 items-center justify-between gap-2 text-left ${wide ? "px-2 py-1.5" : "px-1 py-0.5"}`}
                    aria-label={t("list.viewItem", {
                      description: item.description,
                    })}
                    // The row truncates; the whole code and description on hover.
                    title={item.code ? `${item.code} · ${item.description}` : item.description}
                    onClick={() => loadItem(item, "view")}
                  >
                    {wide ? (
                      <span className={`min-w-0 flex-1 break-words whitespace-normal ${group ? "font-semibold" : "font-medium"}`}>
                        {item.description}
                      </span>
                    ) : (
                      <span className={`min-w-0 truncate ${group ? "font-semibold" : "font-medium"}`}>
                        {item.code && (
                          <span className="text-muted-foreground mr-1.5 font-mono">
                            {item.code}
                          </span>
                        )}
                        {item.description}
                      </span>
                    )}
                    <span className="text-muted-foreground shrink-0 tabular-nums">
                      {group
                        ? folded
                          ? t("list.groupLines", { count: line.descendants })
                          : ""
                        : item.result
                        ? item.result.total !== null
                          ? `${displayValue(item.result.total, decimalPlaces)} ${item.query.unit ?? ""}`
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
    );
  };

  // The selected line's code and description — editable, or shown.
  const metadataBlock = (
    <>
          {(editorMode === "new" || editorMode === "edit") && (
            <div className="space-y-1 border-t pt-2" data-query-metadata-editor>
              <div className="grid grid-cols-[3.25rem_minmax(5rem,0.7fr)_minmax(0,1.3fr)] gap-1.5">
                <div className="space-y-1">
                  <Label htmlFor="quantity-query-level" className="text-[11px]">
                    {t("list.level")}
                  </Label>
                  <Input
                    id="quantity-query-level"
                    type="number"
                    min={1}
                    max={MAX_QUANTITY_LEVEL}
                    step={1}
                    value={queryLevel}
                    onChange={(event) => setQueryLevel(quantityLevel(event.target.value))}
                    className="h-8 min-w-0 px-2 text-xs tabular-nums"
                  />
                </div>
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
              <label className="flex items-start gap-2 py-1 text-[11px]">
                <input
                  type="checkbox"
                  className="accent-primary mt-0.5"
                  checked={queryIsGroup}
                  onChange={(event) => setQueryIsGroup(event.target.checked)}
                  data-query-group-toggle
                />
                <span>
                  {t("group.toggle")}
                  <span className="text-muted-foreground block text-[10px]">{t("group.toggleHint")}</span>
                </span>
              </label>
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
              className="grid grid-cols-[3.25rem_minmax(5rem,0.7fr)_minmax(0,1.3fr)] gap-1.5 border-t pt-2 text-[11px]"
              data-query-metadata-view
            >
              <div className="min-w-0">
                <p className="text-muted-foreground text-[10px]">
                  {t("list.level")}
                </p>
                <p className="tabular-nums">{queryLevel}</p>
              </div>
              <div className="min-w-0">
                <p className="text-muted-foreground text-[10px]">
                  {t("list.code")}
                </p>
                <p className="truncate font-mono" title={queryCode || undefined}>
                  {queryCode || "—"}
                </p>
              </div>
              <div className="min-w-0">
                <p className="text-muted-foreground text-[10px]">
                  {t("list.description")}
                </p>
                <p className="truncate font-medium" title={queryDescription}>
                  {queryDescription}
                </p>
              </div>
            </div>
          )}
    </>
  );

  // The selected line's filters, values and results, and the button that runs it.
  const editorBlock = (
    <>
        {error && (
          <p
            role="alert"
            className="text-destructive shrink-0 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-[11px]"
          >
            {error}
          </p>
        )}

        {hasEditor && queryIsGroup && selectedGroup ? (
          <section
            className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden rounded-lg border p-2"
            data-query-group-elements
          >
            <div>
              <h3 className="flex items-center gap-1.5 text-xs font-semibold">
                {t("group.elementsTitle")}
                {pendingLines.length > 0 && !groupError && (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                )}
              </h3>
              <p className="text-muted-foreground text-[10px]" role="status">
                {groupLines.length === 0
                  ? t("group.noLines")
                  : pendingLines.length > 0 && !groupError
                    ? t("group.running", { count: pendingLines.length })
                    : t("group.summary", { elements: groupElements.length, lines: groupLines.length })}
              </p>
              {groupError && (
                <p role="alert" className="text-destructive text-[11px]">
                  {groupError}
                </p>
              )}
            </div>
            {groupElements.length > 0 && (
              <>
                <div className="flex gap-1.5">
                  <Button type="button" variant="outline" size="sm" className="h-7 flex-1 text-[11px]"
                    onClick={() => select(groupRefs, "replace")}>
                    {t("results.select")}
                  </Button>
                  <Button type="button" variant="outline" size="sm" className="h-7 flex-1 text-[11px]"
                    onClick={() => isolate(groupRefs)}>
                    {t("results.isolate")}
                  </Button>
                  <Button type="button" variant="outline" size="sm" className="h-7 flex-1 text-[11px]"
                    aria-pressed={groupHidden}
                    onClick={() => {
                      const store = useViewerStore.getState();
                      if (groupHidden) store.show(groupRefs);
                      else store.hide(groupRefs);
                    }}
                    data-query-group-hide>
                    {groupHidden ? t("group.show") : t("group.hide")}
                  </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto rounded-md border">
                  <table className="w-full min-w-90 text-[10px]">
                    <thead className="bg-muted sticky top-0">
                      <tr>
                        <th className="px-2 py-1.5 text-left font-medium">{t("results.element")}</th>
                        <th className="px-2 py-1.5 text-left font-medium">{t("results.class")}</th>
                        <th className="px-2 py-1.5 text-left font-medium">{t("group.lines")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupElements.slice(0, 250).map(({ row, lines }) => {
                        const ref = { modelId: row.modelId, expressId: row.expressId };
                        const key = `${row.modelId}#${row.expressId}`;
                        const focused = focusedKey === key;
                        return (
                          <tr
                            key={key}
                            className={`cursor-pointer border-t transition-colors ${focused ? "bg-primary/15" : "hover:bg-muted/50"} ${hiddenKeys.has(key) ? "opacity-50" : ""}`}
                            tabIndex={0}
                            aria-current={focused ? "true" : undefined}
                            title={t("results.focus")}
                            data-query-group-element={key}
                            onClick={() => focusRow(ref, groupRefs)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                focusRow(ref, groupRefs);
                              }
                            }}
                          >
                            <td className="max-w-40 truncate px-2 py-1.5" title={`${row.modelName} · ${row.name}`}>
                              {row.name || `#${row.expressId}`}
                              <span className="text-muted-foreground block truncate">{row.modelName}</span>
                            </td>
                            <td className="px-2 py-1.5">{row.type}</td>
                            <td className="text-muted-foreground max-w-32 truncate px-2 py-1.5 font-mono" title={lines.join(", ")}>
                              {lines.join(", ")}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {groupElements.length > 250 && (
                  <p className="text-muted-foreground text-[10px]">
                    {t("group.previewLimit", { count: groupElements.length })}
                  </p>
                )}
              </>
            )}
          </section>
        ) : hasEditor && queryIsGroup ? (
          <p
            className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center rounded-lg border border-dashed p-4 text-center text-[11px]"
            data-query-group-note
          >
            {t("group.note")}
          </p>
        ) : hasEditor ? (
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
                    // placeholder="Concrete"
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
                          {displayValue(result.total, decimalPlaces)} {unit}
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
                              {result.rows.slice(0, 250).map((row) => {
                                const ref = { modelId: row.modelId, expressId: row.expressId };
                                const focused = focusedKey === `${row.modelId}#${row.expressId}`;
                                return (
                                <tr
                                  key={`${row.modelId}-${row.expressId}`}
                                  className={`cursor-pointer border-t transition-colors ${focused ? "bg-primary/15" : "hover:bg-muted/50"}`}
                                  tabIndex={0}
                                  aria-current={focused ? "true" : undefined}
                                  title={t("results.focus")}
                                  data-query-result-row={`${row.modelId}#${row.expressId}`}
                                  onClick={() => focusRow(ref)}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                      event.preventDefault();
                                      focusRow(ref);
                                    }
                                  }}
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
                                    {displayValue(row.value, decimalPlaces)}{" "}
                                    {row.value !== null ? unit : ""}
                                  </td>
                                </tr>
                                );
                              })}
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
              disabled={running || runningList || loadingTemplate}
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
    </>
  );

  return (
    <div
      className="flex min-h-0 flex-1 max-h-[-webkit-fill-available] flex-col"
      data-quantity-query-panel
    >
      <PanelHeader tab="quantities" busy={vocabularyQueries.some((query) => query.isLoading)}>
          <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  aria-label={t("dialog.open")}
                  onClick={() => setListDialogOpen(true)}
                  data-query-list-expand
                >
                  <Maximize2 className="h-3 w-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("dialog.open")}</p>
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
                disabled={queryItems.length === 0 || runningList || loadingTemplate}
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
                disabled={importingWorkbook || loadingTemplate}
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
                disabled={queryItems.length === 0 || exportingWorkbook || loadingTemplate}
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
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" size="sm" variant="ghost" className="h-7 text-[11px]"
              title={t("template.hint")} aria-label={t("template.use")}
              disabled={!queryListLoaded || loadingTemplate || importingWorkbook || exportingWorkbook || running || runningList}
              onClick={() => void loadDefaultTemplate()} data-quantity-template-use>
              {loadingTemplate ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <FileSpreadsheet className="h-3 w-3" aria-hidden />}
            </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("template.use")}</p>
            </TooltipContent>
          </Tooltip>
      </PanelHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2">
        <input
          ref={workbookInput}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          disabled={loadingTemplate}
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold">
              <ListPlus className="h-3.5 w-3.5" />
              {t("list.title")}
            </h3>
            <div className="flex items-center gap-1">
              <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                aria-label={t("list.new")}
                disabled={loadingTemplate}
                onClick={resetEditor}
              >
                <Plus className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("list.new")}</p>
            </TooltipContent>
          </Tooltip>
            {hasHierarchy && (
              <>
                <Button type="button" size="icon" variant="ghost" className="h-7 w-7"
                  aria-label={t("list.collapseAll")} title={t("list.collapseAll")} onClick={collapseAll}>
                  <ChevronsDownUp className="h-3 w-3" />
                </Button>
                <Button type="button" size="icon" variant="ghost" className="h-7 w-7"
                  aria-label={t("list.expandAll")} title={t("list.expandAll")} onClick={expandAll}>
                  <ChevronsUpDown className="h-3 w-3" />
                </Button>
              </>
            )}
            
            
            </div>
          </div>
          {!listDialogOpen && replaceNotice}

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
              {visibleLines.map((item) => renderListItem(item, false))}
            </div>
          )}
          {!listDialogOpen && metadataBlock}
        </section>

        {listDialogOpen ? (
          <p className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center rounded-lg border p-4 text-center text-[11px]">
            {t("dialog.editingThere")}
          </p>
        ) : (
          editorBlock
        )}
      </div>

      <Dialog open={listDialogOpen} onOpenChange={setListDialogOpen}>
        <DialogContent
          // Full width: the dialog primitive caps itself at sm:max-w-lg, so the cap
          // is overridden at that breakpoint too, or it stays 512 px wide.
          className="flex h-[85vh] max-h-[95vh] w-full max-w-[calc(100%-2rem)] flex-col gap-3 p-4 sm:max-w-[calc(100%-2rem)]"
          data-query-list-dialog
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5 text-base">
              <Calculator className="h-4 w-4" aria-hidden />
              {t("dialog.title")}
            </DialogTitle>
            <DialogDescription>{t("dialog.hint")}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={listSearch}
              onChange={(event) => setListSearch(event.target.value)}
              placeholder={t("dialog.search")}
              aria-label={t("dialog.search")}
              className="h-8 max-w-xs text-xs"
            />
            <span className="text-muted-foreground text-xs tabular-nums">
              {t("dialog.count", { shown: shownItems.length, total: queryItems.length })}
            </span>
            <div className="ml-auto flex gap-1.5">
              {hasHierarchy && (
                <>
                  <Button type="button" size="sm" variant="ghost" className="h-8 text-xs" onClick={collapseAll}>
                    <ChevronsDownUp className="h-3.5 w-3.5" />
                    {t("list.collapseAll")}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" className="h-8 text-xs" onClick={expandAll}>
                    <ChevronsUpDown className="h-3.5 w-3.5" />
                    {t("list.expandAll")}
                  </Button>
                </>
              )}
              <Button type="button" size="sm" variant="outline" className="h-8 text-xs"
                disabled={loadingTemplate} onClick={resetEditor}>
                <Plus className="h-3.5 w-3.5" />
                {t("list.new")}
              </Button>
              <Button type="button" size="sm" variant="outline" className="h-8 text-xs"
                disabled={queryItems.length === 0 || runningList || loadingTemplate} onClick={runAll}>
                {runningList ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                {t("list.runAll")}
              </Button>
              <Button type="button" size="sm" variant="outline" className="h-8 text-xs"
                title={t("workbook.import")} aria-label={t("workbook.import")}
                disabled={importingWorkbook || loadingTemplate}
                onClick={() => workbookInput.current?.click()} data-query-dialog-import>
                {importingWorkbook ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                {t("dialog.import")}
              </Button>
              <Button type="button" size="sm" variant="outline" className="h-8 text-xs"
                title={t("workbook.download")} aria-label={t("workbook.download")}
                disabled={queryItems.length === 0 || exportingWorkbook || loadingTemplate}
                onClick={() => void downloadWorkbook()} data-query-dialog-download>
                {exportingWorkbook ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                {t("dialog.download")}
              </Button>
            </div>
          </div>
          {replaceNotice}

          <div className="flex flex-row min-h-0 flex-1 gap-3">
            <div
              className="min-h-0 space-y-1 grow overflow-auto rounded-lg border p-2"
              role="list"
              aria-label={t("list.title")}
              data-query-list-dialog-items
            >
              {queryItems.length > 0 && (
                <div className="text-muted-foreground flex items-center px-px pb-1 text-[11px] font-medium" aria-hidden>
                  <span className="w-10 shrink-0 text-center">{t("list.level")}</span>
                  <span className="w-28 shrink-0 px-2">{t("list.code")}</span>
                  {hasHierarchy && <span className="w-5 shrink-0" />}
                  <span className="flex-1 px-2">{t("list.description")}</span>
                  <span className="pr-24">{t("dialog.value")}</span>
                </div>
              )}
              {queryItems.length === 0 ? (
                <p className="text-muted-foreground p-2 text-xs">{t("list.empty")}</p>
              ) : shownItems.length === 0 ? (
                <p className="text-muted-foreground p-2 text-xs">{t("dialog.noMatch")}</p>
              ) : (
                // A search shows every match, folded or not.
                (search ? shownItems : visibleLines).map((item) => renderListItem(item, true))
              )}
            </div>
            <aside
              className="flex min-h-0 flex-col max-w-[30%] gap-2 overflow-auto rounded-lg border p-2"
              aria-label={t("dialog.selected")}
              data-query-list-dialog-editor
            >
              {metadataBlock}
              {editorBlock}
            </aside>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
