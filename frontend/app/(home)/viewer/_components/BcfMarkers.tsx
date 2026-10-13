"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useOpenViewpoint } from "@/app/(home)/bcf/_components/useOpenViewpoint";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { locateTopicMarkers, projectTopicMarkers } from "@/lib/bcf/actions";
import type { TopicMarker, TopicMarkerScreen } from "@/lib/bcf/markers";
import { useBcfStore, useVisibleTopics } from "@/lib/bcf/store";
import { useViewerStore } from "@/lib/viewer/store";
import { useViewerPanelStore } from "@/lib/viewer/panel-store";
import { cn } from "@/lib/utils";

function statusColour(status = "") {
  switch (status.toLowerCase()) {
    case "closed": case "resolved": return "text-success";
    case "in progress": return "text-warning";
    case "open": case "reopened": return "text-destructive";
    default: return "text-primary";
  }
}

/** Mount only while enabled: no indexing or animation work when pins are off. */
export default function BcfMarkers({ ready }: { ready: boolean }) {
  const visible = useBcfStore((state) => state.markersVisible);
  return visible && ready ? <TopicMarkers /> : null;
}

function TopicMarkers() {
  const t = useTranslations("viewer.bcfPanel");
  const topics = useVisibleTopics();
  const allTopics = useBcfStore((state) => state.file.topics);
  const selectedGuid = useBcfStore((state) => state.selectedGuid);
  const models = useViewerStore((state) => state.models);
  const placements = useViewerStore((state) => state.placements);
  const { openViewpoint } = useOpenViewpoint();
  const [locations, setLocations] = useState<{
    topics: typeof topics;
    models: typeof models;
    placements: typeof placements;
    markers: TopicMarker[];
    failed: boolean;
  } | null>(null);
  const [screen, setScreen] = useState<{ markers: TopicMarker[]; points: TopicMarkerScreen[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void locateTopicMarkers(topics).then(
      (markers) => { if (!cancelled) setLocations({ topics, models, placements, markers, failed: false }); },
      () => { if (!cancelled) setLocations({ topics, models, placements, markers: [], failed: true }); },
    );
    return () => { cancelled = true; };
  }, [topics, models, placements]);

  // Don't show old locations during an import, unload or placement change.
  const current = locations?.topics === topics && locations.models === models && locations.placements === placements
    ? locations : null;
  const markers = current?.markers;

  useEffect(() => {
    if (!markers?.length) return;
    let frame = 0;
    let previous = "";
    const tick = () => {
      const points = projectTopicMarkers(markers);
      const key = JSON.stringify(points);
      if (key !== previous) {
        previous = key;
        setScreen({ markers, points });
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [markers]);

  const topicByGuid = useMemo(() => new Map(allTopics.map((topic, index) => [topic.guid, { topic, index: topic.index ?? index + 1 }])), [allTopics]);
  const markerByGuid = useMemo(() => new Map(markers?.map((marker) => [marker.topicGuid, marker])), [markers]);
  const points = screen?.markers === markers ? screen?.points ?? [] : [];
  const missing = current ? topics.length - current.markers.length : 0;
  const readyModels = models.some((model) => model.load.status === "ready");

  return (
    <div data-bcf-markers className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {current && topics.length > 0 && (!readyModels || current.failed || missing > 0) && (
        <p className="bg-background/90 text-muted-foreground absolute left-3 top-3 max-w-64 rounded border px-2 py-1 text-xs">
          {!readyModels ? t("markersLoadModel") : current.failed ? t("markersFailed") : t("markersMissing", { count: missing })}
        </p>
      )}
      <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
        {points.map((point) => (
          <g key={point.topicGuid} className={statusColour(topicByGuid.get(point.topicGuid)?.topic.topicStatus)}>
            <line x1={point.x} y1={point.y} x2={point.anchorX} y2={point.anchorY} stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" />
            <circle cx={point.anchorX} cy={point.anchorY} r="3" fill="currentColor" />
          </g>
        ))}
      </svg>
      {points.map((point) => {
        const entry = topicByGuid.get(point.topicGuid);
        const marker = markerByGuid.get(point.topicGuid);
        if (!entry || !marker) return null;
        const { topic, index } = entry;
        const selected = selectedGuid === topic.guid;
        return (
          <Tooltip key={topic.guid}>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-bcf-marker={topic.guid}
                data-marker-source={marker.source}
                aria-label={t("openMarker", { title: topic.title })}
                aria-pressed={selected}
                className={cn(
                  "pointer-events-auto absolute flex h-8 min-w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-current bg-background px-1 text-xs font-bold shadow-md hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring",
                  statusColour(topic.topicStatus),
                  selected && "ring-2 ring-ring ring-offset-2 ring-offset-background",
                )}
                style={{ left: point.x, top: point.y }}
                onClick={() => {
                  const state = useBcfStore.getState();
                  state.select(topic.guid);
                  state.setEditingGuid(topic.guid);
                  useViewerPanelStore.getState().open("bcf");
                  const viewpoint = topic.viewpoints.find((view) => view.guid === marker.viewpointGuid);
                  if (viewpoint) void openViewpoint(topic, viewpoint);
                }}
              >
                {index}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-64">
              <p className="font-medium">{topic.title}</p>
              {(topic.topicStatus || topic.priority) && <p className="text-xs opacity-80">{[topic.topicStatus, topic.priority].filter(Boolean).join(" · ")}</p>}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
