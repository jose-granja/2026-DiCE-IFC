"use client";

/**
 * State for the BCF module.
 *
 * One `BcfFile` is the source of truth; the list, the detail pane and the
 * export all derive from it.
 *
 * **The draft is persisted as a real `.bcf` archive**, not as JSON. Snapshots
 * and documents are `Uint8Array`s, which JSON cannot carry — they would come
 * back as `{"0":137,"1":80,…}` and every image would be silently destroyed.
 * Writing the archive reuses the tested serialiser, and it has a pleasant
 * side effect: a recovered draft is a file another tool can open.
 */

import { useMemo } from "react";
import { create } from "zustand";

import { OPFS_NAMESPACES, readBytes, writeBytes } from "@/lib/storage/opfs";
import { summariseSignature, type SignatureSummary } from "@/lib/signing/summary";
import { parseBcf, type ParseNote } from "./parse";
import { serializeBcf } from "./serialize";
import { mergeBcfFiles, type MergeConflict, type MergeStrategy } from "./merge";
import {
  EMPTY_FILTER,
  filterTopics,
  sortTopics,
  type SortDirection,
  type SortKey,
  type TopicFilter,
} from "./filter";
import {
  createComment,
  emptyBcfFile,
  bcfNow,
  type BcfComment,
  type BcfFile,
  type BcfTopic,
  type BcfViewpoint,
  type Guid,
} from "./types";

const DRAFT_FILE = "draft.bcf";

/** Fields a bulk edit may set. Everything else is per-topic by nature. */
export type BulkPatch = Pick<
  BcfTopic,
  "topicStatus" | "priority" | "topicType" | "assignedTo" | "stage" | "dueDate"
>;

type BcfState = {
  file: BcfFile;
  /** Which topic the detail pane shows. */
  selectedGuid: Guid | null;
  /** Viewer-only UI state; never written into a BCF archive. */
  editingGuid: Guid | null;
  setEditingGuid: (guid: Guid | null) => void;
  markersVisible: boolean;
  setMarkersVisible: (visible: boolean) => void;
  /** Multi-select for bulk editing, by GUID. */
  checked: Set<Guid>;

  filter: TopicFilter;
  sortKey: SortKey;
  sortDirection: SortDirection;

  dirty: boolean;
  /** Reported by the last import, for the UI to surface. */
  notes: ParseNote[];
  conflicts: MergeConflict[];
  /**
   * Signatures found on the imported archives.
   *
   * A signed BCF is the same zip with `META-INF/` added (ADR 002), so an
   * ordinary reader — including ours — opens it unchanged and the signature is
   * an extra fact about where the issues came from, not a different format.
   *
   * Keyed by file name: a merge can pull in several archives and they do not
   * all have to be signed by the same person, or at all.
   */
  signatures: Record<string, SignatureSummary>;

  /** Who new topics and comments are attributed to. */
  author: string;
  setAuthor: (author: string) => void;

  setFile: (file: BcfFile) => void;
  importArchives: (
    archives: Array<{ name: string; bytes: Uint8Array }>,
    strategy?: MergeStrategy,
  ) => void;

  addTopic: (topic: BcfTopic) => void;
  updateTopic: (guid: Guid, patch: Partial<BcfTopic>) => void;
  removeTopic: (guid: Guid) => void;
  bulkUpdate: (guids: Guid[], patch: Partial<BulkPatch>) => void;

  addComment: (guid: Guid, text: string, viewpointGuid?: Guid) => void;
  updateComment: (guid: Guid, commentGuid: Guid, text: string) => void;
  removeComment: (guid: Guid, commentGuid: Guid) => void;

  addViewpoint: (guid: Guid, viewpoint: BcfViewpoint) => void;
  removeViewpoint: (guid: Guid, viewpointGuid: Guid) => void;

  select: (guid: Guid | null) => void;
  toggleChecked: (guid: Guid) => void;
  setChecked: (guids: Guid[]) => void;
  clearChecked: () => void;

  setFilter: (patch: Partial<TopicFilter>) => void;
  clearFilter: () => void;
  setSort: (key: SortKey, direction?: SortDirection) => void;

  saveDraft: () => Promise<void>;
  loadDraft: () => Promise<boolean>;
  reset: () => void;
};

export const useBcfStore = create<BcfState>((set, get) => ({
  file: emptyBcfFile(),
  selectedGuid: null,
  editingGuid: null,
  setEditingGuid: (editingGuid) => set({ editingGuid }),
  markersVisible: false,
  setMarkersVisible: (markersVisible) => set({ markersVisible }),
  checked: new Set(),
  filter: EMPTY_FILTER,
  sortKey: "created",
  sortDirection: "desc",
  dirty: false,
  notes: [],
  conflicts: [],
  signatures: {},
  author: "",

  setAuthor: (author) => set({ author }),

  setFile: (file) =>
    set({
      file,
      selectedGuid: file.topics[0]?.guid ?? null,
      editingGuid: null,
      checked: new Set(),
      dirty: false,
      conflicts: [],
      signatures: {},
    }),

  /**
   * Import one or more archives on top of whatever is open.
   *
   * Always goes through `mergeBcfFiles`, even for a single file onto an empty
   * one: that is where GUID collisions are detected, and importing twice by
   * accident is common enough that it should be handled rather than duplicated.
   */
  importArchives: (archives, strategy = "keep-both") => {
    const notes: ParseNote[] = [];
    const parsed = archives.map(({ name, bytes }) => {
      const result = parseBcf(bytes, name);
      notes.push(...result.notes);
      return result.file;
    });

    const current = get().file;
    const inputs = current.topics.length > 0 ? [current, ...parsed] : parsed;
    const merged = mergeBcfFiles(inputs, {
      strategy,
      name: current.topics.length > 0 ? current.name : parsed[0]?.name,
      projectName: current.project.name ?? parsed[0]?.project.name,
    });

    set({
      file: merged.file,
      notes,
      conflicts: merged.conflicts,
      // No selection: importing is "show me what is in here", and the panel
      // shows a list *or* a detail. Selecting the first topic dropped the user
      // into one issue with no sense of how many arrived.
      //
      // `setFile` still selects, because its caller — the IDS validation
      // export — hands over a set it just generated and the first topic is the
      // thing to look at.
      selectedGuid: null,
      editingGuid: null,
      checked: new Set(),
      dirty: true,
    });

    // Not awaited: the topics should appear while the signatures are checked.
    for (const { name, bytes } of archives) {
      summariseSignature(bytes, name).then((signature) => {
        if (!signature) return;
        set((state) => ({ signatures: { ...state.signatures, [name]: signature } }));
      });
    }
  },

  addTopic: (topic) =>
    set((state) => ({
      file: { ...state.file, topics: [topic, ...state.file.topics] },
      selectedGuid: topic.guid,
      dirty: true,
    })),

  updateTopic: (guid, patch) =>
    set((state) => ({
      file: {
        ...state.file,
        topics: state.file.topics.map((topic) =>
          topic.guid === guid ? touch(topic, patch, state.author) : topic,
        ),
      },
      dirty: true,
    })),

  removeTopic: (guid) =>
    set((state) => {
      const topics = state.file.topics.filter((topic) => topic.guid !== guid);
      const checked = new Set(state.checked);
      checked.delete(guid);

      return {
        file: {
          ...state.file,
          // A dangling related-topic link would export as a warning in every
          // other tool, so the link goes when its target does.
          topics: topics.map((topic) =>
            topic.relatedTopics.includes(guid)
              ? {
                  ...topic,
                  relatedTopics: topic.relatedTopics.filter((id) => id !== guid),
                }
              : topic,
          ),
        },
        checked,
        selectedGuid: state.selectedGuid === guid ? (topics[0]?.guid ?? null) : state.selectedGuid,
        dirty: true,
      };
    }),

  bulkUpdate: (guids, patch) =>
    set((state) => {
      const target = new Set(guids);
      // An explicitly empty string clears a field; `undefined` leaves it alone.
      const cleaned = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      ) as Partial<BulkPatch>;

      return {
        file: {
          ...state.file,
          topics: state.file.topics.map((topic) =>
            target.has(topic.guid) ? touch(topic, cleaned, state.author) : topic,
          ),
        },
        dirty: true,
      };
    }),

  addComment: (guid, text, viewpointGuid) =>
    set((state) => ({
      file: {
        ...state.file,
        topics: state.file.topics.map((topic) =>
          topic.guid === guid
            ? {
                ...topic,
                comments: [
                  ...topic.comments,
                  createComment({
                    author: state.author || "unknown",
                    comment: text,
                    viewpointGuid,
                  }),
                ],
              }
            : topic,
        ),
      },
      dirty: true,
    })),

  updateComment: (guid, commentGuid, text) =>
    set((state) => ({
      file: {
        ...state.file,
        topics: state.file.topics.map((topic) =>
          topic.guid !== guid
            ? topic
            : {
                ...topic,
                comments: topic.comments.map((comment) =>
                  comment.guid === commentGuid
                    ? {
                        ...comment,
                        comment: text,
                        modifiedDate: bcfNow(),
                        modifiedAuthor: state.author || comment.author,
                      }
                    : comment,
                ),
              },
        ),
      },
      dirty: true,
    })),

  removeComment: (guid, commentGuid) =>
    set((state) => ({
      file: {
        ...state.file,
        topics: state.file.topics.map((topic) =>
          topic.guid !== guid
            ? topic
            : {
                ...topic,
                comments: topic.comments.filter(
                  (comment: BcfComment) => comment.guid !== commentGuid,
                ),
              },
        ),
      },
      dirty: true,
    })),

  addViewpoint: (guid, viewpoint) =>
    set((state) => ({
      file: {
        ...state.file,
        topics: state.file.topics.map((topic) =>
          topic.guid === guid
            ? { ...topic, viewpoints: [...topic.viewpoints, viewpoint] }
            : topic,
        ),
      },
      dirty: true,
    })),

  removeViewpoint: (guid, viewpointGuid) =>
    set((state) => ({
      file: {
        ...state.file,
        topics: state.file.topics.map((topic) =>
          topic.guid !== guid
            ? topic
            : {
                ...topic,
                viewpoints: topic.viewpoints.filter((v) => v.guid !== viewpointGuid),
                // A comment pointing at a deleted viewpoint would restore
                // nothing; drop the link but keep the comment.
                comments: topic.comments.map((comment) =>
                  comment.viewpointGuid === viewpointGuid
                    ? { ...comment, viewpointGuid: undefined }
                    : comment,
                ),
              },
        ),
      },
      dirty: true,
    })),

  select: (guid) => set({ selectedGuid: guid }),

  toggleChecked: (guid) =>
    set((state) => {
      const checked = new Set(state.checked);
      if (checked.has(guid)) checked.delete(guid);
      else checked.add(guid);
      return { checked };
    }),

  setChecked: (guids) => set({ checked: new Set(guids) }),
  clearChecked: () => set({ checked: new Set() }),

  setFilter: (patch) => set((state) => ({ filter: { ...state.filter, ...patch } })),
  clearFilter: () => set({ filter: EMPTY_FILTER }),

  setSort: (key, direction) =>
    set((state) => ({
      sortKey: key,
      // Clicking the active column reverses it; a new column starts ascending.
      sortDirection:
        direction ??
        (state.sortKey === key && state.sortDirection === "asc" ? "desc" : "asc"),
    })),

  saveDraft: async () => {
    const { bytes } = serializeBcf(get().file);
    await writeBytes(OPFS_NAMESPACES.bcf, DRAFT_FILE, bytes);
    set({ dirty: false });
  },

  loadDraft: async () => {
    const buffer = await readBytes(OPFS_NAMESPACES.bcf, DRAFT_FILE);
    if (!buffer) return false;

    const { file, notes } = parseBcf(new Uint8Array(buffer), DRAFT_FILE);
    set({
      file,
      notes,
      selectedGuid: file.topics[0]?.guid ?? null,
      checked: new Set(),
      dirty: false,
    });
    return true;
  },

  reset: () =>
    set({
      file: emptyBcfFile(),
      selectedGuid: null,
      editingGuid: null,
      markersVisible: false,
      checked: new Set(),
      filter: EMPTY_FILTER,
      dirty: false,
      notes: [],
      conflicts: [],
      signatures: {},
    }),
}));

/** Stamp the modification fields any edit should update. */
function touch(
  topic: BcfTopic,
  patch: Partial<BcfTopic>,
  author: string,
): BcfTopic {
  return {
    ...topic,
    ...patch,
    modifiedDate: bcfNow(),
    modifiedAuthor: author || topic.modifiedAuthor,
  };
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/**
 * The filtered, sorted topic list.
 *
 * Raw state is selected and the derivation happens in `useMemo`. Doing the
 * filtering *inside* a zustand selector builds a new array on every store read,
 * which zustand compares by reference — so it never settles and React bails
 * with "maximum update depth exceeded". That has bitten this codebase twice.
 */
export function useVisibleTopics(): BcfTopic[] {
  const topics = useBcfStore((s) => s.file.topics);
  const filter = useBcfStore((s) => s.filter);
  const sortKey = useBcfStore((s) => s.sortKey);
  const sortDirection = useBcfStore((s) => s.sortDirection);

  return useMemo(
    () => sortTopics(filterTopics(topics, filter), sortKey, sortDirection),
    [topics, filter, sortKey, sortDirection],
  );
}

export function useSelectedTopic(): BcfTopic | null {
  const topics = useBcfStore((s) => s.file.topics);
  const selectedGuid = useBcfStore((s) => s.selectedGuid);

  return useMemo(
    () => topics.find((topic) => topic.guid === selectedGuid) ?? null,
    [topics, selectedGuid],
  );
}
