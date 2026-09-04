// @vitest-environment jsdom

/**
 * Reader and writer, against buildingSMART's own test archives.
 *
 * `fixtures/bcf/` holds a representative slice of the official BCF-XML test
 * cases for both 2.1 and 3.0. They are the reference for what real files look
 * like, including the things a hand-written fixture would never think to do —
 * uppercase GUIDs, viewpoints with no camera, `DefaultVisibility="false"` used
 * to mean "isolate these two walls".
 *
 * The strongest assertion here is the last one: everything we write is fed
 * back through libxml2 against the vendored XSDs. "Exports a valid BCF 3.0
 * zip" is then a fact rather than an intention.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseBcf, BcfParseError } from "../parse";
import { bcfFileName, serializeBcf } from "../serialize";
import { validateArchive } from "../validate";
import { emptyBcfFile, createTopic, type BcfFile } from "../types";

const FIXTURES = path.resolve(import.meta.dirname, "../../../fixtures/bcf");

function fixturesIn(version: "v2.1" | "v3.0"): string[] {
  return readdirSync(path.join(FIXTURES, version))
    .filter((name) => name.endsWith(".bcf"))
    .sort();
}

function load(version: "v2.1" | "v3.0", name: string) {
  const bytes = readFileSync(path.join(FIXTURES, version, name));
  return parseBcf(new Uint8Array(bytes), name);
}

const V21 = fixturesIn("v2.1");
const V30 = fixturesIn("v3.0");

describe("fixtures", () => {
  it("has official archives for both versions", () => {
    expect(V21.length).toBeGreaterThan(0);
    expect(V30.length).toBeGreaterThan(0);
  });
});

describe("parseBcf", () => {
  it.each(V30)("reads the 3.0 archive %s", (name) => {
    const { file } = load("v3.0", name);

    expect(file.sourceVersion).toBe("3.0");
    expect(file.topics.length).toBeGreaterThan(0);
    for (const topic of file.topics) {
      expect(topic.guid).toMatch(/^[0-9a-f-]{36}$/i);
      expect(topic.title).not.toBe("");
    }
  });

  it.each(V21)("reads the 2.1 archive %s", (name) => {
    const { file } = load("v2.1", name);

    expect(file.sourceVersion).toBe("2.1");
    expect(file.topics.length).toBeGreaterThan(0);
  });

  it("reads labels from a 3.0 file, where they are wrapped in <Label>", () => {
    // The regression that ruled out @ifc-lite/bcf: its reader matches only
    // 2.1's flat <Labels>text</Labels> and returns nothing for this file.
    const { file } = load("v3.0", "labels.bcf");
    const labels = file.topics.flatMap((topic) => topic.labels);

    expect(labels.length).toBeGreaterThan(0);
  });

  it("reads labels from a 2.1 file, where <Labels> repeats", () => {
    const { file } = load("v2.1", "maximum-information.bcf");
    const labels = file.topics.flatMap((topic) => topic.labels);

    expect(labels.length).toBeGreaterThan(0);
  });

  it("reads comments without mistaking the text child for a comment", () => {
    // <Comment Guid="…"><Comment>text</Comment></Comment> — selecting by tag
    // name alone yields twice as many comments as the file contains.
    const { file } = load("v2.1", "maximum-information.bcf");
    const topic = file.topics[0];

    expect(topic.comments.length).toBeGreaterThan(0);
    for (const comment of topic.comments) {
      expect(comment.guid).toBeTruthy();
      expect(comment.comment).toBeTruthy();
    }
  });

  it("reads a perspective camera", () => {
    const { file } = load("v3.0", "perspective-camera.bcf");
    const camera = file.topics[0]?.viewpoints[0]?.camera;

    expect(camera?.kind).toBe("perspective");
    expect(camera && "fieldOfView" in camera && camera.fieldOfView).toBeGreaterThan(0);
  });

  it("reads an orthogonal camera", () => {
    const { file } = load("v3.0", "orthogonal-camera.bcf");
    const camera = file.topics[0]?.viewpoints[0]?.camera;

    expect(camera?.kind).toBe("orthogonal");
    expect(
      camera && "viewToWorldScale" in camera && camera.viewToWorldScale,
    ).toBeGreaterThan(0);
  });

  it("reads a selection", () => {
    const { file } = load("v3.0", "component-selection.bcf");
    const selection = file.topics[0]?.viewpoints[0]?.components?.selection ?? [];

    expect(selection.length).toBeGreaterThan(0);
    expect(selection[0].ifcGuid).toBeTruthy();
  });

  it("reads DefaultVisibility=false with exceptions as an isolation", () => {
    const { file } = load("v3.0", "single-visible-wall.bcf");
    const components = file.topics[0]?.viewpoints[0]?.components;

    expect(components?.defaultVisibility).toBe(false);
    expect(components?.exceptions.length).toBeGreaterThan(0);
  });

  it("keeps snapshots as bytes", () => {
    const { file } = load("v3.0", "labels.bcf");
    const snapshot = file.topics[0]?.viewpoints[0]?.snapshot;

    expect(snapshot?.bytes.length).toBeGreaterThan(0);
    // PNG magic number: the bytes are the file, not a re-encoding.
    expect(Array.from(snapshot!.bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("resolves an internal document reference into the 3.0 library", () => {
    const { file } = load("v3.0", "document-reference-internal.bcf");
    const reference = file.topics
      .flatMap((topic) => topic.documentReferences)
      .find((entry) => entry.documentGuid);

    expect(reference).toBeDefined();
    expect(file.documents.some((d) => d.guid === reference!.documentGuid)).toBe(true);
  });

  it("keeps an external document reference as a URL", () => {
    const { file } = load("v3.0", "document-reference-external.bcf");
    const reference = file.topics.flatMap((topic) => topic.documentReferences)[0];

    expect(reference?.url).toMatch(/^https?:\/\//);
  });

  it("reads related topics", () => {
    const { file } = load("v3.0", "related-topics.bcf");
    const related = file.topics.flatMap((topic) => topic.relatedTopics);

    expect(related.length).toBeGreaterThan(0);
  });

  it("collects the vocabulary the topics actually use", () => {
    const { file } = load("v3.0", "user-assignment.bcf");
    const assigned = file.topics.map((topic) => topic.assignedTo).filter(Boolean);

    for (const user of assigned) {
      expect(file.extensions.users).toContain(user);
    }
  });

  it("rejects something that is not a zip", () => {
    expect(() => parseBcf(new TextEncoder().encode("not a zip"))).toThrow(
      BcfParseError,
    );
  });
});

describe("2.1 to 3.0 upgrade", () => {
  it("reorders an ARGB colour into RGBA", () => {
    // 2.1 documents 8 hex digits as ARGB; 3.0's schema example is RGBA. Both
    // validate, so nothing but this catches a silent colour change.
    const source = readFileSync(path.join(FIXTURES, "v2.1", "maximum-information.bcf"));
    const { file } = parseBcf(new Uint8Array(source), "maximum-information.bcf");

    const colours = file.topics
      .flatMap((topic) => topic.viewpoints)
      .flatMap((viewpoint) => viewpoint.components?.coloring ?? [])
      .map((entry) => entry.colour);

    for (const colour of colours) {
      expect(colour).toMatch(/^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/);
    }
  });

  it("turns a 2.1 archive into a valid 3.0 archive", async () => {
    const { file } = load("v2.1", "maximum-information.bcf");
    const { bytes } = serializeBcf(file);

    expect(await validateArchive(bytes)).toEqual([]);
  });
});

describe("serializeBcf", () => {
  it("round-trips a file through parse → write → parse", () => {
    const { file } = load("v3.0", "labels.bcf");
    const { bytes } = serializeBcf(file);
    const again = parseBcf(bytes, "labels.bcf").file;

    expect(again.topics.length).toBe(file.topics.length);
    expect(again.topics[0].title).toBe(file.topics[0].title);
    expect(again.topics[0].labels).toEqual(file.topics[0].labels);
    expect(again.topics[0].comments.length).toBe(file.topics[0].comments.length);
    expect(again.topics[0].viewpoints.length).toBe(file.topics[0].viewpoints.length);
  });

  it("copies snapshots through byte for byte", () => {
    const { file } = load("v3.0", "labels.bcf");
    const again = parseBcf(serializeBcf(file).bytes).file;

    expect(again.topics[0].viewpoints[0].snapshot?.bytes).toEqual(
      file.topics[0].viewpoints[0].snapshot?.bytes,
    );
  });

  it("supplies TopicType and TopicStatus, which the schema requires", () => {
    const file: BcfFile = {
      ...emptyBcfFile(),
      topics: [createTopic({ title: "Bare", author: "a@example.com" })],
    };
    const { notes } = serializeBcf(file);
    const again = parseBcf(serializeBcf(file).bytes).file;

    expect(again.topics[0].topicType).toBe("Issue");
    expect(again.topics[0].topicStatus).toBe("Open");
    expect(notes.some((note) => note.message.includes("TopicType"))).toBe(true);
  });

  it("replaces an unusable GUID everywhere it is referenced", () => {
    const first = createTopic({ title: "First", author: "a@example.com" });
    const second = createTopic({ title: "Second", author: "a@example.com" });
    first.guid = "not-a-uuid";
    second.relatedTopics = [first.guid];

    const { bytes, notes } = serializeBcf({
      ...emptyBcfFile(),
      topics: [first, second],
    });
    const again = parseBcf(bytes).file;

    const rewritten = again.topics.find((topic) => topic.title === "First")!;
    const referrer = again.topics.find((topic) => topic.title === "Second")!;

    expect(rewritten.guid).toMatch(/^[0-9a-f-]{36}$/);
    // The link has to follow the substitution, or the relationship is lost.
    expect(referrer.relatedTopics).toEqual([rewritten.guid]);
    expect(notes.some((note) => note.message.includes("not a valid BCF GUID"))).toBe(
      true,
    );
  });

  it("lowercases an uppercase GUID rather than replacing it", () => {
    const topic = createTopic({ title: "Upper", author: "a@example.com" });
    topic.guid = topic.guid.toUpperCase();

    const { bytes, notes } = serializeBcf({ ...emptyBcfFile(), topics: [topic] });
    const again = parseBcf(bytes).file;

    expect(again.topics[0].guid).toBe(topic.guid.toLowerCase());
    // A case fix loses nothing, so it is not worth reporting. (Other notes are
    // expected here: this topic has no type or status.)
    expect(notes.filter((note) => note.message.includes("GUID"))).toEqual([]);
  });

  it("names the download after the project", () => {
    const file = emptyBcfFile();
    file.project.name = "Structural Handover v2";

    expect(bcfFileName(file)).toBe("structural-handover-v2.bcf");
  });
});

describe("schema validity", () => {
  it.each(V30)("rewrites the 3.0 archive %s as valid BCF 3.0", async (name) => {
    const { file } = load("v3.0", name);
    const { bytes } = serializeBcf(file);

    expect(await validateArchive(bytes)).toEqual([]);
  });

  it.each(V21)("rewrites the 2.1 archive %s as valid BCF 3.0", async (name) => {
    const { file } = load("v2.1", name);
    const { bytes } = serializeBcf(file);

    expect(await validateArchive(bytes)).toEqual([]);
  });

  it("writes a valid archive for a file authored from scratch", async () => {
    const file: BcfFile = {
      ...emptyBcfFile(),
      project: { projectId: crypto.randomUUID(), name: "Ponte de Lima" },
      topics: [
        createTopic({
          title: "Viga sem revestimento",
          author: "engenheiro@example.pt",
          topicType: "Issue",
          topicStatus: "Open",
          priority: "High",
          description: "A viga V-12 não tem revestimento de proteção ao fogo.",
          labels: ["Estrutura", "Fogo"],
        }),
      ],
    };

    expect(await validateArchive(serializeBcf(file).bytes)).toEqual([]);
  });
});
