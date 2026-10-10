"use client";

/**
 * IDS failures → a BCF 3.0 issue set.
 *
 * This is the handover the whole brief builds towards: a validation report that
 * a site engineer can open in Solibri, Navisworks or BIMcollab and walk through
 * issue by issue, each one framing the element that failed.
 *
 * Nothing here writes XML or zips anything — `lib/bcf/serialize.ts` does that,
 * and it is validated against the vendored buildingSMART XSDs. This file only
 * builds the `BcfFile`, which means the report inherits every guarantee Phase 7
 * already established: schema-valid output, lowercase GUIDs, a camera on every
 * viewpoint.
 *
 * ## Grouping
 *
 * One topic per failing **entity per specification** is the default. Grouping
 * per specification instead produces a handful of topics, each naming hundreds
 * of elements — which reads well as a summary and is useless as a task list,
 * because a topic is the unit a reviewer assigns and closes. Both are offered;
 * the default is the one that maps onto work.
 */

import { captureViewpoint } from "@/lib/bcf/actions";
import { resolveGlobalIds } from "@/lib/bcf/resolver";
import {
  createComment,
  createTopic,
  emptyBcfFile,
  newGuid,
  type BcfFile,
  type BcfTopic,
  type BcfViewpoint,
} from "@/lib/bcf/types";
import { getActiveRenderer } from "@/lib/viewer/active-renderer";
import { useViewerStore } from "@/lib/viewer/store";
import { allFailures, describeFailure, type Failure, type ValidationRun } from "./report";

export type BcfExportGrouping = "per-failure" | "per-specification";

export type BcfExportOptions = {
  grouping?: BcfExportGrouping;
  author?: string;
  /**
   * Frame each failing element in the viewer and grab the canvas.
   *
   * Off by default and genuinely expensive: it drives the real renderer once
   * per topic, so a thousand failures is a thousand camera moves and a thousand
   * PNG encodes. It is also the thing that makes the export worth having, so
   * the UI offers it with a warning rather than hiding it.
   */
  captureSnapshots?: boolean;
  /** Cap on how many topics get a snapshot, when capturing. */
  maxSnapshots?: number;
  onProgress?: (done: number, total: number) => void;
  /**
   * Called once, the moment a run has more failing groups than
   * `maxSnapshots` — every topic after that point is still written, just
   * with no viewpoint. Silent otherwise: hitting the budget on a genuinely
   * large report is routine, not a failure, but every topic past it looking
   * identical to a topic that simply had no snapshot requested is not
   * something the UI should leave the author to notice on their own.
   */
  onSnapshotBudgetExceeded?: () => void;
  signal?: AbortSignal;
};

export const DEFAULT_MAX_SNAPSHOTS = 200;

/**
 * Build the issue set.
 *
 * Async because capturing a viewpoint has to let the renderer draw a frame
 * between camera moves — see `frameAndCapture`.
 */
export async function reportToBcf(
  run: ValidationRun,
  options: BcfExportOptions = {},
): Promise<BcfFile> {
  const grouping = options.grouping ?? "per-failure";
  const author = options.author || "DiCE-IFC";

  const file = emptyBcfFile(`${slug(run.idsTitle)}.bcf`);
  file.project = { projectId: newGuid(), name: run.idsTitle };
  file.extensions = {
    ...file.extensions,
    topicTypes: ["Issue", "Clash", "Error", "Warning", "Info", "Request", "Remark"],
    topicStatuses: ["Open", "In Progress", "Resolved", "Closed"],
    priorities: ["Low", "Normal", "High", "Critical"],
    topicLabels: ["IDS", ...run.specifications.map((s) => s.name)],
    users: author ? [author] : [],
  };

  const groups =
    grouping === "per-failure"
      ? allFailures(run).map((failure) => [failure])
      : run.specifications
          .filter((specification) => specification.failures.length > 0)
          .map((specification) => specification.failures);

  const budget = options.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS;
  let captured = 0;
  let budgetWarned = false;

  for (const [index, group] of groups.entries()) {
    if (options.signal?.aborted) break;

    const topic = topicFor(group, run, author, grouping);

    if (options.captureSnapshots) {
      if (captured < budget) {
        const viewpoint = await frameAndCapture(group);
        if (viewpoint) {
          topic.viewpoints.push(viewpoint);
          captured += 1;
        }
      } else if (!budgetWarned) {
        budgetWarned = true;
        options.onSnapshotBudgetExceeded?.();
      }
    }

    file.topics.push(topic);
    options.onProgress?.(index + 1, groups.length);
  }

  return file;
}

function topicFor(
  group: Failure[],
  run: ValidationRun,
  author: string,
  grouping: BcfExportGrouping,
): BcfTopic {
  const first = group[0];
  const specification = run.specifications.find(
    (candidate) => candidate.index === first.specificationIndex,
  );

  const title =
    grouping === "per-failure"
      ? `${first.type}${first.name ? ` “${first.name}”` : ""} — ${first.specificationName}`
      : `${first.specificationName} — ${group.length} failing element${group.length === 1 ? "" : "s"}`;

  const topic = createTopic({
    title,
    author,
    topicType: "Issue",
    topicStatus: "Open",
    // An element that fails a specification is a defect against an agreed
    // requirement, not a query — "Normal" understates it and "Critical" is the
    // reviewer's call, not ours.
    priority: "High",
    description: descriptionFor(group, specification?.description),
    labels: ["IDS", first.specificationName],
  });

  // The IFC the failure came from, so opening the viewpoint later can pick the
  // right reference frame (see lib/bcf/actions.ts).
  topic.headerFiles.push({
    isExternal: true,
    filename: first.modelName,
    date: run.finishedAt,
  });

  topic.comments.push(
    createComment({
      author,
      comment: `Raised automatically from IDS “${run.idsTitle}” on ${run.finishedAt.slice(0, 10)}.`,
    }),
  );

  return topic;
}

function descriptionFor(group: Failure[], specificationDescription?: string): string {
  const lines: string[] = [];

  if (specificationDescription) lines.push(specificationDescription, "");

  if (group.length === 1) {
    const failure = group[0];
    lines.push(`${failure.type} #${failure.expressId} in ${failure.modelName}`);
    if (failure.globalId) lines.push(`GlobalId: ${failure.globalId}`);
    lines.push("");
    for (const requirement of failure.requirements) {
      lines.push(`• ${requirement.failureReason ?? requirement.description}`);
    }
  } else {
    lines.push(`${group.length} elements do not satisfy this specification:`, "");
    // Capped: a description listing 4,000 elements is unreadable in every tool
    // that renders it, and the components are on the viewpoint anyway.
    for (const failure of group.slice(0, 50)) {
      lines.push(
        `• ${failure.type} #${failure.expressId}${failure.name ? ` “${failure.name}”` : ""} — ${describeFailure(failure)}`,
      );
    }
    if (group.length > 50) lines.push(`…and ${group.length - 50} more.`);
  }

  return lines.join("\n");
}

/**
 * Isolate the failing elements, frame them, and capture the viewport.
 *
 * The viewer state is saved and restored around this. Without that, exporting a
 * report would leave the user staring at the last failing element with
 * everything else hidden, which looks exactly like a crash.
 */
async function frameAndCapture(group: Failure[]): Promise<BcfViewpoint | null> {
  const renderer = getActiveRenderer();
  if (!renderer) return null;

  const globalIds = group
    .map((failure) => failure.globalId)
    .filter((id): id is string => Boolean(id));
  if (globalIds.length === 0) return null;

  const store = useViewerStore.getState();
  const modelIds = store.models
    .filter((model) => model.load.status === "ready")
    .map((model) => model.summary.id);

  const { refs } = await resolveGlobalIds(globalIds, modelIds);
  if (refs.length === 0) return null;

  const saved = {
    hidden: store.hidden,
    isolated: store.isolated,
    selection: store.selection,
    camera: renderer.getCameraState(),
  };

  try {
    store.isolate(refs);
    store.select(refs);

    // Let the isolation reach the GPU before framing: `fitToBounds` reads the
    // visible geometry, and one frame has to have been drawn with the new
    // visibility for that to mean anything.
    await nextFrame();
    // Not `store.federationBounds()` — that covers every visible *model*,
    // so the camera used to fit the whole building instead of the one
    // failing element, and a snapshot of a huge scene with one tiny
    // highlighted wall reads as "no image" even though a real PNG was
    // captured. `boundsOfRefs` frames exactly the isolated refs.
    renderer.fitToBounds(renderer.boundsOfRefs(refs));
    await nextFrame();

    return await captureViewpoint(group[0].modelName);
  } finally {
    useViewerStore.setState({
      hidden: saved.hidden,
      isolated: saved.isolated,
      selection: saved.selection,
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
  const base = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "ids-report";
}
