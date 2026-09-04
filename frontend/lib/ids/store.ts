"use client";

/**
 * State for the IDS authoring module.
 *
 * The whole document lives here and every edit is a plain immutable update, so
 * the XML preview, the issue list and the specification list all derive from
 * one source. Drafts persist to OPFS — nothing is uploaded, and a closed tab
 * should not lose an afternoon's work.
 */

import { create } from "zustand";

import { OPFS_NAMESPACES, readJson, writeJson } from "@/lib/storage/opfs";
import {
  allowedCardinalities,
  emptyDocument,
  emptyFacet,
  emptySpecification,
  nextId,
  type Cardinality,
  type Facet,
  type FacetKind,
  type IdsDocument,
  type IdsInfo,
  type Specification,
} from "./types";

const DRAFT_KEY = "current";

type Block = "applicability" | "requirements";

type IdsState = {
  document: IdsDocument;
  /** Which specification the detail pane is editing. */
  selectedId: string | null;
  /** True once an edit has been made and not yet saved. */
  dirty: boolean;

  setDocument: (document: IdsDocument) => void;
  updateInfo: (patch: Partial<IdsInfo>) => void;

  addSpecification: () => void;
  updateSpecification: (id: string, patch: Partial<Specification>) => void;
  setApplicabilityCardinality: (id: string, cardinality: Cardinality) => void;
  removeSpecification: (id: string) => void;
  duplicateSpecification: (id: string) => void;
  reorderSpecifications: (fromId: string, toId: string) => void;
  select: (id: string | null) => void;

  addFacet: (specId: string, block: Block, kind: FacetKind) => void;
  updateFacet: (specId: string, block: Block, facetId: string, facet: Facet) => void;
  removeFacet: (specId: string, block: Block, facetId: string) => void;
  setCardinality: (specId: string, facetId: string, cardinality: Cardinality) => void;
  setInstructions: (specId: string, facetId: string, instructions: string) => void;
  /** Applies one cardinality to every requirement in a specification at once. */
  setRequirementType: (specId: string, cardinality: Cardinality) => void;

  saveDraft: () => Promise<void>;
  loadDraft: () => Promise<boolean>;
  reset: () => void;
};

export const useIdsStore = create<IdsState>((set, get) => ({
  document: emptyDocument(),
  selectedId: null,
  dirty: false,

  setDocument: (document) =>
    set({
      document,
      selectedId: document.specifications[0]?.id ?? null,
      dirty: true,
    }),

  updateInfo: (patch) =>
    set((state) => ({
      document: { ...state.document, info: { ...state.document.info, ...patch } },
      dirty: true,
    })),

  addSpecification: () =>
    set((state) => {
      const spec = emptySpecification(
        `Specification ${state.document.specifications.length + 1}`,
      );
      return {
        document: {
          ...state.document,
          specifications: [...state.document.specifications, spec],
        },
        // Select it: adding something you then have to find is a wasted click.
        selectedId: spec.id,
        dirty: true,
      };
    }),

  updateSpecification: (id, patch) =>
    set((state) => ({
      document: {
        ...state.document,
        specifications: state.document.specifications.map((spec) =>
          spec.id === id ? { ...spec, ...patch } : spec,
        ),
      },
      dirty: true,
    })),

  setApplicabilityCardinality: (id, cardinality) =>
    set((state) => ({
      document: mapSpec(state.document, id, (spec) => ({
        ...spec,
        applicability: {
          ...spec.applicability,
          minOccurs: cardinality === "required" ? 1 : 0,
          maxOccurs: cardinality === "prohibited" ? 0 : "unbounded",
        },
      })),
      dirty: true,
    })),

  removeSpecification: (id) =>
    set((state) => {
      const remaining = state.document.specifications.filter((s) => s.id !== id);
      return {
        document: { ...state.document, specifications: remaining },
        selectedId:
          state.selectedId === id ? (remaining[0]?.id ?? null) : state.selectedId,
        dirty: true,
      };
    }),

  duplicateSpecification: (id) =>
    set((state) => {
      const source = state.document.specifications.find((s) => s.id === id);
      if (!source) return state;

      // Deep-copy with fresh local ids: sharing them would make the two
      // specifications edit each other.
      const copy: Specification = {
        ...structuredClone(source),
        id: nextId("spec"),
        name: `${source.name} (copy)`,
        applicability: {
          ...structuredClone(source.applicability),
          facets: source.applicability.facets.map((entry) => ({
            id: nextId("facet"),
            facet: structuredClone(entry.facet),
          })),
        },
        requirements: source.requirements.map((requirement) => ({
          ...structuredClone(requirement),
          id: nextId("req"),
        })),
      };

      const index = state.document.specifications.findIndex((s) => s.id === id);
      const specifications = [...state.document.specifications];
      specifications.splice(index + 1, 0, copy);

      return {
        document: { ...state.document, specifications },
        selectedId: copy.id,
        dirty: true,
      };
    }),

  reorderSpecifications: (fromId, toId) =>
    set((state) => {
      const specifications = [...state.document.specifications];
      const from = specifications.findIndex((s) => s.id === fromId);
      const to = specifications.findIndex((s) => s.id === toId);
      if (from < 0 || to < 0 || from === to) return state;

      const [moved] = specifications.splice(from, 1);
      specifications.splice(to, 0, moved);

      return { document: { ...state.document, specifications }, dirty: true };
    }),

  select: (id) => set({ selectedId: id }),

  addFacet: (specId, block, kind) =>
    set((state) => ({
      document: mapSpec(state.document, specId, (spec) =>
        block === "applicability"
          ? {
              ...spec,
              applicability: {
                ...spec.applicability,
                facets: [
                  ...spec.applicability.facets,
                  { id: nextId("facet"), facet: emptyFacet(kind) },
                ],
              },
            }
          : {
              ...spec,
              requirements: [
                ...spec.requirements,
                {
                  id: nextId("req"),
                  facet: emptyFacet(kind),
                  // Follow the specification's existing requirement type when
                  // the new facet allows it; `required` is the only
                  // cardinality every facet allows, so it is the safe
                  // fallback otherwise.
                  cardinality: allowedCardinalities(kind).includes(
                    spec.defaultRequirementCardinality ??
                      spec.requirements[0]?.cardinality ??
                      "required",
                  )
                    ? (spec.defaultRequirementCardinality ??
                        spec.requirements[0]?.cardinality ??
                        "required")
                    : "required",
                },
              ],
            },
      ),
      dirty: true,
    })),

  updateFacet: (specId, block, facetId, facet) =>
    set((state) => ({
      document: mapSpec(state.document, specId, (spec) =>
        block === "applicability"
          ? {
              ...spec,
              applicability: {
                ...spec.applicability,
                facets: spec.applicability.facets.map((entry) =>
                  entry.id === facetId ? { ...entry, facet } : entry,
                ),
              },
            }
          : {
              ...spec,
              requirements: spec.requirements.map((requirement) =>
                requirement.id === facetId ? { ...requirement, facet } : requirement,
              ),
            },
      ),
      dirty: true,
    })),

  removeFacet: (specId, block, facetId) =>
    set((state) => ({
      document: mapSpec(state.document, specId, (spec) =>
        block === "applicability"
          ? {
              ...spec,
              applicability: {
                ...spec.applicability,
                facets: spec.applicability.facets.filter((e) => e.id !== facetId),
              },
            }
          : {
              ...spec,
              requirements: spec.requirements.filter((r) => r.id !== facetId),
            },
      ),
      dirty: true,
    })),

  setCardinality: (specId, facetId, cardinality) =>
    set((state) => ({
      document: mapSpec(state.document, specId, (spec) => ({
        ...spec,
        requirements: spec.requirements.map((requirement) =>
          requirement.id === facetId ? { ...requirement, cardinality } : requirement,
        ),
      })),
      dirty: true,
    })),

  setInstructions: (specId, facetId, instructions) =>
    set((state) => ({
      document: mapSpec(state.document, specId, (spec) => ({
        ...spec,
        requirements: spec.requirements.map((requirement) =>
          requirement.id === facetId
            ? { ...requirement, instructions: instructions || undefined }
            : requirement,
        ),
      })),
      dirty: true,
    })),

  setRequirementType: (specId, cardinality) =>
    set((state) => ({
      document: mapSpec(state.document, specId, (spec) => ({
        ...spec,
        defaultRequirementCardinality: cardinality,
        // Entity/PartOf facets have no `optional` — skip those rather than
        // writing a cardinality the XSD forbids for their kind.
        requirements: spec.requirements.map((requirement) =>
          allowedCardinalities(requirement.facet.kind).includes(cardinality)
            ? { ...requirement, cardinality }
            : requirement,
        ),
      })),
      dirty: true,
    })),

  saveDraft: async () => {
    await writeJson(OPFS_NAMESPACES.ids, DRAFT_KEY, get().document);
    set({ dirty: false });
  },

  loadDraft: async () => {
    const document = await readJson<IdsDocument>(OPFS_NAMESPACES.ids, DRAFT_KEY);
    if (!document) return false;
    set({
      document,
      selectedId: document.specifications[0]?.id ?? null,
      dirty: false,
    });
    return true;
  },

  reset: () =>
    set({ document: emptyDocument(), selectedId: null, dirty: false }),
}));

function mapSpec(
  document: IdsDocument,
  id: string,
  update: (spec: Specification) => Specification,
): IdsDocument {
  return {
    ...document,
    specifications: document.specifications.map((spec) =>
      spec.id === id ? update(spec) : spec,
    ),
  };
}

/** The specification currently being edited. */
export function useSelectedSpecification(): Specification | null {
  return useIdsStore(
    (state) =>
      state.document.specifications.find((s) => s.id === state.selectedId) ?? null,
  );
}
