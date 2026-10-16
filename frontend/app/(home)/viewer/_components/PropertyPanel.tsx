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
 * Each of those six things — attributes, materials, property sets, quantities,
 * what the type defines, classification — is its own tab rather than a stacked,
 * scrolling list. They answer different questions and rarely need reading
 * together, and a long property-set list used to push classification and type
 * data out of view entirely.
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
import { Check, Component, Copy, Info, Layers, ListChecks, Search, Sigma, Tag } from "lucide-react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getModelHandle } from "@/lib/viewer/loader";
import { useViewerStore } from "@/lib/viewer/store";
import { useContextModelStore } from "@/lib/viewer/context-model-store";
import { ContextPropertyPanel } from "./ContextPropertyPanel";
import type {
  ElementInfo,
  MaterialDetailView,
  MaterialRef,
  PropertySetView,
} from "@/lib/ifc/types";

export function PropertyPanel() {
  const loaded = useContextModelStore((s) => s.loaded);
  const selected = useContextModelStore((s) => s.selectedFeature);
  const file = useContextModelStore((s) => s.file);
  const feature = selected === null ? null : loaded?.features?.[selected];
  return feature ? <ContextPropertyPanel key={selected} feature={feature} filename={file?.name} epsg={loaded!.epsg} /> : <IfcPropertyPanel />;
}

function IfcPropertyPanel() {
  const t = useTranslations("viewer.propertyPanel");
  const selection = useViewerStore((s) => s.selection);
  const models = useViewerStore((s) => s.models);
  const ref = selection[selection.length - 1] ?? null;

  const [filter, setFilter] = useState("");
  // Express ids (as strings — Accordion's own value type) of materials
  // currently expanded in the Materials tab. Several can be open at once, so
  // this is a list rather than one "the" open material.
  const [openMaterials, setOpenMaterials] = useState<string[]>([]);

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
          matches(
            property.name,
            formatValue(property.value, t("yes"), t("no"), property.unit),
          ),
        ),
      }))
      .filter((set) => set.properties.length > 0 || matches(set.name, ""));

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

      <div className="flex min-h-0 flex-1 flex-col">
        {isPending || !info ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : (
          <Tabs
            defaultValue="attributes"
            className="panel-tabs flex min-h-0 flex-1 flex-col gap-0"
          >
            {/*
              Each trigger carries its label as text *and* an icon, with CSS
              choosing between them by panel width — same convention as the
              main viewer's own tab bar (`page.tsx`). The text node stays in
              the DOM when hidden, so the tab's accessible name is always the
              word, whichever is showing.
            */}
            <TabsList className="m-2 grid grid-cols-6 bg-transparent p-0">
              <TabsTrigger value="attributes" className="text-xs">
                <Info className="panel-tab-icon h-3.5 w-3.5" aria-hidden />
                <span className="panel-tab-text">{t("attributes")}</span>
              </TabsTrigger>
              <TabsTrigger value="propertySets" className="text-xs">
                <ListChecks className="panel-tab-icon h-3.5 w-3.5" aria-hidden />
                <span className="panel-tab-text">{t("propertySets")}</span>
              </TabsTrigger>
              <TabsTrigger value="quantities" className="text-xs">
                <Sigma className="panel-tab-icon h-3.5 w-3.5" aria-hidden />
                <span className="panel-tab-text">{t("quantities")}</span>
              </TabsTrigger>
              <TabsTrigger value="classification" className="text-xs">
                <Tag className="panel-tab-icon h-3.5 w-3.5" aria-hidden />
                <span className="panel-tab-text">{t("classification")}</span>
              </TabsTrigger>
              <TabsTrigger value="type" className="text-xs">
                <Component className="panel-tab-icon h-3.5 w-3.5" aria-hidden />
                <span className="panel-tab-text">{t("fromItsType")}</span>
              </TabsTrigger>
              <TabsTrigger value="materials" className="text-xs">
                <Layers className="panel-tab-icon h-3.5 w-3.5" aria-hidden />
                <span className="panel-tab-text">{t("materials")}</span>
              </TabsTrigger>
            </TabsList>

            <TabsContent
              value="attributes"
              className="min-h-0 flex-1 overflow-auto p-3"
              data-section={t("attributes")}
            >
              <dl className="space-y-0.5 text-xs">
                {[
                  ["Name", info.attributes?.name, false],
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
            </TabsContent>

            <TabsContent
              value="materials"
              className="min-h-0 flex-1 overflow-auto p-3"
              data-section={t("materials")}
            >
              {info.materials.length === 0 ? (
                <p className="text-muted-foreground text-xs">{t("noMaterials")}</p>
              ) : (
                <Accordion
                  type="multiple"
                  value={openMaterials}
                  onValueChange={setOpenMaterials}
                >
                  {info.materials
                    .filter((material) => matches(material.name, ""))
                    .map((material) => (
                      <MaterialAccordionItem
                        key={material.expressId}
                        modelId={ref.modelId}
                        material={material}
                        open={openMaterials.includes(String(material.expressId))}
                      />
                    ))}
                </Accordion>
              )}
            </TabsContent>

            <TabsContent
              value="propertySets"
              className="min-h-0 flex-1 overflow-auto p-3"
              data-section={t("propertySets")}
            >
              <PropertySetList
                sets={visibleSets(info.propertySets)}
                empty={t("noPropertySets")}
              />
            </TabsContent>

            <TabsContent
              value="quantities"
              className="min-h-0 flex-1 overflow-auto p-3"
              data-section={t("quantities")}
            >
              <PropertySetList
                sets={visibleSets(info.quantities)}
                empty={t("noQuantities")}
              />
            </TabsContent>

            <TabsContent
              value="type"
              className="min-h-0 flex-1 overflow-auto p-3"
              data-section={t("fromItsType")}
            >
              {/* Worth its own tab: these are shared by every occurrence of
                  the type, so editing one is not a local change. */}
              <p className="text-muted-foreground mb-1.5 text-[11px]">
                {t("fromItsTypeHint")}
              </p>
              <PropertySetList
                sets={visibleSets(info.typeProperties)}
                empty={t("noTypeProperties")}
              />
            </TabsContent>

            <TabsContent
              value="classification"
              className="min-h-0 flex-1 overflow-auto p-3"
              data-section={t("classification")}
            >
              {info.classifications.length === 0 ? (
                <p className="text-muted-foreground text-xs">{t("noClassification")}</p>
              ) : (
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
              )}
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}

/**
 * One material in the Materials tab, expandable to that material's own
 * details — its own class/category, description, and property sets. Fetched
 * only once actually expanded (`enabled: open`): an element with several
 * materials should not cost a worker round trip per material just because
 * the tab is open.
 */
function MaterialAccordionItem({
  modelId,
  material,
  open,
}: {
  modelId: string;
  material: MaterialRef;
  open: boolean;
}) {
  const t = useTranslations("viewer.propertyPanel");

  const { data: info, isPending } = useQuery({
    queryKey: ["material-info", modelId, material.expressId],
    enabled: open,
    staleTime: 0,
    queryFn: async (): Promise<MaterialDetailView | null> => {
      const handle = getModelHandle(modelId);
      return handle ? handle.getMaterialInfo(material.expressId) : null;
    },
  });

  return (
    <AccordionItem value={String(material.expressId)}>
      <AccordionTrigger className="py-1.5 text-xs hover:no-underline">
        {material.name}
      </AccordionTrigger>
      <AccordionContent className="pt-0 pb-2">
        {isPending || !info ? (
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : (
          <>
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary">{info.type}</Badge>
              {info.category && <Badge variant="outline">{info.category}</Badge>}
            </div>
            {info.description && (
              <p className="text-muted-foreground mb-1.5 text-[11px]">
                {info.description}
              </p>
            )}
            <PropertySetList
              sets={info.propertySets}
              empty={t("noMaterialProperties")}
            />
          </>
        )}
      </AccordionContent>
    </AccordionItem>
  );
}

/** A tab's worth of named property sets — Property sets, Quantities, From its type. */
function PropertySetList({ sets, empty }: { sets: PropertySetView[]; empty: string }) {
  const t = useTranslations("viewer.propertyPanel");

  if (sets.length === 0) {
    return <p className="text-muted-foreground text-xs">{empty}</p>;
  }

  return (
    <div className="space-y-2.5">
      {sets.map((set, setIndex) => (
        <div key={`${set.globalId ?? set.name}:${setIndex}`}>
          <p className="text-xs font-medium">{set.name}</p>
          <dl className="mt-1 space-y-0.5 text-xs">
            {set.properties.map((property, propertyIndex) => (
              <Row
                key={`${property.name}:${propertyIndex}`}
                label={property.name}
                value={formatValue(property.value, t("yes"), t("no"), property.unit)}
              />
            ))}
          </dl>
        </div>
      ))}
    </div>
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
  unit?: string,
): string {
  if (value === null) return "";
  // IFC booleans must read as booleans, not as "true"/"1" ambiguity — and
  // never take a unit, even if `dataType` were somehow set on one.
  if (typeof value === "boolean") return value ? yes : no;
  return unit ? `${value} ${unit}` : String(value);
}

export default PropertyPanel;
