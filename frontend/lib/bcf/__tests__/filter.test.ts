import { describe, expect, it } from "vitest";

import { EMPTY_FILTER, filterTopics, isFilterActive, sortTopics } from "../filter";
import { createTopic, type BcfTopic } from "../types";

const NOW = Date.parse("2026-06-15T12:00:00Z");

function topic(patch: Partial<BcfTopic> & { title: string }): BcfTopic {
  return {
    ...createTopic({ title: patch.title, author: "a@example.com" }),
    creationDate: "2026-01-01T00:00:00Z",
    ...patch,
  };
}

describe("filterTopics", () => {
  const topics = [
    topic({
      title: "Missing fire rating",
      topicStatus: "Open",
      priority: "High",
      topicType: "Issue",
      assignedTo: "ana@example.pt",
      labels: ["Fire", "Structure"],
      description: "Beam V-12 has no protection.",
    }),
    topic({
      title: "Duct clash",
      topicStatus: "Closed",
      priority: "Low",
      topicType: "Clash",
      assignedTo: "bruno@example.pt",
      labels: ["MEP"],
    }),
    topic({ title: "Unassigned query", topicStatus: "Open", topicType: "Inquiry" }),
  ];

  it("returns everything when nothing is set", () => {
    expect(filterTopics(topics, EMPTY_FILTER, NOW)).toHaveLength(3);
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
  });

  it("searches the description and comments, not just the title", () => {
    const found = filterTopics(topics, { ...EMPTY_FILTER, search: "protection" }, NOW);
    expect(found.map((t) => t.title)).toEqual(["Missing fire rating"]);
  });

  it("searches case-insensitively", () => {
    expect(
      filterTopics(topics, { ...EMPTY_FILTER, search: "DUCT" }, NOW),
    ).toHaveLength(1);
  });

  it("ORs within a facet", () => {
    const found = filterTopics(
      topics,
      { ...EMPTY_FILTER, statuses: ["Open", "Closed"] },
      NOW,
    );
    expect(found).toHaveLength(3);
  });

  it("ANDs across facets", () => {
    const found = filterTopics(
      topics,
      { ...EMPTY_FILTER, statuses: ["Open"], priorities: ["High"] },
      NOW,
    );
    expect(found.map((t) => t.title)).toEqual(["Missing fire rating"]);
  });

  it("matches a topic carrying any of the selected labels", () => {
    const found = filterTopics(topics, { ...EMPTY_FILTER, labels: ["MEP"] }, NOW);
    expect(found.map((t) => t.title)).toEqual(["Duct clash"]);
  });

  it("finds overdue topics", () => {
    const overdue = topic({
      title: "Late",
      topicStatus: "Open",
      dueDate: "2026-05-01T00:00:00Z",
    });
    const found = filterTopics([...topics, overdue], { ...EMPTY_FILTER, due: "overdue" }, NOW);

    expect(found.map((t) => t.title)).toEqual(["Late"]);
  });

  it("does not call a closed topic overdue", () => {
    // Chasing a closed topic past its date is noise, not a task.
    const done = topic({
      title: "Late but done",
      topicStatus: "Closed",
      dueDate: "2026-05-01T00:00:00Z",
    });
    expect(filterTopics([done], { ...EMPTY_FILTER, due: "overdue" }, NOW)).toEqual([]);
  });

  it("finds topics due within a week", () => {
    const soon = topic({ title: "Soon", dueDate: "2026-06-18T00:00:00Z" });
    const later = topic({ title: "Later", dueDate: "2026-09-18T00:00:00Z" });

    const found = filterTopics([soon, later], { ...EMPTY_FILTER, due: "soon" }, NOW);
    expect(found.map((t) => t.title)).toEqual(["Soon"]);
  });

  it("finds topics with no due date", () => {
    const found = filterTopics(topics, { ...EMPTY_FILTER, due: "none" }, NOW);
    expect(found).toHaveLength(3);
  });
});

describe("sortTopics", () => {
  it("orders priorities by severity, not alphabetically", () => {
    // Alphabetical gives Critical, High, Low, Normal — which is meaningless.
    const topics = [
      topic({ title: "a", priority: "Low" }),
      topic({ title: "b", priority: "Critical" }),
      topic({ title: "c", priority: "Normal" }),
      topic({ title: "d", priority: "High" }),
    ];

    expect(sortTopics(topics, "priority").map((t) => t.priority)).toEqual([
      "Critical",
      "High",
      "Normal",
      "Low",
    ]);
  });

  it("sorts a project-specific priority after the known ones", () => {
    const topics = [
      topic({ title: "a", priority: "Urgentíssimo" }),
      topic({ title: "b", priority: "Low" }),
    ];

    expect(sortTopics(topics, "priority").map((t) => t.priority)).toEqual([
      "Low",
      "Urgentíssimo",
    ]);
  });

  it("puts topics with no due date last when ascending", () => {
    const topics = [
      topic({ title: "none" }),
      topic({ title: "dated", dueDate: "2026-07-01T00:00:00Z" }),
    ];

    expect(sortTopics(topics, "due").map((t) => t.title)).toEqual(["dated", "none"]);
  });

  it("reverses on descending", () => {
    const topics = [topic({ title: "a" }), topic({ title: "b" })];
    expect(sortTopics(topics, "title", "desc").map((t) => t.title)).toEqual(["b", "a"]);
  });

  it("breaks ties by title so the order is stable", () => {
    const topics = [
      topic({ title: "zebra", topicStatus: "Open" }),
      topic({ title: "alpha", topicStatus: "Open" }),
    ];

    expect(sortTopics(topics, "status").map((t) => t.title)).toEqual(["alpha", "zebra"]);
  });

  it("does not mutate the input", () => {
    const topics = [topic({ title: "b" }), topic({ title: "a" })];
    sortTopics(topics, "title");
    expect(topics.map((t) => t.title)).toEqual(["b", "a"]);
  });
});
