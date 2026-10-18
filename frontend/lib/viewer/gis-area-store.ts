"use client";
import { create } from "zustand";
import type { AreaLayerSource, AreaReport } from "@/lib/georef/area-check";

export type AreaViewRequest = { source: AreaLayerSource; featureIndex: number; epsg: number };

/** A dated report snapshot, separate from IFC and context-feature selection. */
export const useGisAreaStore = create<{
  report: AreaReport | null;
  showing: boolean;
  busy: boolean;
  viewRequest: AreaViewRequest | null;
  viewError: string | null;
  view: (layerIndex: number, matchIndex: number) => void;
  finishView: (request: AreaViewRequest, error?: string) => void;
  start: (report: AreaReport) => void;
  update: (report: AreaReport) => void;
  show: () => void;
  hide: () => void;
  clear: () => void;
}>((set, get) => ({
  report: null, showing: false, busy: false, viewRequest: null, viewError: null,
  view: (layerIndex, matchIndex) => {
    const { report, busy, viewRequest } = get();
    const source = report?.layers[layerIndex]?.view;
    const featureIndex = source?.featureIndices[matchIndex];
    if (busy || viewRequest || !report || !source || featureIndex === undefined) return;
    set({ viewRequest: { source, featureIndex, epsg: report.epsg }, viewError: null });
  },
  finishView: (request, error) => {
    if (get().viewRequest === request) set({ viewRequest: null, viewError: error ?? null });
  },
  start: (report) => set({ report, showing: true, busy: true, viewRequest: null, viewError: null }),
  update: (report) => set({ report, busy: report.status === "running" }),
  show: () => set({ showing: true }),
  hide: () => set({ showing: false }),
  clear: () => set({ report: null, showing: false, busy: false, viewRequest: null, viewError: null }),
}));
