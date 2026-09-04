"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Boxes,
  ClipboardCheck,
  Globe,
  ListTree,
  MessagesSquare,
  Ruler,
  Scissors,
  Shapes,
} from "lucide-react";

/** Tabs `?panel=` may open. */
const PANELS = [
  "models",
  "structure",
  "classes",
  "section",
  "measure",
  "ids",
  "georef",
  "bcf",
];

import ModuleHeader from "@/components/ModuleHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useViewerStore } from "@/lib/viewer/store";

import { ResizeHandle, useResizableWidth } from "@/components/PanelResizeHandle";
import ViewerCanvas from "./_components/ViewerCanvas";
import ModelList from "./_components/ModelList";
import SpatialTree from "./_components/SpatialTree";
import PropertyPanel from "./_components/PropertyPanel";
import { VisibilityActions } from "./_components/ClassFilter";
import FilterPanel from "./_components/FilterPanel";
import SectionPanel from "./_components/SectionPanel";
import MeasurePanel from "./_components/MeasurePanel";
import IdsPanel from "./_components/IdsPanel";
import GeorefPanel from "./_components/GeorefPanel";
import BcfPanel from "./_components/BcfPanel";
import ModelDropZone, { AddModelsButton } from "./_components/ModelDropZone";
import WorkspaceActions from "./_components/WorkspaceActions";

/**
 * The federated IFC viewer.
 *
 * A Client Component, as every page that touches a payload must be
 * (AGENTS.md §1). Model bytes are read here and handed to a Web Worker; they
 * never reach a Server Action or a network call.
 */
export default function ViewerPage() {
  const t = useTranslations("viewer");
  const modelCount = useViewerStore((s) => s.models.length);

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

  const [leftWidth, setLeftWidth] = useResizableWidth("left", 304, 240, 560);
  const [rightWidth, setRightWidth] = useResizableWidth("right", 320, 240, 560);

  // Adjusted during render, not in an effect. React supports this for state
  // that has to follow a prop, and it avoids the extra commit an effect would
  // cost — the tab would visibly flip after paint.
  if (fromUrl && fromUrl !== seenUrl) {
    setSeenUrl(fromUrl);
    setTab(fromUrl);
  }

  // Models deliberately survive leaving this page. `/georef` grades and
  // re-places what is already loaded, and Phases 6 and 7 jump from an IDS
  // failure or a BCF viewpoint straight back into this viewer — all of which
  // break if navigating away silently discards the federation. Closing a model
  // is an explicit action; `unloadAllModels` is wired to it, not to unmount.

  return (
    <div className="flex h-[calc(100vh-3.25rem)] flex-col">
      <ModuleHeader
        title={t("header.title")}
        description={t("header.description")}
        actions={
          <>
            <VisibilityActions />
            <WorkspaceActions />
            <AddModelsButton />
          </>
        }
      />

      <ModelDropZone>
        {/*
          Docked, not floating: each side panel takes real layout width, drags
          to resize (`ResizeHandle`), and the canvas gets whatever is left
          (`flex-1 min-w-0`). This replaced an absolutely-positioned overlay
          over a full-bleed canvas — the ifclite look — which cost a "clear
          channel" nothing could be placed in, because a floating panel simply
          intercepted any click underneath it. Docked panels have no such
          channel to protect: nothing overlaps the canvas at all, so every
          point inside it is a real click target.
        */}
        <div className="flex min-h-0 flex-1 gap-2 p-2">
          {/* Left: models and structure */}
          <aside
            style={{ width: leftWidth }}
            className="glass glass-edge bg-card flex min-h-0 shrink-0 flex-col overflow-hidden rounded-xl"
          >
            <Tabs
              value={tab}
              onValueChange={setTab}
              className="panel-tabs flex min-h-0 flex-1 flex-col"
            >
              {/*
                Each trigger carries its label as text *and* an icon, with CSS
                choosing between them by panel width. The text node stays in the
                DOM when hidden, so the tab's accessible name is the word in
                every case — `getByRole("tab", { name: "Classes" })` works
                whichever is showing, and so does a screen reader.
              */}
              <TabsList className="m-2 grid grid-cols-8 bg-transparent p-0">
                <TabsTrigger value="models" className="text-xs">
                  <Boxes className="panel-tab-icon h-3.5 w-3.5" aria-hidden />
                  <span className="panel-tab-text">{t("tabs.models")}</span>
                  {modelCount > 0 && (
                    <span className="panel-tab-text text-muted-foreground ml-0.5">
                      ({modelCount})
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="structure" className="text-xs">
                  <ListTree className="panel-tab-icon h-3.5 w-3.5" aria-hidden />
                  <span className="panel-tab-text">{t("tabs.structure")}</span>
                </TabsTrigger>
                <TabsTrigger value="classes" className="text-xs">
                  <Shapes className="panel-tab-icon h-3.5 w-3.5" aria-hidden />
                  <span className="panel-tab-text">{t("tabs.classes")}</span>
                </TabsTrigger>
                <TabsTrigger value="georef" className="text-xs">
                  <Globe className="panel-tab-icon h-3.5 w-3.5" aria-hidden />
                  <span className="panel-tab-text">{t("tabs.geo")}</span>
                </TabsTrigger>
                <TabsTrigger value="section" className="text-xs">
                  <Scissors className="panel-tab-icon h-3.5 w-3.5" aria-hidden />
                  <span className="panel-tab-text">{t("tabs.section")}</span>
                </TabsTrigger>
                <TabsTrigger value="measure" className="text-xs">
                  <Ruler className="panel-tab-icon h-3.5 w-3.5" aria-hidden />
                  <span className="panel-tab-text">{t("tabs.measure")}</span>
                </TabsTrigger>
                <TabsTrigger value="ids" className="text-xs">
                  <ClipboardCheck className="panel-tab-icon h-3.5 w-3.5" aria-hidden />
                  <span className="panel-tab-text">{t("tabs.ids")}</span>
                </TabsTrigger>
                <TabsTrigger value="bcf" className="text-xs">
                  <MessagesSquare className="panel-tab-icon h-3.5 w-3.5" aria-hidden />
                  <span className="panel-tab-text">{t("tabs.bcf")}</span>
                </TabsTrigger>
              </TabsList>

              <TabsContent value="models" className="min-h-0 flex-1 overflow-auto">
                <ModelList />
              </TabsContent>
              <TabsContent value="structure" className="min-h-0 flex-1 overflow-auto">
                <SpatialTree />
              </TabsContent>
              <TabsContent value="classes" className="min-h-0 flex-1 overflow-hidden">
                <FilterPanel />
              </TabsContent>
              <TabsContent value="section" className="min-h-0 flex-1 overflow-hidden">
                <SectionPanel />
              </TabsContent>
              <TabsContent value="measure" className="min-h-0 flex-1 overflow-hidden">
                <MeasurePanel />
              </TabsContent>
              <TabsContent value="ids" className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <IdsPanel />
              </TabsContent>
              <TabsContent value="georef" className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <GeorefPanel />
              </TabsContent>
              <TabsContent value="bcf" className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <BcfPanel />
              </TabsContent>
            </Tabs>
          </aside>

          <ResizeHandle
            label={t("resize.sidePanel")}
            onDrag={(deltaX) => setLeftWidth((width) => width + deltaX)}
          />

          <div className="relative min-h-0 flex-1">
            <ViewerCanvas />
          </div>

          <ResizeHandle
            label={t("resize.propertiesPanel")}
            onDrag={(deltaX) => setRightWidth((width) => width - deltaX)}
          />

          {/* Right: the selected element */}
          <aside
            style={{ width: rightWidth }}
            className="glass glass-edge bg-card min-h-0 shrink-0 overflow-auto rounded-xl"
          >
            <PropertyPanel />
          </aside>
        </div>
      </ModelDropZone>
    </div>
  );
}
