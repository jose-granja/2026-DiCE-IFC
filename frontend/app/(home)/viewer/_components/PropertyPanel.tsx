"use client";

/**
 * Everything the model records about the selected element.
 *
 * Rebuilt from a property-set list into an information panel. An element's
 * story is wider than its `IfcPropertySet`s: what it is made of, how it is
 * classified, how much of it there is, and what its *type* defines for every
 * occurrence. Showing only property sets left the reader unable to tell whether
 * the rest was missing from the model or missing from the panel — the two look
 * identical and mean opposite things.
 *
 * A query rather than an effect: the selection is the key, so switching
 * elements cancels the previous read and there is no window where the panel
 * shows one element's name above another's properties.
 *
 * Nothing is cached beyond the current selection (`staleTime: 0`) — attribute
 * edits go through the same worker, and a stale inspector after an edit would
 * be worse than a re-read that costs ~10 ms even on a 200 MB model (ADR 001).
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronRight, Copy, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { getModelHandle } from "@/lib/viewer/loader";
import { useViewerStore } from "@/lib/viewer/store";
import type { ElementInfo, PropertySetView } from "@/lib/ifc/types";
import { cn } from "@/lib/utils";

export function PropertyPanel() {
  const t = useTranslations("viewer.propertyPanel");
  const selection = useViewerStore((s) => s.selection);
  const models = useViewerStore((s) => s.models);
  const ref = selection[selection.length - 1] ?? null;

  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const { data, isPending } = useQuery({
    queryKey: ["viewer-element", ref?.modelId ?? null, ref?.expressId ?? null],
    enabled: ref !== null,
    staleTime: 0,
    queryFn: async (): Promise<ElementInfo | null> => {
      const handle = getModelHandle(ref!.modelId);
      return handle ? handle.getElementInfo(ref!.expressId) : null;
    },
  });

  if (!ref) {
    return (
      <p className="text-muted-foreground p-3 text-xs">
        {t("selectElement")}
      </p>
    );
  }

  const model = models.find((m) => m.summary.id === ref.modelId);
  const info = data ?? null;
  const term = filter.trim().toLowerCase();

  /** Hide rows that do not match, and sections left empty by that. */
  const matches = (label: string, value: string) =>
    !term ||
    label.toLowerCase().includes(term) ||
    value.toLowerCase().includes(term);

  const visibleSets = (sets: PropertySetView[]) =>
    sets
      .map((set) => ({
        ...set,
        properties: set.properties.filter((property) =>
          matches(property.name, formatValue(property.value, t("yes"), t("no"))),
        ),
      }))
      .filter((set) => set.properties.length > 0 || matches(set.name, ""));

  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-property-panel>
      <div className="border-b p-3">
        <div className="flex items-center gap-2">
          {model && (
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: model.colour }}
            />
          )}
          <span className="text-muted-foreground truncate text-xs">
            {model?.summary.name}
          </span>
        </div>

        {isPending ? (
          <Skeleton className="mt-2 h-4 w-2/3" />
        ) : (
          <>
            <h3 className="mt-1 truncate font-medium" title={info?.attributes?.name}>
              {info?.attributes?.name || `#${ref.expressId}`}
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {info?.attributes?.type && (
                <Badge variant="secondary">{info.attributes.type}</Badge>
              )}
              <CopyableId expressId={ref.expressId} />
            </div>
          </>
        )}
      </div>

      <div className="border-b p-2">
        <div className="relative">
          <Search
            className="text-muted-foreground absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2"
            aria-hidden
          />
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t("filterProperties")}
            aria-label={t("filterProperties")}
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {isPending || !info ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : (
          <>
            <Section
              title={t("attributes")}
              collapsed={collapsed.has("attributes")}
              onToggle={() => toggle("attributes")}
            >
              <dl className="space-y-0.5 text-xs">
                {[
                  ["GlobalId", info.attributes?.globalId, true],
                  ["Description", info.attributes?.description, false],
                  ["ObjectType", info.attributes?.objectType, false],
                  ["Tag", info.attributes?.tag, false],
                ]
                  .filter(([label, value]) =>
                    matches(String(label), String(value ?? "")),
                  )
                  .map(([label, value, mono]) => (
                    <Row
                      key={String(label)}
                      label={String(label)}
                      value={value as string | undefined}
                      mono={Boolean(mono)}
                    />
                  ))}
              </dl>
            </Section>

            {info.materials.length > 0 && (
              <Section
                title={t("materials")}
                count={info.materials.length}
                collapsed={collapsed.has("materials")}
                onToggle={() => toggle("materials")}
              >
                <ul className="space-y-0.5 text-xs">
                  {info.materials
                    .filter((material) => matches(material, ""))
                    .map((material) => (
                      <li key={material} className="break-words">
                        {material}
                      </li>
                    ))}
                </ul>
              </Section>
            )}

            {info.classifications.length > 0 && (
              <Section
                title={t("classification")}
                count={info.classifications.length}
                collapsed={collapsed.has("classification")}
                onToggle={() => toggle("classification")}
              >
                <dl className="space-y-0.5 text-xs">
                  {info.classifications
                    .filter((entry) => matches(entry.system, `${entry.code} ${entry.name}`))
                    .map((entry) => (
                      <Row
                        key={`${entry.system}-${entry.code}`}
                        label={entry.system || t("classification")}
                        value={[entry.code, entry.name].filter(Boolean).join(" — ")}
                      />
                    ))}
                </dl>
              </Section>
            )}

            <PropertySets
              title={t("propertySets")}
              sets={visibleSets(info.propertySets)}
              empty={t("noPropertySets")}
              collapsed={collapsed}
              onToggle={toggle}
            />

            {info.quantities.length > 0 && (
              <PropertySets
                title={t("quantities")}
                sets={visibleSets(info.quantities)}
                collapsed={collapsed}
                onToggle={toggle}
              />
            )}

            {info.typeProperties.length > 0 && (
              <PropertySets
                title={t("fromItsType")}
                // Worth separating: these are shared by every occurrence of the
                // type, so editing one is not a local change.
                hint={t("fromItsTypeHint")}
                sets={visibleSets(info.typeProperties)}
                collapsed={collapsed}
                onToggle={toggle}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function PropertySets({
  title,
  sets,
  empty,
  hint,
  collapsed,
  onToggle,
}: {
  title: string;
  sets: PropertySetView[];
  empty?: string;
  hint?: string;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
}) {
  const t = useTranslations("viewer.propertyPanel");
  if (sets.length === 0 && !empty) return null;

  return (
    <Section
      title={title}
      count={sets.length || undefined}
      collapsed={collapsed.has(title)}
      onToggle={() => onToggle(title)}
    >
      {hint && <p className="text-muted-foreground mb-1.5 text-[11px]">{hint}</p>}
      {sets.length === 0 ? (
        <p className="text-muted-foreground text-xs">{empty}</p>
      ) : (
        <div className="space-y-2.5">
          {sets.map((set, setIndex) => (
            <div key={`${set.globalId ?? set.name}:${setIndex}`}>
              <p className="text-xs font-medium">{set.name}</p>
              <dl className="mt-1 space-y-0.5 text-xs">
                {set.properties.map((property, propertyIndex) => (
                  <Row
                    key={`${property.name}:${propertyIndex}`}
                    label={property.name}
                    value={formatValue(property.value, t("yes"), t("no"))}
                  />
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function Section({
  title,
  count,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  count?: number;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b" data-section={title}>
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={onToggle}
        className="hover:bg-accent/50 flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs font-medium"
      >
        <ChevronRight
          className={cn("h-3.5 w-3.5 transition-transform", !collapsed && "rotate-90")}
          aria-hidden
        />
        {title}
        {count !== undefined && (
          <span className="text-muted-foreground ml-auto text-[11px] font-normal">
            {count}
          </span>
        )}
      </button>
      {!collapsed && <div className="px-3 pb-3">{children}</div>}
    </section>
  );
}

/** The express id, with a copy button — it is what people paste into scripts. */
function CopyableId({ expressId }: { expressId: number }) {
  const t = useTranslations("viewer.propertyPanel");
  const [copied, setCopied] = useState(false);

  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-muted-foreground h-5 gap-1 px-1 font-mono text-[11px]"
      onClick={() => {
        void navigator.clipboard?.writeText(String(expressId));
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      aria-label={t("copyExpressId", { id: expressId })}
    >
      #{expressId}
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </Button>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value?: string | null;
  mono?: boolean;
}) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[minmax(0,7rem)_1fr] gap-2">
      <dt className="text-muted-foreground truncate" title={label}>
        {label}
      </dt>
      <dd className={mono ? "font-mono break-all" : "break-words"}>{value}</dd>
    </div>
  );
}

function formatValue(
  value: string | number | boolean | null,
  yes: string,
  no: string,
): string {
  if (value === null) return "";
  // IFC booleans must read as booleans, not as "true"/"1" ambiguity.
  if (typeof value === "boolean") return value ? yes : no;
  return String(value);
}

export default PropertyPanel;
