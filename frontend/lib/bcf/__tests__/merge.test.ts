import { describe, expect, it } from "vitest";

import { mergeBcfFiles } from "../merge";
import { createTopic, emptyBcfFile, type BcfFile, type BcfTopic } from "../types";

function fileWith(name: string, topics: BcfTopic[]): BcfFile {
  return { ...emptyBcfFile(name), name, topics };
}

function topic(title: string, patch: Partial<BcfTopic> = {}): BcfTopic {
  return {
    ...createTopic({ title, author: "a@example.com" }),
    creationDate: "2026-01-01T00:00:00Z",
    ...patch,
  };
}

describe("mergeBcfFiles", () => {
  it("combines topics from several files", () => {
    const { file, conflicts } = mergeBcfFiles([
      fileWith("a.bcf", [topic("One")]),
      fileWith("b.bcf", [topic("Two")]),
    ]);

    expect(file.topics.map((t) => t.title).sort()).toEqual(["One", "Two"]);
    expect(conflicts).toEqual([]);
  });

  it("collapses the same topic appearing in two files", () => {
    // Exporting the same issue set twice is the common case, and reporting it
    // as a conflict would make every merge look alarming.
    const shared = topic("Shared");
    const { file, conflicts, duplicates } = mergeBcfFiles([
      fileWith("a.bcf", [shared]),
      fileWith("b.bcf", [{ ...shared }]),
    ]);

    expect(file.topics).toHaveLength(1);
    expect(duplicates).toBe(1);
    expect(conflicts).toEqual([]);
  });

  it("does not treat a bumped modified date as a divergence", () => {
    const shared = topic("Shared");
    const { conflicts, duplicates } = mergeBcfFiles([
      fileWith("a.bcf", [shared]),
      fileWith("b.bcf", [{ ...shared, modifiedDate: "2026-06-01T00:00:00Z" }]),
    ]);

    expect(duplicates).toBe(1);
    expect(conflicts).toEqual([]);
  });

  it("keeps both sides of a real collision by default", () => {
    const original = topic("Wall clash", { topicStatus: "Open" });
    const edited = { ...original, topicStatus: "Closed", title: "Wall clash" };

    const { file, conflicts } = mergeBcfFiles([
      fileWith("a.bcf", [original]),
      fileWith("b.bcf", [edited]),
    ]);

    expect(file.topics).toHaveLength(2);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].resolution).toBe("kept-both");
    expect(conflicts[0].sources).toEqual(["a.bcf", "b.bcf"]);

    // A GUID may appear only once in the output.
    const guids = file.topics.map((t) => t.guid);
    expect(new Set(guids).size).toBe(2);
  });

  it("rewrites related-topic links when a GUID is reassigned", () => {
    // The link is the whole reason merging is not concatenation.
    const clash = topic("Clash");
    const other = topic("Other", { relatedTopics: [clash.guid] });
    const divergent = { ...clash, topicStatus: "Closed" };

    const { file, conflicts } = mergeBcfFiles([
      fileWith("a.bcf", [clash]),
      fileWith("b.bcf", [divergent, other]),
    ]);

    const replacement = conflicts[0].newGuid!;
    const moved = file.topics.find((t) => t.title === "Other")!;

    expect(moved.relatedTopics).toEqual([replacement]);
  });

  it("leaves an unrelated file's link to the same GUID alone", () => {
    // Only the file whose topic was renamed should follow the rename.
    const clash = topic("Clash");
    const pointer = topic("Pointer", { relatedTopics: [clash.guid] });

    const { file } = mergeBcfFiles([
      fileWith("a.bcf", [clash, pointer]),
      fileWith("b.bcf", [{ ...clash, topicStatus: "Closed" }]),
    ]);

    const kept = file.topics.find((t) => t.title === "Pointer")!;
    expect(kept.relatedTopics).toEqual([clash.guid]);
  });

  it("keeps the more recently touched topic when asked", () => {
    const older = topic("Old", {
      topicStatus: "Open",
      modifiedDate: "2026-01-02T00:00:00Z",
    });
    const newer = {
      ...older,
      topicStatus: "Closed",
      modifiedDate: "2026-05-05T00:00:00Z",
    };

    const { file, conflicts } = mergeBcfFiles(
      [fileWith("a.bcf", [older]), fileWith("b.bcf", [newer])],
      { strategy: "keep-newest" },
    );

    expect(file.topics).toHaveLength(1);
    expect(file.topics[0].topicStatus).toBe("Closed");
    expect(conflicts[0].resolution).toBe("kept-newest");
  });

  it("counts a late comment as having touched the topic", () => {
    const base = topic("Discussed", { modifiedDate: "2026-01-02T00:00:00Z" });
    const commented: BcfTopic = {
      ...base,
      topicStatus: "Closed",
      comments: [
        {
          guid: "c1",
          date: "2026-08-01T00:00:00Z",
          author: "b@example.com",
          comment: "Fixed.",
        },
      ],
    };

    const { file } = mergeBcfFiles(
      [fileWith("a.bcf", [base]), fileWith("b.bcf", [commented])],
      { strategy: "keep-newest" },
    );

    expect(file.topics[0].comments).toHaveLength(1);
  });

  it("unions the vocabularies", () => {
    const a = fileWith("a.bcf", []);
    a.extensions.topicStatuses = ["Open", "Closed"];
    const b = fileWith("b.bcf", []);
    b.extensions.topicStatuses = ["Closed", "Em análise"];

    const { file } = mergeBcfFiles([a, b]);

    expect(file.extensions.topicStatuses).toEqual(["Open", "Closed", "Em análise"]);
  });

  it("carries documents across without duplicating them", () => {
    const document_ = {
      guid: "d1",
      filename: "detail.pdf",
      bytes: new Uint8Array([1, 2, 3]),
    };
    const a = { ...fileWith("a.bcf", []), documents: [document_] };
    const b = { ...fileWith("b.bcf", []), documents: [document_] };

    expect(mergeBcfFiles([a, b]).file.documents).toHaveLength(1);
  });

  it("merges an empty list into an empty file", () => {
    const { file } = mergeBcfFiles([]);
    expect(file.topics).toEqual([]);
  });
});
