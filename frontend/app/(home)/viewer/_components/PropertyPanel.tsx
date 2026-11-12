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
import {
  Check,
  Component,
  Copy,
  FileCheck2,
  Info,
  Layers,
  ListChecks,
  Search,
  Sigma,
  Tag,
  type LucideIcon,
} from "lucide-react";

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
import { IdsProperties } from "./IdsProperties";
import { PropertyTable, type PropertyTableGroup, type PropertyTableRow } from "./PropertyTable";
import { usePropertyTranslation, type PropertyTranslation } from "@/lib/bsdd/use-property-names";
import { formatPropertyValue } from "@/lib/viewer/property-format";
import { useDisplaySettingsStore } from "@/lib/viewer/display-settings";
import { GisAreaReport } from "./GisAreaReport";
import { useGisAreaStore } from "@/lib/viewer/gis-area-store";
import type {
  ElementInfo,
  MaterialDetailView,
  MaterialRef,
  PropertyView,
  PropertySetView,
} from "@/lib/ifc/types";

export function PropertyPanel() {
  const report = useGisAreaStore((s) => s.showing ? s.report : null);
  const loaded = useContextModelStore((s) => s.loaded);
  const selected = useContextModelStore((s) => s.selectedFeature);
  const file = useContextModelStore((s) => s.file);
  const feature = selected === null ? null : loaded?.features?.[selected];
  if (report) return <GisAreaReport report={report} />;
  return feature ? <ContextPropertyPanel key={selected} feature={feature} filename={file?.name} epsg={loaded!.epsg} /> : <IfcPropertyPanel />;
}

function IfcPropertyPanel() {
  const t = useTranslations("viewer.propertyPanel");
  const decimalPlaces = useDisplaySettingsStore((s) => s.propertyDecimalPlaces);
  const translate = usePropertyTranslation();
  const selection = useViewerStore((s) => s.selection);
  const models = useViewerStore((s) => s.models);
  const ref = selection[selection.length - 1] ?? null;

  const [filter, setFilter] = useState("");
  const [activeTab, setActiveTab] = useState("attributes");
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
          matches(set.name, "") || matches(
            // The bSDD label too: "resistência" finds FireRating.
            [property.name, translate(set.name, property.name)?.text].filter(Boolean).join(" "),
            formatProperty(property, t("yes"), t("no"), decimalPlaces),
          ),
        ),
      }))
      .filter((set) => set.properties.length > 0);

  // What each tab shows, worked out once so its heading can count it — what is
  // listed, so the count agrees with the filter above.
  const predefined = info?.predefinedType;
  // PredefinedType by buildingSMART's rules (lib/ifc/predefined-type.ts): the
  // type's when it has one, marked so, else the element's own.
  const predefinedRow: PropertyTableRow | null = predefined
    ? {
        id: "PredefinedType",
        name: "PredefinedType",
        value: predefined.value,
        ...(predefined.source === "type" && info?.typeObject
          ? { badge: { label: t("fromType"), hint: t("fromTypeHint", { type: info.typeObject.type }) } }
          : {}),
        details: [
          predefined.userDefinedIn
            ? t(predefined.value === predefined.enumValue ? "predefinedUserDefinedMissing" : "predefinedUserDefined", { attribute: predefined.userDefinedIn })
            : "",
          predefined.overridden ? t("predefinedOverridden", { value: predefined.overridden }) : "",
        ].filter(Boolean),
      }
    : null;
  const attributeRows: PropertyTableRow[] = info
    ? [
        ...[
          ["Name", info.attributes?.name, false],
          ["GlobalId", info.attributes?.globalId, true],
          ["Description", info.attributes?.description, false],
          ["ObjectType", info.attributes?.objectType, false],
          ["Tag", info.attributes?.tag, false],
        ]
          .filter(([, value]) => Boolean(value))
          .map(([label, value, mono]) => ({
            id: String(label), name: String(label), value: String(value), mono: Boolean(mono),
          })),
        // Last, as in the schema.
        ...(predefinedRow ? [predefinedRow] : []),
      ].filter((row) => matches(row.name, row.value))
    : [];
  const shownPropertySets = info ? visibleSets(info.propertySets) : [];
  const shownQuantities = info ? visibleSets(info.quantities) : [];
  const shownTypeProperties = info ? visibleSets(info.typeProperties) : [];
  // The type object's own attributes, as the first group of the Type tab.
  const typeAttributeRows = info?.typeObject
    ? info.typeObject.attributes
        .map(({ name, value }) => ({
          id: name,
          name,
          value: typeof value === "boolean" ? t(value ? "yes" : "no") : String(value),
          mono: name === "GlobalId",
        }))
        .filter((row) => matches(row.name, row.value))
    : [];
  const typeGroupCount = (typeAttributeRows.length ? 1 : 0) + shownTypeProperties.length;
  const shownMaterials = info ? info.materials.filter((material) => matches(material.name, "")) : [];
  const shownClassifications = info
    ? info.classifications.filter((entry) => matches(entry.system, `${entry.code} ${entry.name}`))
    : [];

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
            value={activeTab}
            onValueChange={setActiveTab}
            className="panel-tabs flex min-h-0 flex-1 flex-col gap-0"
          >
            {/*
              Each trigger carries its label as text *and* an icon, with CSS
              choosing between them by panel width — same convention as the
              main viewer's own tab bar (`page.tsx`). The text node stays in
              the DOM when hidden, so the tab's accessible name is always the
              word, whichever is showing.
            */}
            <TabsList className="m-2 grid grid-cols-7 bg-transparent p-0">
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
              <TabsTrigger value="ids" className="text-xs" title={t("ids.title")} aria-label={t("ids.title")}>
                <FileCheck2 className="panel-tab-icon h-3.5 w-3.5" aria-hidden />
                <span className="panel-tab-text">{t("ids.tab")}</span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="ids" className="min-h-0 flex-1 overflow-auto p-3">
              <SectionTitle icon={FileCheck2} title={t("headings.ids")} />
              <IdsProperties entity={ref} filter={filter} />
            </TabsContent>

            <TabsContent
              value="attributes"
              className="min-h-0 flex-1 overflow-auto p-3"
              data-section={t("attributes")}
            >
              <SectionTitle icon={Info} title={t("headings.attributes")} count={attributeRows.length} />
              <PropertyTable rows={attributeRows} />
            </TabsContent>

            <TabsContent
              value="materials"
              className="min-h-0 flex-1 overflow-auto p-3"
              data-section={t("materials")}
            >
              <SectionTitle icon={Layers} title={t("headings.materials")} count={shownMaterials.length} />
              {info.materials.length === 0 ? (
                <p className="text-muted-foreground text-xs">{t("noMaterials")}</p>
              ) : (
                <Accordion
                  type="multiple"
                  value={openMaterials}
                  onValueChange={setOpenMaterials}
                >
                  {shownMaterials.map((material) => (
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
              <SectionTitle icon={ListChecks} title={t("headings.propertySets")} count={shownPropertySets.length} />
              <PropertySetList
                sets={shownPropertySets}
                empty={t(term ? "contextNoMatches" : "noPropertySets")}
              />
            </TabsContent>

            <TabsContent
              value="quantities"
              className="min-h-0 flex-1 overflow-auto p-3"
              data-section={t("quantities")}
            >
              <SectionTitle icon={Sigma} title={t("headings.quantities")} count={shownQuantities.length} />
              <PropertySetList
                sets={shownQuantities}
                empty={t(term ? "contextNoMatches" : "noQuantities")}
              />
            </TabsContent>

            <TabsContent
              value="type"
              className="min-h-0 flex-1 overflow-auto p-3"
              data-section={t("fromItsType")}
            >
              <SectionTitle icon={Component} title={t("headings.type")} count={typeGroupCount} />
              {/* Worth its own tab: these are shared by every occurrence of
                  the type, so editing one is not a local change. */}
              {/* <p className="text-muted-foreground mb-3 text-xs">
                {t("fromItsTypeHint")}
              </p> */}
              <PropertySetList
                lead={info.typeObject && typeAttributeRows.length
                  ? { id: "type-attributes", name: t("typeAttributes", { type: info.typeObject.type }), rows: typeAttributeRows }
                  : undefined}
                sets={shownTypeProperties}
                empty={t(term ? "contextNoMatches" : info.typeObject ? "noTypeProperties" : "noType")}
              />
            </TabsContent>

            <TabsContent
              value="classification"
              className="min-h-0 flex-1 overflow-auto p-3"
              data-section={t("classification")}
            >
              <SectionTitle icon={Tag} title={t("headings.classification")} count={shownClassifications.length} />
              {info.classifications.length === 0 ? (
                <p className="text-muted-foreground text-xs">{t("noClassification")}</p>
              ) : (
                <PropertyTable rows={shownClassifications
                    .map((entry, index) => ({
                      id: `${entry.system}-${entry.code}:${index}`,
                      name: entry.system || t("classification"),
                      value: [entry.code, entry.name].filter(Boolean).join(" — "),
                    }))} />
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
  const decimalPlaces = useDisplaySettingsStore((s) => s.propertyDecimalPlaces);
  const translate = usePropertyTranslation();

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
      <AccordionTrigger className="py-2 text-xs font-medium hover:no-underline">
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
            <PropertyTable groups={[
              { id: "metadata", rows: [
                { id: "type", name: t("fromItsType"), value: info.type },
                ...(info.category ? [{ id: "category", name: t("category"), value: info.category }] : []),
                ...(info.description ? [{ id: "description", name: t("description"), value: info.description }] : []),
              ] },
              ...propertySetGroups(info.propertySets, t("yes"), t("no"), decimalPlaces, translate),
            ]} />
            {info.propertySets.length === 0 && <p className="text-muted-foreground mt-3 text-xs">{t("noMaterialProperties")}</p>}
          </>
        )}
      </AccordionContent>
    </AccordionItem>
  );
}

/** A tab's worth of named property sets — Property sets, Quantities, From its type. */
function PropertySetList({ sets, empty, lead }: { sets: PropertySetView[]; empty: string; lead?: PropertyTableGroup }) {
  const t = useTranslations("viewer.propertyPanel");
  const decimalPlaces = useDisplaySettingsStore((s) => s.propertyDecimalPlaces);
  const translate = usePropertyTranslation();
  const groups = propertySetGroups(sets, t("yes"), t("no"), decimalPlaces, translate);
  return <PropertyTable groups={lead ? [lead, ...groups] : groups} empty={empty} />;
}

function propertySetGroups(
  sets: PropertySetView[],
  yes: string,
  no: string,
  decimalPlaces: number,
  translate: (set: string, property: string) => PropertyTranslation | undefined,
): PropertyTableGroup[] {
  return sets.map((set, setIndex) => ({
    id: `set:${setIndex}`,
    name: set.name,
    rows: set.properties.map((property, propertyIndex) => ({
      id: `property:${propertyIndex}`,
      name: property.name,
      translation: translate(set.name, property.name),
      value: formatProperty(property, yes, no, decimalPlaces),
    })),
  }));
}

function formatProperty(property: PropertyView, yes: string, no: string, decimalPlaces: number): string {
  const values = property.unit && property.values?.length ? property.values : [property.value];
  return values.map((value) => formatPropertyValue(value, yes, no, property.unit, decimalPlaces)).join("; ");
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

export default PropertyPanel;

/**
 * The heading at the top of each tab's content. The tab bar collapses to icons
 * in a narrow panel, so without it nothing on screen said which tab was open.
 */
function SectionTitle({
  icon: Icon,
  title,
  count,
}: {
  icon: LucideIcon;
  title: string;
  count?: number;
}) {
  return (
    <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold" data-section-title>
      <Icon className="text-muted-foreground h-3.5 w-3.5" aria-hidden />
      {title}
      {/* A real space, not just the flex gap, so the words read "Attributes · 3". */}
      {count !== undefined && (
        <span className="text-muted-foreground font-normal tabular-nums">{" "}· {count}</span>
      )}
    </h3>
  );
}
