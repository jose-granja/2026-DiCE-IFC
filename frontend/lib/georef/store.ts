"use client";

/**
 * State for the georeferencing module.
 *
 * Kept separate from the viewer store: this is a working draft — a proposed
 * placement the user is still editing — and it must not leak into the viewer's
 * federation until it is written back. Mixing them would make an in-progress
 * edit silently move the model in the 3D view.
 */

import { create } from "zustand";

import { DEFAULT_EPSG } from "@/config";
import type { MapConversionView } from "@/lib/ifc/types";
import type { ControlPoint, FitLocks, FitResult } from "./fit";

/**
 * The `IfcProjectedCRS` attributes beyond the name, as editable text. An empty
 * string means "not stated" — the same thing the file says with `$`.
 */
export type ProjectedCrsFields = {
  geodeticDatum: string;
  /** Datum the orthogonal heights are measured from, e.g. "Cascais height". */
  verticalDatum: string;
  mapProjection: string;
  mapZone: string;
};

export const EMPTY_CRS_FIELDS: ProjectedCrsFields = {
  geodeticDatum: "",
  verticalDatum: "",
  mapProjection: "",
  mapZone: "",
};

/**
 * `IfcSite.RefLatitude` / `RefLongitude` (decimal degrees) and `RefElevation`
 * (project length units); null while empty.
 */
export type SiteLocationDraft = {
  latitude: number | null;
  longitude: number | null;
  elevation: number | null;
};

export const EMPTY_SITE: SiteLocationDraft = { latitude: null, longitude: null, elevation: null };

export type DraftPlacement = {
  epsg: number;
  conversion: MapConversionView;
  /** Where the file says the site is. Absent on drafts that predate it; read as empty. */
  site?: SiteLocationDraft;
  /** Absent only on drafts built before the CRS fields existed; read as empty. */
  crs?: ProjectedCrsFields;
};

type GeorefState = {
  /** Model being georeferenced, by viewer model id. */
  modelId: string | null;
  /** The proposed placement. Null until the model is read or the user starts. */
  draft: DraftPlacement | null;
  /** The placement as read from the file, for the before/after diff. */
  original: DraftPlacement | null;

  controlPoints: ControlPoint[];
  locks: FitLocks;
  fit: FitResult | null;
  fitError: string | null;

  selectModel: (modelId: string | null) => void;
  setOriginal: (placement: DraftPlacement | null) => void;
  setDraft: (placement: DraftPlacement | null) => void;
  patchConversion: (patch: Partial<MapConversionView>) => void;
  setEpsg: (epsg: number) => void;
  patchCrs: (patch: Partial<ProjectedCrsFields>) => void;
  patchSite: (patch: Partial<SiteLocationDraft>) => void;
  /** Throw the edits away and go back to what the file says. */
  revert: () => void;

  addControlPoint: (point: ControlPoint) => void;
  updateControlPoint: (id: string, patch: Partial<ControlPoint>) => void;
  removeControlPoint: (id: string) => void;
  clearControlPoints: () => void;
  setLocks: (locks: FitLocks) => void;
  setFit: (fit: FitResult | null, error?: string | null) => void;

  reset: () => void;
};

export const EMPTY_CONVERSION: MapConversionView = {
  eastings: 0,
  northings: 0,
  orthogonalHeight: 0,
  xAxisAbscissa: 1,
  xAxisOrdinate: 0,
  scale: 1,
};

let controlPointSeq = 0;
export const nextControlPointId = () => `cp-${(controlPointSeq += 1)}`;

export const useGeorefStore = create<GeorefState>((set, get) => ({
  modelId: null,
  draft: null,
  original: null,
  controlPoints: [],
  locks: {},
  fit: null,
  fitError: null,

  selectModel: (modelId) =>
    // Everything else is about the previous model; carrying a draft or a fit
    // across would silently apply one model's control points to another.
    set({
      modelId,
      draft: null,
      original: null,
      controlPoints: [],
      fit: null,
      fitError: null,
    }),

  setOriginal: (placement) => set({ original: placement }),

  setDraft: (draft) => set({ draft }),

  patchConversion: (patch) =>
    set((state) => {
      const base = state.draft ?? {
        epsg: DEFAULT_EPSG,
        conversion: EMPTY_CONVERSION,
      };
      return {
        draft: { ...base, conversion: { ...base.conversion, ...patch } },
      };
    }),

  setEpsg: (epsg) =>
    set((state) => ({
      draft: {
        epsg,
        conversion: state.draft?.conversion ?? EMPTY_CONVERSION,
        // The vertical datum, projection and zone belong to the model's
        // heights and the file, not to which horizontal CRS is picked.
        crs: state.draft?.crs,
        site: state.draft?.site,
      },
    })),

  patchSite: (patch) =>
    set((state) => {
      const base = state.draft ?? {
        epsg: DEFAULT_EPSG,
        conversion: EMPTY_CONVERSION,
      };
      return { draft: { ...base, site: { ...EMPTY_SITE, ...base.site, ...patch } } };
    }),

  patchCrs: (patch) =>
    set((state) => {
      const base = state.draft ?? {
        epsg: DEFAULT_EPSG,
        conversion: EMPTY_CONVERSION,
      };
      return { draft: { ...base, crs: { ...EMPTY_CRS_FIELDS, ...base.crs, ...patch } } };
    }),

  revert: () => set({ draft: get().original, fit: null, fitError: null }),

  addControlPoint: (point) =>
    set((state) => ({ controlPoints: [...state.controlPoints, point] })),

  updateControlPoint: (id, patch) =>
    set((state) => ({
      controlPoints: state.controlPoints.map((point) =>
        point.id === id ? { ...point, ...patch } : point,
      ),
      // The stored fit was computed from the old points; keeping it would show
      // residuals that no longer correspond to anything on screen.
      fit: null,
    })),

  removeControlPoint: (id) =>
    set((state) => ({
      controlPoints: state.controlPoints.filter((point) => point.id !== id),
      fit: null,
    })),

  clearControlPoints: () => set({ controlPoints: [], fit: null, fitError: null }),

  setLocks: (locks) => set({ locks, fit: null }),

  setFit: (fit, error = null) => set({ fit, fitError: error }),

  reset: () =>
    set({
      modelId: null,
      draft: null,
      original: null,
      controlPoints: [],
      locks: {},
      fit: null,
      fitError: null,
    }),
}));

/** Has the draft moved away from what the file says? */
export function hasChanges(
  original: DraftPlacement | null,
  draft: DraftPlacement | null,
): boolean {
  if (!draft) return false;
  if (!original) return true;
  if (original.epsg !== draft.epsg) return true;

  const siteDiffers = (["latitude", "longitude", "elevation"] as const).some(
    (key) => (original.site?.[key] ?? null) !== (draft.site?.[key] ?? null),
  );
  if (siteDiffers) return true;

  const fields = Object.keys(EMPTY_CRS_FIELDS) as Array<keyof ProjectedCrsFields>;
  if (
    fields.some(
      (key) => (original.crs?.[key] ?? "").trim() !== (draft.crs?.[key] ?? "").trim(),
    )
  ) {
    return true;
  }

  const keys: Array<keyof MapConversionView> = [
    "eastings",
    "northings",
    "orthogonalHeight",
    "xAxisAbscissa",
    "xAxisOrdinate",
    "scale",
  ];
  return keys.some((key) => {
    const a = original.conversion[key] ?? (key === "scale" || key === "xAxisAbscissa" ? 1 : 0);
    const b = draft.conversion[key] ?? (key === "scale" || key === "xAxisAbscissa" ? 1 : 0);
    // Exact comparison: these are values the user typed or a solver produced,
    // and a "nearly equal" diff would hide a real edit of a few millimetres.
    return a !== b;
  });
}
