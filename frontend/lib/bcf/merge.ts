/**
 * Merging BCF files.
 *
 * The reason this is not a concatenation: BCF topics are identified by GUID,
 * and the same GUID legitimately appears in two files whenever both were
 * exported from the same source. Sometimes that means "the same topic twice",
 * and sometimes it means "the same topic, edited by two people". Those need
 * opposite treatment, and picking wrong loses somebody's work.
 *
 * So collisions are classified rather than resolved by luck:
 *
 * - **identical** — the two topics agree on everything that matters. One is
 *   kept and nothing is reported as a conflict, because nothing was lost.
 * - **divergent** — they disagree. What happens then is the caller's choice,
 *   and both outcomes are reported so the UI can say what it did.
 *
 * Related-topic links are rewritten alongside any GUID that changes. A merge
 * that silently breaks the links between topics would be worse than no merge.
 */

import { mergeExtensions as unionExtensions, newGuid } from "./types";
import type { BcfDocument, BcfFile, BcfTopic, Guid } from "./types";

/**
 * What to do when two files disagree about a topic with the same GUID.
 *
 * `keep-both` is the default because it cannot lose data: the incoming topic
 * is given a fresh GUID and both survive for a human to reconcile. `keep-newest`
 * is the convenient one, and it does discard a topic.
 */
export type MergeStrategy = "keep-both" | "keep-newest";

export type MergeConflict = {
  guid: Guid;
  title: string;
  /** Names of the files that both claimed this GUID. */
  sources: [string, string];
  resolution: "kept-both" | "kept-newest" | "kept-existing";
  /** Set when `kept-both` had to issue a new GUID. */
  newGuid?: Guid;
};

export type MergeResult = {
  file: BcfFile;
  conflicts: MergeConflict[];
  /** Topics that appeared in more than one file and were identical. */
  duplicates: number;
};

export type MergeOptions = {
  strategy?: MergeStrategy;
  /** Name for the merged file. */
  name?: string;
  projectName?: string;
};

export function mergeBcfFiles(
  files: BcfFile[],
  options: MergeOptions = {},
): MergeResult {
  const strategy = options.strategy ?? "keep-both";
  const conflicts: MergeConflict[] = [];
  let duplicates = 0;

  const topics = new Map<Guid, { topic: BcfTopic; source: string }>();
  const documents = new Map<Guid, BcfDocument>();
  let extensions = files[0]?.extensions ?? {
    topicTypes: [],
    topicStatuses: [],
    priorities: [],
    topicLabels: [],
    users: [],
    snippetTypes: [],
    stages: [],
  };

  for (const file of files) {
    extensions = unionExtensions(extensions, file.extensions);

    for (const document_ of file.documents) {
      // Documents are content, not opinion: first one wins and the rest are
      // the same bytes under the same GUID.
      if (!documents.has(document_.guid)) documents.set(document_.guid, document_);
    }

    // Renames within this file, so its own related-topic links follow.
    const renamed = new Map<Guid, Guid>();

    for (const incoming of file.topics) {
      const existing = topics.get(incoming.guid);

      if (!existing) {
        topics.set(incoming.guid, { topic: incoming, source: file.name });
        continue;
      }

      if (sameTopic(existing.topic, incoming)) {
        duplicates += 1;
        continue;
      }

      if (strategy === "keep-newest") {
        const winner = newest(existing.topic, incoming);
        topics.set(incoming.guid, {
          topic: winner,
          source: winner === incoming ? file.name : existing.source,
        });
        conflicts.push({
          guid: incoming.guid,
          title: winner.title,
          sources: [existing.source, file.name],
          resolution: winner === incoming ? "kept-newest" : "kept-existing",
        });
        continue;
      }

      const replacement = newGuid();
      renamed.set(incoming.guid, replacement);
      topics.set(replacement, {
        topic: { ...incoming, guid: replacement },
        source: file.name,
      });
      conflicts.push({
        guid: incoming.guid,
        title: incoming.title,
        sources: [existing.source, file.name],
        resolution: "kept-both",
        newGuid: replacement,
      });
    }

    if (renamed.size > 0) rewriteRelated(topics, file.name, renamed);
  }

  return {
    file: {
      sourceVersion: "3.0",
      name: options.name ?? "merged.bcf",
      project: {
        projectId: files[0]?.project.projectId,
        name: options.projectName ?? files[0]?.project.name,
      },
      extensions,
      topics: [...topics.values()].map((entry) => entry.topic),
      documents: [...documents.values()],
    },
    conflicts,
    duplicates,
  };
}

/**
 * Point related-topic links at the new GUIDs.
 *
 * Scoped to the file the renames came from: a link in *another* file that
 * happens to name the same GUID meant the topic that was already there, and
 * redirecting it would move a relationship the user never touched.
 */
function rewriteRelated(
  topics: Map<Guid, { topic: BcfTopic; source: string }>,
  source: string,
  renamed: Map<Guid, Guid>,
) {
  for (const [key, entry] of topics) {
    if (entry.source !== source) continue;

    const related = entry.topic.relatedTopics.map((guid) => renamed.get(guid) ?? guid);
    if (related.some((guid, index) => guid !== entry.topic.relatedTopics[index])) {
      topics.set(key, { ...entry, topic: { ...entry.topic, relatedTopics: related } });
    }
  }
}

/**
 * Whether two topics with the same GUID are the same topic.
 *
 * Compares what a reviewer would call the content. `modifiedDate` is
 * deliberately excluded — a re-export that changed nothing else routinely
 * bumps it, and treating that as a conflict would make every merge noisy.
 */
function sameTopic(a: BcfTopic, b: BcfTopic): boolean {
  return (
    a.title === b.title &&
    a.topicStatus === b.topicStatus &&
    a.topicType === b.topicType &&
    a.priority === b.priority &&
    a.assignedTo === b.assignedTo &&
    a.dueDate === b.dueDate &&
    a.stage === b.stage &&
    (a.description ?? "") === (b.description ?? "") &&
    sameList(a.labels, b.labels) &&
    a.comments.length === b.comments.length &&
    a.viewpoints.length === b.viewpoints.length &&
    sameList(
      a.comments.map((comment) => comment.guid),
      b.comments.map((comment) => comment.guid),
    )
  );
}

function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

/** The more recently touched of two topics; ties keep the existing one. */
function newest(existing: BcfTopic, incoming: BcfTopic): BcfTopic {
  return touchedAt(incoming) > touchedAt(existing) ? incoming : existing;
}

function touchedAt(topic: BcfTopic): number {
  const candidates = [
    topic.modifiedDate,
    topic.creationDate,
    ...topic.comments.map((comment) => comment.modifiedDate ?? comment.date),
  ];

  const times = candidates
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value));

  return times.length > 0 ? Math.max(...times) : 0;
}
