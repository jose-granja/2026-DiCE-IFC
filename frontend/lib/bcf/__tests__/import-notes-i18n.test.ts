import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import pt from "@/messages/pt.json";

/**
 * Every code an import note can carry is words in both languages. The codes are
 * read out of `parse.ts` itself rather than listed here, so a note added there
 * without its sentences fails this instead of showing English to Portuguese.
 */
describe("BCF import notes", () => {
  const source = readFileSync(new URL("../parse.ts", import.meta.url), "utf8");
  const codes = [...source.matchAll(/code:\s*"([A-Za-z]+)"/g)].map((match) => match[1]);

  it("finds the codes", () => {
    expect(new Set(codes).size).toBeGreaterThanOrEqual(10);
  });

  it.each([["en", en], ["pt", pt]] as const)("has a sentence for each in %s", (_, catalogue) => {
    const notes = (catalogue.viewer.bcfPanel as { importNotes: Record<string, string> }).importNotes;
    for (const code of codes) expect(notes[code], code).toEqual(expect.any(String));
  });
});
