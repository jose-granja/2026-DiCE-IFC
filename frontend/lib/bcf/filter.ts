/**
 * Filtering and sorting the topic list.
 *
 * Pure, so the behaviour that matters — "overdue" meaning what a site engineer
 * expects, priority sorting by severity rather than alphabetically — is
 * testable without a browser.
 */

import type { BcfTopic } from "./types";

export type DueFilter = "any" | "overdue" | "soon" | "none";

export type TopicFilter = {
  /** Matched against title, description, labels and comment text. */
  search: string;
  statuses: string[];
  priorities: string[];
  types: string[];
  assignees: string[];
  labels: string[];
  due: DueFilter;
};

export const EMPTY_FILTER: TopicFilter = {
  search: "",
  statuses: [],
  priorities: [],
  types: [],
  assignees: [],
  labels: [],
  due: "any",
};

export function isFilterActive(filter: TopicFilter): boolean {
  return (
    filter.search.trim() !== "" ||
    filter.statuses.length > 0 ||
    filter.priorities.length > 0 ||
    filter.types.length > 0 ||
    filter.assignees.length > 0 ||
    filter.labels.length > 0 ||
    filter.due !== "any"
  );
}

/**
 * `now` is a parameter rather than a call to `Date.now()` so "overdue" is
 * testable and so a long-lived tab does not filter against the time it opened.
 */
export function filterTopics(
  topics: BcfTopic[],
  filter: TopicFilter,
  now: number = Date.now(),
): BcfTopic[] {
  const needle = filter.search.trim().toLowerCase();

  return topics.filter((topic) => {
    if (needle && !matches(topic, needle)) return false;

    // Each facet is an OR within itself and an AND against the others, which is
    // what a multi-select filter bar reads as.
    if (filter.statuses.length > 0 && !filter.statuses.includes(topic.topicStatus ?? "")) {
      return false;
    }
    if (
      filter.priorities.length > 0 &&
      !filter.priorities.includes(topic.priority ?? "")
    ) {
      return false;
    }
    if (filter.types.length > 0 && !filter.types.includes(topic.topicType ?? "")) {
      return false;
    }
    if (
      filter.assignees.length > 0 &&
      !filter.assignees.includes(topic.assignedTo ?? "")
    ) {
      return false;
    }
    if (
      filter.labels.length > 0 &&
      !filter.labels.some((label) => topic.labels.includes(label))
    ) {
      return false;
    }

    return matchesDue(topic, filter.due, now);
  });
}

function matches(topic: BcfTopic, needle: string): boolean {
  const haystack = [
    topic.title,
    topic.description ?? "",
    topic.assignedTo ?? "",
    topic.creationAuthor,
    ...topic.labels,
    ...topic.comments.map((comment) => comment.comment),
  ]
    .join("\n")
    .toLowerCase();

  return haystack.includes(needle);
}

const WEEK = 7 * 24 * 60 * 60 * 1000;

function matchesDue(topic: BcfTopic, due: DueFilter, now: number): boolean {
  if (due === "any") return true;
  if (due === "none") return !topic.dueDate;
  if (!topic.dueDate) return false;

  const at = Date.parse(topic.dueDate);
  if (!Number.isFinite(at)) return false;

  // "Overdue" excludes topics nobody needs to chase any more; a closed topic
  // past its date is history, not a task.
  if (due === "overdue") return at < now && !isClosed(topic);
  return at >= now && at <= now + WEEK;
}

/**
 * Statuses are project-defined, so this is a heuristic and is only ever used to
 * calm down the overdue filter — never to hide a topic outright.
 */
export function isClosed(topic: BcfTopic): boolean {
  const status = (topic.topicStatus ?? "").trim().toLowerCase();
  return ["closed", "resolved", "fechado", "resolvido", "done"].includes(status);
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export type SortKey =
  | "index"
  | "title"
  | "status"
  | "priority"
  | "type"
  | "assignee"
  | "created"
  | "modified"
  | "due";

export type SortDirection = "asc" | "desc";

/**
 * Severity ranks for the priorities the standard's examples use.
 *
 * Sorting priorities alphabetically puts Critical above High above Low above
 * Normal, which is meaningless. Anything unrecognised — and priorities are
 * project-defined, so plenty will be — sorts after the known ones,
 * alphabetically among themselves, rather than being silently treated as
 * "Normal".
 */
const PRIORITY_RANK: Record<string, number> = {
  critical: 0,
  crítico: 0,
  high: 1,
  alta: 1,
  normal: 2,
  média: 2,
  medium: 2,
  low: 3,
  baixa: 3,
};

export function sortTopics(
  topics: BcfTopic[],
  key: SortKey,
  direction: SortDirection = "asc",
): BcfTopic[] {
  const sign = direction === "asc" ? 1 : -1;

  return [...topics].sort((a, b) => {
    const result = compare(a, b, key);
    // Title is the tiebreak so the order is total: an unstable list that
    // reshuffles on every edit is disorienting.
    return (result !== 0 ? result : a.title.localeCompare(b.title)) * sign;
  });
}

function compare(a: BcfTopic, b: BcfTopic, key: SortKey): number {
  switch (key) {
    case "index":
      return (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER);
    case "title":
      return a.title.localeCompare(b.title);
    case "status":
      return text(a.topicStatus).localeCompare(text(b.topicStatus));
    case "type":
      return text(a.topicType).localeCompare(text(b.topicType));
    case "assignee":
      return text(a.assignedTo).localeCompare(text(b.assignedTo));
    case "priority":
      return priorityRank(a.priority) - priorityRank(b.priority) ||
        text(a.priority).localeCompare(text(b.priority));
    case "created":
      return time(a.creationDate) - time(b.creationDate);
    case "modified":
      return (
        time(a.modifiedDate ?? a.creationDate) - time(b.modifiedDate ?? b.creationDate)
      );
    case "due":
      return time(a.dueDate) - time(b.dueDate);
  }
}

function priorityRank(priority: string | undefined): number {
  if (!priority) return 100;
  return PRIORITY_RANK[priority.trim().toLowerCase()] ?? 50;
}

/** Undefined sorts last in ascending order rather than first. */
function time(value: string | undefined): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function text(value: string | undefined): string {
  // A leading "￿" would sort empties last, but localeCompare ignores it;
  // an empty string sorting first is fine and predictable.
  return value ?? "";
}
