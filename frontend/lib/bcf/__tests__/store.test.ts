// @vitest-environment jsdom

/**
 * Store behaviour that the UI depends on but cannot usefully test.
 *
 * Bulk editing several topics at once is the clearest example: driving a
 * virtualised list that reflows as the bulk bar appears tests the virtualiser,
 * not the feature.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { useBcfStore } from "../store";
import { createTopic, emptyBcfFile, type BcfTopic } from "../types";

function topic(title: string): BcfTopic {
  return createTopic({ title, author: "a@example.com" });
}

describe("bulkUpdate", () => {
  beforeEach(() => {
    useBcfStore.getState().reset();
  });

  function seed(titles: string[]): BcfTopic[] {
    const topics = titles.map(topic);
    useBcfStore.getState().setFile({ ...emptyBcfFile(), topics });
    return topics;
  }

  it("changes every checked topic and leaves the rest alone", () => {
    const [a, b, c] = seed(["A", "B", "C"]);
    useBcfStore.getState().bulkUpdate([a.guid, c.guid], { topicStatus: "Closed" });

    const after = useBcfStore.getState().file.topics;
    expect(after.find((t) => t.guid === a.guid)?.topicStatus).toBe("Closed");
    expect(after.find((t) => t.guid === c.guid)?.topicStatus).toBe("Closed");
    expect(after.find((t) => t.guid === b.guid)?.topicStatus).toBeUndefined();
  });

  it("leaves fields the patch does not mention", () => {
    // Blank means "don't touch", not "clear it". Treating it as a clear would
    // wipe the assignee off forty topics because someone changed a status.
    const [a] = seed(["A"]);
    useBcfStore.getState().updateTopic(a.guid, { assignedTo: "ana@example.pt" });
    useBcfStore.getState().bulkUpdate([a.guid], { topicStatus: "Closed" });

    const after = useBcfStore.getState().file.topics[0];
    expect(after.assignedTo).toBe("ana@example.pt");
    expect(after.topicStatus).toBe("Closed");
  });

  it("stamps the modification fields", () => {
    // Other tools use these to decide whose version wins on merge.
    const [a] = seed(["A"]);
    useBcfStore.getState().setAuthor("engenheiro@example.pt");
    useBcfStore.getState().bulkUpdate([a.guid], { priority: "High" });

    const after = useBcfStore.getState().file.topics[0];
    expect(after.modifiedAuthor).toBe("engenheiro@example.pt");
    expect(after.modifiedDate).toBeTruthy();
  });

  it("marks the file dirty so the draft can be saved", () => {
    const [a] = seed(["A"]);
    expect(useBcfStore.getState().dirty).toBe(false);
    useBcfStore.getState().bulkUpdate([a.guid], { topicType: "Clash" });
    expect(useBcfStore.getState().dirty).toBe(true);
  });

  it("does nothing for guids that are not in the file", () => {
    seed(["A"]);
    useBcfStore.getState().bulkUpdate(["not-a-guid"], { topicStatus: "Closed" });
    expect(useBcfStore.getState().file.topics[0].topicStatus).toBeUndefined();
  });
});

describe("importing", () => {
  beforeEach(() => {
    useBcfStore.getState().reset();
  });

  it("leaves nothing selected, so the panel shows the list", async () => {
    // The panel is a list *or* a detail. Selecting the first topic on import
    // dropped the user into one issue with no sense of how many arrived.
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const bytes = new Uint8Array(
      readFileSync(
        path.resolve(import.meta.dirname, "../../../fixtures/bcf/v3.0/labels.bcf"),
      ),
    );

    useBcfStore.getState().importArchives([{ name: "labels.bcf", bytes }]);

    expect(useBcfStore.getState().file.topics.length).toBeGreaterThan(0);
    expect(useBcfStore.getState().selectedGuid).toBeNull();
  });
});
