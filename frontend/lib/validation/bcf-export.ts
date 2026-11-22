"use client";

/**
 * IFC validation findings → a BCF 3.0 issue set (ADR 018).
 *
 * Like the IDS and clash exports, this only builds the `BcfFile`;
 * `lib/bcf/serialize.ts` writes it and checks it against buildingSMART's XSDs.
 *
 * Errors and warnings only. **One topic per rule** by default: a rule can find
 * thousands of instances (QTY001: 1 595 quantity sets on one model), and a topic
 * is what a reviewer assigns and closes. One topic per occurrence is offered for
 * short lists. A snapshot frames the instance when it is an element that is drawn;
 * many findings are about things that are not (a polyline, a property set) and
 * have no GlobalId either, so their topic names the STEP `#id` in its text.
 */

import { captureViewpoint } from "@/lib/bcf/actions";
import { createComment, createTopic, emptyBcfFile, newGuid, type BcfFile, type BcfTopic, type BcfViewpoint } from "@/lib/bcf/types";
import { getActiveRenderer } from "@/lib/viewer/active-renderer";
import { useViewerStore } from "@/lib/viewer/store";
import { describeValue, findingGroups, type FindingGroup } from "./findings";
import { groupExplanation, groupTitle, outcomeNote, type ExplainTranslate } from "./explain";
import type { StageResult, ValidationOutcome, ValidationStage } from "./stages";

export type ValidationBcfGrouping = "per-rule" | "per-occurrence";

/** Words, in the interface's language: keys under `validationExport`. */
export type ExportTranslate = (key: string, values?: Record<string, string | number>) => string;

export type ValidationBcfInput = {
  modelId: string;
  modelName: string;
  validatedAt: Date;
  results: Partial<Record<ValidationStage, StageResult>>;
};

export type ValidationBcfOptions = {
  grouping?: ValidationBcfGrouping;
  author?: string;
  captureSnapshots?: boolean;
  maxSnapshots?: number;
  onProgress?: (done: number, total: number) => void;
  onSnapshotBudgetExceeded?: () => void;
  signal?: AbortSignal;
  /** Says what each finding means (`explain.ts`, `validationExplain`); without it, the service's own words. */
  explain?: ExplainTranslate;
};

export const DEFAULT_MAX_VALIDATION_SNAPSHOTS = 200;
/** A topic description lists at most this many occurrences; the rest are counted. */
const LISTED = 50;

export async function validationToBcf(
  input: ValidationBcfInput,
  t: ExportTranslate,
  options: ValidationBcfOptions = {},
): Promise<BcfFile> {
  const author = options.author || "DiCE-IFC";
  const grouping = options.grouping ?? "per-rule";
  const projectName = t("projectName", { model: input.modelName });
  const file = emptyBcfFile(`${slug(input.modelName)}-validation.bcf`);
  file.project = { projectId: newGuid(), name: projectName };

  const groups = findingGroups(input.results);
  const topics: Array<{ group: FindingGroup; outcomes: ValidationOutcome[] }> =
    grouping === "per-rule"
      ? groups.map((group) => ({ group, outcomes: group.outcomes }))
      : groups.flatMap((group) => group.outcomes.map((outcome) => ({ group, outcomes: [outcome] })));

  file.extensions = {
    ...file.extensions,
    topicTypes: ["Error", "Warning", "Issue", "Info"],
    topicStatuses: ["Open", "In Progress", "Resolved", "Closed"],
    priorities: ["Low", "Normal", "High", "Critical"],
    topicLabels: [t("label"), ...new Set(groups.map((g) => g.label))],
    users: author ? [author] : [],
  };

  const budget = options.maxSnapshots ?? DEFAULT_MAX_VALIDATION_SNAPSHOTS;
  let captured = 0;
  let warned = false;
  for (const [index, { group, outcomes }] of topics.entries()) {
    if (options.signal?.aborted) break;
    const topic = topicFor(group, outcomes, input, author, t, options.explain);
    if (options.captureSnapshots) {
      const ids = [...new Set(outcomes.map((o) => o.inst).filter((id): id is number => typeof id === "number"))];
      if (ids.length > 0) {
        if (captured < budget) {
          const viewpoint = await frameAndCapture(input.modelId, input.modelName, ids);
          if (viewpoint) {
            topic.viewpoints.push(viewpoint);
            captured += 1;
          }
        } else if (!warned) {
          warned = true;
          options.onSnapshotBudgetExceeded?.();
        }
      }
    }
    file.topics.push(topic);
    options.onProgress?.(index + 1, topics.length);
  }
  return file;
}

function topicFor(
  group: FindingGroup,
  outcomes: ValidationOutcome[],
  input: ValidationBcfInput,
  author: string,
  t: ExportTranslate,
  explain?: ExplainTranslate,
): BcfTopic {
  const one = outcomes.length === 1 ? outcomes[0] : null;
  const subject = one?.inst ? `${one.entity ?? ""} #${one.inst}`.trim() : null;
  const title = subject
    ? `${group.label} — ${subject}`
    : t("topicTitle", { rule: explain && group.kind !== "rule" ? groupTitle(group, explain) : group.title, count: outcomes.length });
  const topic = createTopic({
    title: title.length > 255 ? `${title.slice(0, 254)}…` : title,
    author,
    topicType: group.severity === "ERROR" ? "Error" : "Warning",
    topicStatus: "Open",
    priority: group.severity === "ERROR" ? "High" : "Normal",
    description: descriptionFor(group, outcomes, t, explain),
    labels: [t("label"), group.label],
  });
  topic.headerFiles.push({ isExternal: true, filename: input.modelName, date: input.validatedAt.toISOString() });
  if (group.doc) topic.referenceLinks.push(group.doc);
  topic.comments.push(createComment({
    author,
    comment: t(group.stage === "dice_rules" ? "commentCustom" : "comment", { stage: t(`stages.${group.stage}`), date: input.validatedAt.toISOString().slice(0, 10) }),
  }));
  return topic;
}

function descriptionFor(group: FindingGroup, outcomes: ValidationOutcome[], t: ExportTranslate, explain?: ExplainTranslate): string {
  const lines = [explain ? groupTitle(group, explain) : group.title, `${t("stage")}: ${t(`stages.${group.stage}`)}`];
  if (group.doc) lines.push(`${t("rule")}: ${group.doc}`);
  const explanation = explain ? groupExplanation(group, explain) : null;
  if (explanation) lines.push("", explanation);
  lines.push("");
  for (const o of outcomes.slice(0, LISTED)) {
    const where = o.inst ? `${o.entity ?? ""} #${o.inst}`.trim() : t("noInstance");
    const parts = [where];
    const note = explain ? outcomeNote(o, group, explain) : null;
    if (note) parts.push(note);
    else {
      if (o.expected != null) parts.push(`${t("expected")} ${describeValue(o.expected)}`);
      if (o.observed != null) parts.push(`${t("observed")} ${describeValue(o.observed)}`);
    }
    lines.push(`• ${parts.join(" — ")}`);
  }
  if (outcomes.length > LISTED) lines.push(t("andMore", { count: outcomes.length - LISTED }));
  return lines.join("\n");
}

/**
 * Isolate the instances that are drawn, frame them and capture the viewport —
 * then put the viewer back as it was, or exporting would leave everything hidden.
 */
async function frameAndCapture(modelId: string, modelName: string, ids: number[]): Promise<BcfViewpoint | null> {
  const renderer = getActiveRenderer();
  const store = useViewerStore.getState();
  if (!renderer || !store.models.some((m) => m.summary.id === modelId)) return null;
  const refs = ids.map((expressId) => ({ modelId, expressId }));
  // Only what is drawn can be framed: a polyline or a property set has no shape of its own.
  const bounds = renderer.boundsOfRefs(refs);
  if (!bounds) return null;
  const saved = { hidden: store.hidden, isolated: store.isolated, selection: store.selection, camera: renderer.getCameraState() };
  try {
    store.isolate(refs);
    store.select(refs);
    await nextFrame();
    renderer.fitToBounds(renderer.boundsOfRefs(refs));
    await nextFrame();
    return await captureViewpoint(modelName);
  } finally {
    useViewerStore.setState({ hidden: saved.hidden, isolated: saved.isolated, selection: saved.selection });
    renderer.setCameraState(saved.camera);
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function slug(value: string): string {
  return value.replace(/\.[^.]+$/, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "model";
}
