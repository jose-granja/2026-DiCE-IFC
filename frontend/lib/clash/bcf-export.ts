"use client";

/**
 * Clashes → a BCF 3.0 issue set, one topic per clash, each with a viewpoint
 * and a snapshot of the two elements meeting.
 *
 * Like the IDS export, this only builds the `BcfFile`; `lib/bcf/serialize.ts`
 * writes and validates it.
 */

import { captureViewpoint } from "@/lib/bcf/actions";
import {
  createComment,
  createTopic,
  emptyBcfFile,
  newGuid,
  type BcfFile,
  type BcfTopic,
} from "@/lib/bcf/types";
import { getActiveRenderer } from "@/lib/viewer/active-renderer";
import { useViewerStore } from "@/lib/viewer/store";
import { CLASH_COLOUR_A, CLASH_COLOUR_B } from "./colours";
import { clashView } from "./frame";
import { withClashHighlightPaused } from "./highlight";
import type { ClashKind, ClashResultItem } from "./types";

export { CLASH_COLOUR_A, CLASH_COLOUR_B };
export const DEFAULT_MAX_CLASH_SNAPSHOTS = 200;

export type ClashBcfOptions = {
  author?: string;
  /** Frame each clash and capture the viewport. Expensive: one camera move and PNG per clash. */
  captureSnapshots?: boolean;
  /** Show only the two elements in each snapshot, instead of the whole model. */
  isolate?: boolean;
  maxSnapshots?: number;
  title?: string;
  onProgress?: (done: number, total: number) => void;
  onSnapshotBudgetExceeded?: () => void;
  signal?: AbortSignal;
};

const KIND_LABEL: Record<ClashKind, string> = {
  hard: "Hard clash",
  clearance: "Clearance",
  inside: "Element inside another",
  duplicate: "Duplicate",
};

export async function clashesToBcf(
  items: ClashResultItem[],
  options: ClashBcfOptions = {},
): Promise<BcfFile> {
  const author = options.author || "DiCE-IFC";
  const title = options.title ?? "Clash detection";
  const file = emptyBcfFile(`${slug(title)}.bcf`);
  file.project = { projectId: newGuid(), name: title };
  file.extensions = {
    ...file.extensions,
    topicTypes: ["Clash", "Issue", "Error", "Warning", "Info", "Request", "Remark"],
    topicStatuses: ["Open", "In Progress", "Resolved", "Closed"],
    priorities: ["Low", "Normal", "High", "Critical"],
    topicLabels: ["Clash", ...new Set(items.map((item) => item.rule))],
    users: author ? [author] : [],
  };

  const budget = options.maxSnapshots ?? DEFAULT_MAX_CLASH_SNAPSHOTS;
  let captured = 0;
  let budgetWarned = false;

  for (const [index, item] of items.entries()) {
    if (options.signal?.aborted) break;

    const topic = topicFor(item, author);

    if (options.captureSnapshots) {
      if (captured < budget) {
        const viewpoint = await withClashHighlightPaused(() =>
          frameAndCapture(item, options.isolate ?? true),
        );
        if (viewpoint?.components) {
          topic.viewpoints.push(viewpoint);
          captured += 1;
        }
      } else if (!budgetWarned) {
        budgetWarned = true;
        options.onSnapshotBudgetExceeded?.();
      }
    }

    file.topics.push(topic);
    options.onProgress?.(index + 1, items.length);
  }

  return file;
}

function topicFor(item: ClashResultItem, author: string): BcfTopic {
  const { elementA: a, elementB: b } = item;
  const topic = createTopic({
    title: `${label(a)} × ${label(b)}`,
    author,
    topicType: "Clash",
    topicStatus: "Open",
    priority: item.kind === "hard" || item.kind === "inside" ? "High" : "Normal",
    description: describe(item),
    labels: ["Clash", item.rule],
  });

  for (const filename of new Set([a.modelName, b.modelName])) {
    topic.headerFiles.push({ isExternal: true, filename, date: new Date().toISOString() });
  }

  topic.comments.push(
    createComment({
      author,
      comment: `Raised automatically by clash detection (${item.rule}, tolerance “${item.toleranceName}”).`,
    }),
  );
  return topic;
}

const label = (element: ClashResultItem["elementA"]) =>
  `${element.type}${element.name ? ` “${element.name}”` : ""}`;

function describe(item: ClashResultItem): string {
  const { elementA: a, elementB: b } = item;
  const lines = [
    `${KIND_LABEL[item.kind]} — ${item.rule}`,
    `Tolerance: ${item.toleranceName}`,
    item.kind === "clearance"
      ? `Gap between the elements: ${(item.distance * 1000).toFixed(0)} mm`
      : item.kind === "hard"
        ? `Overlap depth: ${(item.depth * 1000).toFixed(0)} mm (overlap ${item.extent.map((value) => value.toFixed(3)).join(" × ")} m)`
        : `Region where they meet: ${item.extent.map((value) => value.toFixed(3)).join(" × ")} m`,
    "",
  ];
  for (const [heading, element] of [["Element A", a], ["Element B", b]] as const) {
    lines.push(`${heading}: ${label(element)} #${element.expressId} in ${element.modelName}`);
    if (element.globalId) lines.push(`  GlobalId: ${element.globalId}`);
  }
  return lines.join("\n");
}

/**
 * Show the two elements, frame where they meet, and capture. The viewer's own
 * state is put back afterwards: without that, exporting would leave the user
 * looking at the last clash with everything else hidden, which looks like a
 * crash.
 */
async function frameAndCapture(item: ClashResultItem, isolate: boolean) {
  const renderer = getActiveRenderer();
  if (!renderer) return null;

  const store = useViewerStore.getState();
  const refs = [item.elementA, item.elementB].map(({ modelId, expressId }) => ({ modelId, expressId }));
  if (!refs.every((ref) => store.models.some((model) => model.summary.id === ref.modelId))) return null;

  const saved = {
    hidden: store.hidden,
    isolated: store.isolated,
    selection: store.selection,
    colouring: store.colouring,
    camera: renderer.getCameraState(),
  };

  try {
    if (isolate) store.isolate(refs);
    // Nothing selected while capturing: a selected element is painted the
    // selection blue, which would hide the red/blue that tells A from B.
    store.clearSelection();
    useViewerStore.setState({
      colouring: new Map([
        [item.elementA.key, CLASH_COLOUR_A],
        [item.elementB.key, CLASH_COLOUR_B],
      ]),
    });

    await nextFrame();
    // Frame the meeting point with room around it, not the whole of two long
    // elements: a snapshot of a 30 m wall with a pipe through it reads as
    // "no image" if the pipe is a speck.
    const view = clashView(item);
    renderer.fitToBounds(view.bounds, view.direction);
    await nextFrame();

    const viewpoint = await captureViewpoint(item.elementA.modelName);
    // The viewpoint still names the two elements, so a BCF tool can select them.
    if (viewpoint?.components) {
      viewpoint.components.selection = [item.elementA, item.elementB]
        .filter((element) => element.globalId)
        .map((element) => ({ ifcGuid: element.globalId, originatingSystem: "DiCE-IFC" }));
    }
    return viewpoint;
  } finally {
    useViewerStore.setState({
      hidden: saved.hidden,
      isolated: saved.isolated,
      selection: saved.selection,
      colouring: saved.colouring,
    });
    renderer.setCameraState(saved.camera);
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

function slug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "clash-detection"
  );
}
