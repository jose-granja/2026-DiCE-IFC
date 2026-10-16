"use client";

/**
 * Lenses: saved ways of looking at the model, as on ifclite.com.
 *
 * A list of built-in and saved lenses — clicking one puts it on, clicking it
 * again takes it off — the legend of the one on screen, with a switch per
 * entry, and an editor for making new ones. While a lens is being edited it is
 * what the viewport shows, so each change is seen as it is made. The work of
 * drawing it is `LensSync`'s; this is the UI.
 */

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Download,
  Eye,
  EyeOff,
  Glasses,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EMPTY_ELEMENT_FILTER } from "@/lib/ifc/types";
import { UNMATCHED_ID } from "@/lib/lens/evaluate";
import { LENS_FILE_NAME, LensFileError, parseLensFile, serializeLenses } from "@/lib/lens/file";
import { paletteColour } from "@/lib/lens/palette";
import { BUILTIN_LENSES } from "@/lib/lens/presets";
import { newLensId, shownLens, useLensStore } from "@/lib/lens/store";
import type { Lens, LensAction, LensAutoSource, LensRule, LensUnmatched } from "@/lib/lens/types";
import { useModelVocabulary } from "@/lib/viewer/use-model-vocabulary";
import { cn } from "@/lib/utils";
import { ElementFilterEditor } from "./ElementFilterEditor";

const SOURCES: Array<LensAutoSource["kind"]> = [
  "class",
  "objectType",
  "predefinedType",
  "material",
  "group",
  "storey",
  "model",
  "classification",
  "property",
];

type Translate = ReturnType<typeof useTranslations>;

/** A built-in shown in the page's language; a saved lens as the user named it. */
function displayed(lens: Lens, t: Translate): Lens {
  if (!lens.builtin) return lens;
  const key = lens.id.replace(/^builtin:/, "");
  const name = t(`builtin.${key}.name`);
  if (lens.kind === "auto") return { ...lens, name };
  return {
    ...lens,
    name,
    rules: lens.rules.map((rule) => ({
      ...rule,
      name: t(`builtin.${key}.rules.${rule.id}`),
    })),
  };
}

export function LensPanel() {
  const t = useTranslations("viewer.lens");
  const lenses = useLensStore((s) => s.lenses);
  const activeId = useLensStore((s) => s.activeId);
  const draft = useLensStore((s) => s.draft);
  const shown = useLensStore((s) => shownLens(s));

  const create = (kind: Lens["kind"]) => {
    const id = newLensId("lens");
    useLensStore.getState().edit(
      kind === "auto"
        ? { id, name: t("newLensName"), kind: "auto", source: { kind: "class" }, unmatched: "ghost" }
        : {
            id,
            name: t("newLensName"),
            kind: "rules",
            unmatched: "ghost",
            rules: [newRule(t("newRuleName", { number: 1 }), 0)],
          },
    );
  };

  const uploadInput = useRef<HTMLInputElement>(null);

  // The saved lenses as a list someone else can upload — an office's
  // predefined set, made once and handed round. Built-ins are in every copy.
  const downloadList = () => {
    const blob = new Blob([serializeLenses(lenses)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = LENS_FILE_NAME;
    link.click();
    URL.revokeObjectURL(url);
  };

  // An uploaded list joins the library: a lens with the same id is updated,
  // so uploading a newer copy of a list replaces the old one instead of
  // doubling it, and nothing of the user's own is removed.
  const uploadList = async (file: File) => {
    try {
      const read = parseLensFile(await file.text());
      if (read.lenses.length === 0) {
        toast.warning(t("upload.empty", { name: file.name }));
        return;
      }
      const store = useLensStore.getState();
      store.merge(read.lenses, store.activeId);
      toast.success(t("upload.done", { count: read.lenses.length }));
      if (read.skipped > 0) toast.warning(t("upload.skipped", { count: read.skipped }));
    } catch (error) {
      const code = error instanceof LensFileError ? error.code : "notJson";
      toast.error(t(`upload.errors.${code}`, { name: file.name }));
    }
  };

  if (draft) return <LensEditor lens={draft} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-lens-panel>
      <div className="flex items-center justify-between gap-2 border-b p-2">
        <h2 className="flex items-center gap-1.5 text-sm">
          <Glasses className="h-4 w-4" aria-hidden />
          {t("title")}
        </h2>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={downloadList}
            disabled={lenses.length === 0}
            aria-label={t("download")}
            title={lenses.length === 0 ? t("downloadNone") : t("download")}
            data-lens-download
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => uploadInput.current?.click()}
            aria-label={t("upload.button")}
            title={t("upload.button")}
            data-lens-upload
          >
            <Upload className="h-3.5 w-3.5" />
          </Button>
          <input
            ref={uploadInput}
            type="file"
            accept=".json,application/json"
            className="hidden"
            data-lens-upload-input
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void uploadList(file);
            }}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 text-xs">
                <Plus className="h-3.5 w-3.5" />
                {t("new")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => create("rules")}>{t("newRules")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => create("auto")}>{t("newAuto")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-2">
        <p className="text-muted-foreground text-[11px]">{t("hint")}</p>

        {shown && <Legend lens={displayed(shown, t)} />}

        <LensList
          title={t("builtinTitle")}
          lenses={BUILTIN_LENSES.map((lens) => displayed(lens, t))}
          activeId={activeId}
        />
        <LensList title={t("savedTitle")} lenses={lenses} activeId={activeId} empty={t("noSaved")} />
      </div>
    </div>
  );
}

function newRule(name: string, index: number): LensRule {
  return {
    id: newLensId("rule"),
    name,
    enabled: true,
    filter: EMPTY_ELEMENT_FILTER,
    action: "colour",
    colour: paletteColour(index),
  };
}

function LensList({
  title,
  lenses,
  activeId,
  empty,
}: {
  title: string;
  lenses: Lens[];
  activeId: string | null;
  empty?: string;
}) {
  const t = useTranslations("viewer.lens");
  const store = useLensStore.getState;

  const duplicate = (lens: Lens) => {
    // The copy is what the user can change: a built-in stays as shipped.
    const copy: Lens = {
      ...structuredClone(lens),
      id: newLensId("lens"),
      name: t("copyName", { name: lens.name }),
      builtin: undefined,
    };
    store().edit(copy);
  };

  return (
    <section className="space-y-1" data-lens-list={lenses[0]?.builtin ? "builtin" : "saved"}>
      <h3 className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">{title}</h3>
      {lenses.length === 0 && empty && <p className="text-muted-foreground text-[11px]">{empty}</p>}
      <ul className="space-y-0.5">
        {lenses.map((lens) => {
          const active = lens.id === activeId;
          return (
            <li key={lens.id} className={cn("flex items-center gap-1 rounded-md", active && "bg-accent")}>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-xs"
                aria-pressed={active}
                data-lens={lens.name}
                onClick={() => store().activate(active ? null : lens.id)}
              >
                <span
                  aria-hidden
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full border",
                    active ? "bg-primary border-primary" : "border-muted-foreground",
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{lens.name}</span>
                <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px]">
                  {t(`kinds.${lens.kind}`)}
                </Badge>
              </button>
              {!lens.builtin && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  aria-label={t("edit", { name: lens.name })}
                  onClick={() => store().edit(structuredClone(lens))}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                aria-label={t("duplicate", { name: lens.name })}
                onClick={() => duplicate(lens)}
              >
                <Copy className="h-3 w-3" />
              </Button>
              {!lens.builtin && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  aria-label={t("delete", { name: lens.name })}
                  onClick={() => store().remove(lens.id)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Legend({ lens }: { lens: Lens }) {
  const t = useTranslations("viewer.lens");
  const legend = useLensStore((s) => s.legend);
  const status = useLensStore((s) => s.status);
  const error = useLensStore((s) => s.error);
  const hiddenLegend = useLensStore((s) => s.hiddenLegend);
  const editing = useLensStore((s) => s.draft !== null);

  return (
    <section className="space-y-1.5 rounded-lg border p-2" data-lens-legend>
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{lens.name}</span>
        {status === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-label={t("running")} />}
        {!editing && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px]"
            onClick={() => useLensStore.getState().activate(null)}
          >
            <X className="h-3 w-3" />
            {t("turnOff")}
          </Button>
        )}
      </div>
      {status === "failed" && error && (
        <p className="text-destructive text-[11px]" role="alert">
          {t("failed", { message: error })}
        </p>
      )}
      {status !== "failed" && legend.length === 0 && status === "ready" && (
        <p className="text-muted-foreground text-[11px]">{t("nothingToShow")}</p>
      )}
      <ul className="space-y-0.5">
        {legend.map((entry) => {
          const off = hiddenLegend.has(entry.id);
          const label = entry.id === UNMATCHED_ID ? t(`unmatchedLegend.${entry.action}`) : entry.label;
          return (
            <li
              key={entry.id}
              className={cn("flex items-center gap-1.5 text-[11px]", off && "opacity-50")}
              data-lens-legend-entry={label}
            >
              <span
                aria-hidden
                className={cn(
                  "h-3 w-3 shrink-0 rounded-sm border",
                  entry.action === "ghost" || entry.action === "transparent" ? "opacity-50" : "",
                )}
                style={{
                  backgroundColor:
                    entry.action === "hide" || entry.action === "keep" ? "transparent" : entry.colour,
                }}
              />
              <span className="min-w-0 flex-1 truncate" title={label}>
                {label}
                {entry.action === "hide" && (
                  <span className="text-muted-foreground"> · {t("actions.hide")}</span>
                )}
              </span>
              <span className="text-muted-foreground tabular-nums" data-lens-legend-count>
                {entry.count}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0"
                aria-label={t(off ? "showEntry" : "hideEntry", { name: label })}
                aria-pressed={off}
                onClick={() => useLensStore.getState().toggleLegend(entry.id)}
              >
                {off ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function LensEditor({ lens }: { lens: Lens }) {
  const t = useTranslations("viewer.lens");
  const vocabulary = useModelVocabulary();
  const update = (next: Lens) => useLensStore.getState().updateDraft(next);
  const saved = useLensStore((s) => s.lenses.some((entry) => entry.id === lens.id));

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-lens-editor>
      <div className="flex items-center justify-between gap-2 border-b p-2">
        <h2 className="text-sm">{saved ? t("editTitle") : t("newTitle")}</h2>
        <Badge variant="outline" className="text-[10px]">
          {t(`kinds.${lens.kind}`)}
        </Badge>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-2">
        <div className="space-y-1">
          <Label htmlFor="lens-name" className="text-[11px]">
            {t("name")}
          </Label>
          <Input
            id="lens-name"
            value={lens.name}
            onChange={(event) => update({ ...lens, name: event.target.value })}
            className="h-8 text-xs"
          />
        </div>

        {lens.kind === "auto" ? (
          <AutoSourceEditor
            source={lens.source}
            onChange={(source) => update({ ...lens, source })}
            systems={vocabulary.classificationSystems}
            sets={vocabulary.propertySets}
          />
        ) : (
          <section className="space-y-1.5">
            <h3 className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
              {t("rules")}
            </h3>
            <p className="text-muted-foreground text-[11px]">{t("rulesHint")}</p>
            <ul className="space-y-1.5">
              {lens.rules.map((rule, index) => (
                <RuleEditor
                  key={rule.id}
                  rule={rule}
                  first={index === 0}
                  last={index === lens.rules.length - 1}
                  vocabulary={vocabulary}
                  onChange={(next) =>
                    update({
                      ...lens,
                      rules: lens.rules.map((entry) => (entry.id === rule.id ? next : entry)),
                    })
                  }
                  onMove={(offset) => {
                    const rules = [...lens.rules];
                    const [moved] = rules.splice(index, 1);
                    rules.splice(index + offset, 0, moved);
                    update({ ...lens, rules });
                  }}
                  onRemove={() =>
                    update({
                      ...lens,
                      rules: lens.rules.filter((entry) => entry.id !== rule.id),
                    })
                  }
                />
              ))}
            </ul>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() =>
                update({
                  ...lens,
                  rules: [
                    ...lens.rules,
                    newRule(t("newRuleName", { number: lens.rules.length + 1 }), lens.rules.length),
                  ],
                })
              }
            >
              <Plus className="h-3.5 w-3.5" />
              {t("addRule")}
            </Button>
          </section>
        )}

        <div className="space-y-1">
          <Label className="text-[11px]">{t("unmatched")}</Label>
          <Select
            value={lens.unmatched}
            onValueChange={(value) => update({ ...lens, unmatched: value as LensUnmatched })}
          >
            <SelectTrigger size="sm" className="h-8 text-xs" aria-label={t("unmatched")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["ghost", "keep", "hide"] as const).map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`unmatchedOptions.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Legend lens={lens} />
      </div>

      <div className="flex justify-end gap-1.5 border-t p-2">
        <Button variant="outline" size="sm" onClick={() => useLensStore.getState().cancelDraft()}>
          {t("cancel")}
        </Button>
        <Button size="sm" onClick={() => useLensStore.getState().commitDraft()} disabled={!lens.name.trim()}>
          {t("save")}
        </Button>
      </div>
    </div>
  );
}

function RuleEditor({
  rule,
  first,
  last,
  vocabulary,
  onChange,
  onMove,
  onRemove,
}: {
  rule: LensRule;
  first: boolean;
  last: boolean;
  vocabulary: ReturnType<typeof useModelVocabulary>;
  onChange: (rule: LensRule) => void;
  onMove: (offset: number) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("viewer.lens");
  const [open, setOpen] = useState(false);

  return (
    <li className="rounded-md border" data-lens-rule={rule.name}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-1.5 p-1.5">
          <Checkbox
            checked={rule.enabled}
            onCheckedChange={(checked) => onChange({ ...rule, enabled: checked === true })}
            aria-label={t("ruleEnabled", { name: rule.name })}
          />
          <input
            type="color"
            value={rule.colour}
            onChange={(event) => onChange({ ...rule, colour: event.target.value })}
            aria-label={t("ruleColour", { name: rule.name })}
            className="h-6 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
          />
          <Input
            value={rule.name}
            onChange={(event) => onChange({ ...rule, name: event.target.value })}
            aria-label={t("ruleName")}
            className="h-7 min-w-0 flex-1 text-xs"
          />
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            disabled={first}
            aria-label={t("moveUp")}
            onClick={() => onMove(-1)}
          >
            <ArrowUp className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            disabled={last}
            aria-label={t("moveDown")}
            onClick={() => onMove(1)}
          >
            <ArrowDown className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            aria-label={t("removeRule", { name: rule.name })}
            onClick={onRemove}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
        <div className="flex items-center gap-1.5 px-1.5 pb-1.5">
          <Select
            value={rule.action}
            onValueChange={(value) => onChange({ ...rule, action: value as LensAction })}
          >
            <SelectTrigger
              size="sm"
              className="h-7 w-32 text-[11px]"
              aria-label={t("ruleAction", { name: rule.name })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["colour", "transparent", "hide"] as const).map((action) => (
                <SelectItem key={action} value={action}>
                  {t(`actions.${action}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 text-[11px]">
              {open ? t("hideFilter") : t("editFilter")}
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <div className="border-t p-1.5">
            <ElementFilterEditor
              filter={rule.filter}
              vocabulary={vocabulary}
              onChange={(filter) => onChange({ ...rule, filter })}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function AutoSourceEditor({
  source,
  onChange,
  systems,
  sets,
}: {
  source: LensAutoSource;
  onChange: (source: LensAutoSource) => void;
  systems: string[];
  sets: Map<string, string[]>;
}) {
  const t = useTranslations("viewer.lens");
  const setNames = [...sets.keys()];

  return (
    <section className="space-y-1.5">
      <div className="space-y-1">
        <Label className="text-[11px]">{t("colourBy")}</Label>
        <Select
          value={source.kind}
          onValueChange={(kind) =>
            onChange(
              kind === "property"
                ? { kind: "property", setName: "", propertyName: "" }
                : kind === "classification"
                  ? { kind: "classification", system: "" }
                  : ({ kind } as LensAutoSource),
            )
          }
        >
          <SelectTrigger size="sm" className="h-8 text-xs" aria-label={t("colourBy")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SOURCES.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {t(`sources.${kind}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {source.kind === "classification" && (
        <div className="space-y-1">
          <Label htmlFor="lens-system" className="text-[11px]">
            {t("system")}
          </Label>
          <Input
            id="lens-system"
            list="lens-system-options"
            value={source.system ?? ""}
            onChange={(event) => onChange({ kind: "classification", system: event.target.value })}
            placeholder={t("anySystem")}
            className="h-8 text-xs"
          />
          <datalist id="lens-system-options">
            {systems.map((system) => (
              <option key={system} value={system} />
            ))}
          </datalist>
        </div>
      )}

      {source.kind === "property" && (
        <div className="grid grid-cols-2 gap-1.5">
          <div className="space-y-1">
            <Label htmlFor="lens-set" className="text-[11px]">
              {t("propertySet")}
            </Label>
            <Input
              id="lens-set"
              list="lens-set-options"
              value={source.setName}
              onChange={(event) => onChange({ ...source, setName: event.target.value })}
              className="h-8 text-xs"
            />
            <datalist id="lens-set-options">
              {setNames.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>
          <div className="space-y-1">
            <Label htmlFor="lens-property" className="text-[11px]">
              {t("property")}
            </Label>
            <Input
              id="lens-property"
              list="lens-property-options"
              value={source.propertyName}
              onChange={(event) => onChange({ ...source, propertyName: event.target.value })}
              className="h-8 text-xs"
            />
            <datalist id="lens-property-options">
              {(sets.get(source.setName) ?? []).map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>
        </div>
      )}
    </section>
  );
}

export default LensPanel;
