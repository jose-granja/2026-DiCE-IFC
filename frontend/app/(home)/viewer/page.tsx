"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  PanelLeft,
  ListFilter,
  X,
} from "lucide-react";

/** Tabs `?panel=` may open. */
const PANELS = [
  "models",
  "structure",
  "classes",
  "lens",
  "quantities",
  "section",
  "measure",
  "ids",
  "georef",
  "gis",
  "clash",
  "bcf",
];

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import ModuleHeader from "@/components/ModuleHeader";
import { PanelHeader, ToolTabIcon } from "./_components/PanelHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useViewerPanelStore } from "@/lib/viewer/panel-store";
import { useFacetSelectionStore } from "@/lib/viewer/facet-selection-store";
import { FACET_DIMENSIONS } from "@/lib/viewer/facets";
import { useGlobeStore } from "@/lib/viewer/globe-store";
import { useLensStore } from "@/lib/lens/store";

import {
  ResizeHandle,
  useResizableWidth,
} from "@/components/PanelResizeHandle";
import ViewerCanvas from "./_components/ViewerCanvas";
import ModelList from "./_components/ModelList";
import SpatialTree from "./_components/SpatialTree";
import PropertyPanel from "./_components/PropertyPanel";
import { VisibilityActions } from "./_components/ClassFilter";
import FilterPanel from "./_components/FilterPanel";
import SectionPanel from "./_components/SectionPanel";
import MeasurePanel from "./_components/MeasurePanel";
import IdsPanel from "./_components/IdsPanel";
import GeorefPanels from "./_components/GeorefPanels";
import BcfPanel from "./_components/BcfPanel";
import ClashPanel from "./_components/ClashPanel";
import ModelDropZone, { AddModelsButton } from "./_components/ModelDropZone";
import PointCloudList from "./_components/PointCloudList";
import WorkspaceActions from "./_components/WorkspaceActions";
import ProjectActions from "./_components/ProjectActions";
import FacetFilterSync from "./_components/FacetFilterSync";
import LensSync from "./_components/LensSync";
import LensPanel from "./_components/LensPanel";
import { QuantityQueryPanel } from "./_components/QuantityQueryPanel";
import TypeVisibilitySettings from "./_components/TypeVisibilitySettings";
import DisplaySettings from "./_components/DisplaySettings";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * The federated IFC viewer.
 *
 * A Client Component, as every page that touches a payload must be
 * (AGENTS.md §1). Model bytes are read here and handed to a Web Worker; they
 * never reach a Server Action or a network call.
 */
/**
 * Marks a tab whose work stays on while it is closed — the filter, the 3D world
 * context. Decorative: the trigger's `title` carries the words, and the tab's
 * accessible name stays the tab's own.
 */
function ActiveDot() {
  return (
    <span
      aria-hidden
      className="bg-primary ring-card absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full ring-2"
    />
  );
}

export default function ViewerPage() {
  const t = useTranslations("viewer");

  /**
   * `?panel=ids` opens straight onto a tab.
   *
   * `/ids/validate` redirects here, so a bookmark to the old page has to land
   * on the panel that replaced it rather than on the default tab.
   */
  const searchParams = useSearchParams();
  const requested = searchParams.get("panel");
  const fromUrl = PANELS.includes(requested ?? "") ? requested! : null;

  /*
    Controlled, not `defaultValue`.

    `defaultValue` is read once, so `router.push("/viewer?panel=bcf")` from
    somewhere already on this page — which is what "New topic" does — changed
    the URL and left the tab where it was. Syncing on the parameter makes the
    query string a real way to open a panel rather than only an entry point.
  */
  const [tab, setTab] = useState(fromUrl ?? "structure");
  const [seenUrl, setSeenUrl] = useState(fromUrl);
  const [mobilePanel, setMobilePanel] = useState<"tools" | "properties" | null>(fromUrl ? "tools" : null);
  const toolsToggle = useRef<HTMLButtonElement>(null);
  const propertiesToggle = useRef<HTMLButtonElement>(null);
  const toolsClose = useRef<HTMLButtonElement>(null);
  const propertiesClose = useRef<HTMLButtonElement>(null);

  const closeMobilePanel = () => {
    (mobilePanel === "tools" ? toolsToggle : propertiesToggle).current?.focus();
    setMobilePanel(null);
  };

  useEffect(() => {
    if (!mobilePanel) return;
    if (window.matchMedia("(max-width: 1023px)").matches) {
      (mobilePanel === "tools" ? toolsClose : propertiesClose).current?.focus();
    }
    const onKeyDown = (event: KeyboardEvent) => {
      // A nested dialog/popover gets first chance to consume Escape.
      if (event.key !== "Escape" || event.defaultPrevented || !window.matchMedia("(max-width: 1023px)").matches) return;
      (mobilePanel === "tools" ? toolsToggle : propertiesToggle).current?.focus();
      setMobilePanel(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobilePanel]);

  const [leftWidth, setLeftWidth] = useResizableWidth("left", 304, 240, 560);
  const [rightWidth, setRightWidth] = useResizableWidth("right", 320, 240, 560);

  // Adjusted during render, not in an effect. React supports this for state
  // that has to follow a prop, and it avoids the extra commit an effect would
  // cost — the tab would visibly flip after paint.
  if (fromUrl !== seenUrl) {
    setSeenUrl(fromUrl);
    if (fromUrl) {
      setTab(fromUrl);
      setMobilePanel("tools");
    }
  }

  // The same, for a tab asked for from elsewhere on the page (a project restore).
  const request = useViewerPanelStore((s) => s.request);
  const [seenRequest, setSeenRequest] = useState(request);
  if (request && request !== seenRequest) {
    setSeenRequest(request);
    if (PANELS.includes(request.panel)) {
      setTab(request.panel);
      setMobilePanel("tools");
    }
  }
  useEffect(() => {
    useViewerPanelStore.getState().report(tab);
  }, [tab]);

  const globeOn = useGlobeStore((s) => s.on);
  const lensOn = useLensStore((s) => s.activeId !== null || s.draft !== null);
  const filterCount = useFacetSelectionStore((s) =>
    FACET_DIMENSIONS.reduce(
      (count, dimension) => count + s.selection[dimension].size,
      0,
    ),
  );

  // Models deliberately survive leaving this page. `/georef` grades and
  // re-places what is already loaded, and Phases 6 and 7 jump from an IDS
  // failure or a BCF viewpoint straight back into this viewer — all of which
  // break if navigating away silently discards the federation. Closing a model
  // is an explicit action; `unloadAllModels` is wired to it, not to unmount.

  return (
    <div className="viewer-page flex min-h-0 min-w-0 flex-col">
      <ModuleHeader
        title={t("header.title")}
        className="viewer-header"
        actionsClassName="viewer-actions"
        actions={
          <>
            <AddModelsButton />
            <VisibilityActions />
            <WorkspaceActions />
            {/* After "Add models", not before: its hidden folder and .zip
                inputs must not become the page's first file input, which is
                the model picker and what the e2e suite targets. */}
            <ProjectActions />
                <TypeVisibilitySettings />
                <DisplaySettings />
          </>
        }
      />

      <ModelDropZone>
        {/* Both panels stay mounted when hidden: closing a mobile panel must
            preserve drafts and in-progress local processing. */}
        <div className="viewer-workspace relative isolate flex min-h-0 min-w-0 flex-1 gap-2 p-2">
          <div className="absolute top-4 left-4 z-20 flex flex-col gap-2 lg:hidden">
            <Button ref={toolsToggle} variant="outline" className="glass bg-card h-11 justify-start shadow-sm" aria-controls="viewer-tools" aria-expanded={mobilePanel === "tools"} onClick={() => setMobilePanel(mobilePanel === "tools" ? null : "tools")}>
              <PanelLeft aria-hidden />{t("mobile.tools")}
            </Button>
            <Button ref={propertiesToggle} variant="outline" className="glass bg-card h-11 justify-start shadow-sm" aria-controls="viewer-properties" aria-expanded={mobilePanel === "properties"} onClick={() => setMobilePanel(mobilePanel === "properties" ? null : "properties")}>
              <ListFilter aria-hidden />{t("mobile.properties")}
            </Button>
          </div>
          {mobilePanel && <button type="button" tabIndex={-1} className="absolute inset-0 z-30 bg-background/20 lg:hidden" aria-label={t("mobile.close")} onClick={closeMobilePanel} />}
          {/* Left: models and structure */}
          <aside
            id="viewer-tools"
            aria-label={t("mobile.tools")}
            style={{ width: `min(${leftWidth}px, calc((100% - 24rem) / 2))` }}
            className={cn("viewer-side-panel viewer-tools glass glass-edge bg-card min-h-0 shrink-0 flex-col overflow-hidden rounded-xl lg:flex", mobilePanel === "tools" ? "flex" : "hidden")}
          >
            <div className="flex shrink-0 items-center justify-between border-b pl-3 lg:hidden">
              <h2 className="text-sm font-semibold">{t(`tabs.${tab === "classes" ? "filters" : tab === "georef" ? "geo" : tab}`)}</h2>
              <Button ref={toolsClose} size="icon" variant="ghost" className="size-11" aria-label={t("mobile.closeTools")} onClick={closeMobilePanel}><X aria-hidden /></Button>
            </div>
            <Tabs
              value={tab}
              onValueChange={setTab}
              className="panel-tabs flex min-h-0 flex-1 flex-col"
            >
              {/*
                Icon tabs keep a permanent accessible name. Tooltips provide
                the visible label on hover or focus, but are not a replacement
                for aria-label when the tooltip is closed. Explicit data-state on
                each child also keeps TooltipTrigger from replacing the tab state
                with its own open/closed state (which removes active styling).
              */}
              <TabsList className="viewer-tool-tabs m-2 grid h-auto w-auto shrink-0 grid-cols-6 bg-transparent p-0 lg:grid-cols-12 [&>[role=tab]]:min-w-0 [&>[role=tab]]:px-0">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <TabsTrigger value="models" data-state={tab === "models" ? "active" : "inactive"} className="text-xs" aria-label={t("tabs.models")}>
                      <ToolTabIcon tab="models" />
                    </TabsTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t("tabs.models")}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <TabsTrigger value="structure" data-state={tab === "structure" ? "active" : "inactive"} className="text-xs" aria-label={t("tabs.structure")}>
                      <ToolTabIcon tab="structure" />
                    </TabsTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t("tabs.structure")}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <TabsTrigger
                      value="classes" data-state={tab === "classes" ? "active" : "inactive"}
                      aria-label={t("tabs.filters")}
                      className="relative text-xs"
                      // A filter stays on when this tab is closed, so the tab says so.
                      title={
                        filterCount > 0
                          ? t("tabs.filtersActive", { count: filterCount })
                          : undefined
                      }
                      data-filter-active={filterCount > 0 || undefined}
                    >
                      <ToolTabIcon tab="classes" />
                      {filterCount > 0 && <ActiveDot />}
                    </TabsTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t("tabs.filters")}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <TabsTrigger
                      value="lens" data-state={tab === "lens" ? "active" : "inactive"}
                      aria-label={t("tabs.lens")}
                      className="relative text-xs"
                      // A lens stays on when this tab is closed, so the tab says so.
                      title={lensOn ? t("tabs.lensActive") : undefined}
                      data-lens-active={lensOn || undefined}
                    >
                      <ToolTabIcon tab="lens" />
                      {lensOn && <ActiveDot />}
                    </TabsTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t("tabs.lens")}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <TabsTrigger value="quantities" data-state={tab === "quantities" ? "active" : "inactive"} className="text-xs" aria-label={t("tabs.quantities")}>
                      <ToolTabIcon tab="quantities" />
                    </TabsTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t("tabs.quantities")}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <TabsTrigger
                      value="georef" data-state={tab === "georef" ? "active" : "inactive"}
                      aria-label={t("tabs.geo")}
                      className="text-xs"
                    >
                      <ToolTabIcon tab="georef" />
                    </TabsTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t("tabs.geo")}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <TabsTrigger
                      value="gis" data-state={tab === "gis" ? "active" : "inactive"}
                      aria-label={t("tabs.gis")}
                      className="relative text-xs"
                      // World context keeps streaming when its controls are hidden.
                      title={globeOn ? t("tabs.globeActive") : undefined}
                      data-globe-active={globeOn || undefined}
                    >
                      <ToolTabIcon tab="gis" />
                      {globeOn && <ActiveDot />}
                    </TabsTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t("tabs.gis")}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <TabsTrigger value="section" data-state={tab === "section" ? "active" : "inactive"} className="text-xs" aria-label={t("tabs.section")}>
                      <ToolTabIcon tab="section" />
                    </TabsTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t("tabs.section")}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <TabsTrigger value="measure" data-state={tab === "measure" ? "active" : "inactive"} className="text-xs" aria-label={t("tabs.measure")}>
                      <ToolTabIcon tab="measure" />
                    </TabsTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t("tabs.measure")}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <TabsTrigger value="ids" data-state={tab === "ids" ? "active" : "inactive"} className="text-xs" aria-label={t("tabs.ids")}>
                      <ToolTabIcon tab="ids" />
                    </TabsTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t("tabs.ids")}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <TabsTrigger value="clash" data-state={tab === "clash" ? "active" : "inactive"} className="text-xs" aria-label={t("tabs.clash")}>
                      <ToolTabIcon tab="clash" />
                    </TabsTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t("tabs.clash")}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <TabsTrigger value="bcf" data-state={tab === "bcf" ? "active" : "inactive"} className="text-xs" aria-label={t("tabs.bcf")}>
                      <ToolTabIcon tab="bcf" />
                    </TabsTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t("tabs.bcf")}</TooltipContent>
                </Tooltip>
              </TabsList>

              <TabsContent
                value="models"
                className="flex min-h-0 flex-1 flex-col overflow-hidden"
              >
                <PanelHeader tab="models" />
                <div className="min-h-0 flex-1 overflow-auto">
                  <ModelList />
                  <PointCloudList />
                </div>
              </TabsContent>
              <TabsContent
                value="structure"
                className="flex min-h-0 flex-1 flex-col overflow-hidden"
              >
                <PanelHeader tab="structure" />
                <div className="min-h-0 flex-1 overflow-auto">
                  <SpatialTree />
                </div>
              </TabsContent>
              <TabsContent
                value="classes"
                className="min-h-0 flex-1 overflow-hidden"
              >
                <FilterPanel />
              </TabsContent>
              <TabsContent
                value="lens"
                className="flex min-h-0 flex-1 flex-col overflow-hidden"
              >
                <LensPanel />
              </TabsContent>
              <TabsContent
                value="quantities"
                className="min-h-0 flex-1 overflow-hidden"
              >
                <QuantityQueryPanel />
              </TabsContent>
              <TabsContent
                value="section"
                className="min-h-0 flex-1 overflow-hidden"
              >
                <SectionPanel />
              </TabsContent>
              <TabsContent
                value="measure"
                className="min-h-0 flex-1 overflow-hidden"
              >
                <MeasurePanel />
              </TabsContent>
              <TabsContent
                value="ids"
                className="flex min-h-0 flex-1 flex-col overflow-hidden"
              >
                <IdsPanel />
              </TabsContent>
              <GeorefPanels />
              <TabsContent
                value="clash"
                className="min-h-0 flex-1 overflow-hidden"
              >
                <ClashPanel />
              </TabsContent>
              <TabsContent
                value="bcf"
                className="flex min-h-0 flex-1 flex-col overflow-hidden"
              >
                <BcfPanel />
              </TabsContent>
            </Tabs>
          </aside>

          <div className="hidden lg:flex">
            <ResizeHandle label={t("resize.sidePanel")} onDrag={(deltaX) => setLeftWidth((width) => width + deltaX)} />
          </div>

          <div className="relative min-h-0 min-w-0 flex-1">
            <ViewerCanvas />
            <FacetFilterSync />
            <LensSync />
          </div>

          <div className="hidden lg:flex">
            <ResizeHandle label={t("resize.propertiesPanel")} onDrag={(deltaX) => setRightWidth((width) => width - deltaX)} />
          </div>

          {/* Right: the selected element */}
          <aside
            id="viewer-properties"
            aria-label={t("mobile.properties")}
            style={{ width: `min(${rightWidth}px, calc((100% - 24rem) / 2))` }}
            className={cn("viewer-side-panel viewer-properties glass glass-edge bg-card min-h-0 shrink-0 flex-col overflow-hidden rounded-xl lg:flex", mobilePanel === "properties" ? "flex" : "hidden")}
          >
            <div className="flex shrink-0 items-center justify-between border-b pl-3 lg:hidden">
              <h2 className="text-sm font-semibold">{t("mobile.properties")}</h2>
              <Button ref={propertiesClose} size="icon" variant="ghost" className="size-11" aria-label={t("mobile.closeProperties")} onClick={closeMobilePanel}><X aria-hidden /></Button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-auto"><PropertyPanel /></div>
          </aside>
        </div>
      </ModelDropZone>
    </div>
  );
}
