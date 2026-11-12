// @vitest-environment node

import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/bsdd/property-names/route";
import { forgetPropertyNamesTables, IFC_DICTIONARY, propertyNamesTable } from "../dictionary-names";

/** A dictionary of `total` properties, `P0`…; pt-PT translates the even ones and answers the rest in English. */
function fakeBsdd(total = 2501, { short = false, status = 200 } = {}) {
  const seen: URL[] = [];
  const fetchMock = vi.fn(async (input: URL | string) => {
    const url = new URL(String(input));
    seen.push(url);
    if (status !== 200) return new Response("no", { status });
    const offset = Number(url.searchParams.get("Offset"));
    const limit = Number(url.searchParams.get("Limit"));
    const portuguese = url.searchParams.get("languageCode") === "pt-PT";
    const end = Math.min(total, offset + limit) - (short && offset > 0 ? 1 : 0);
    const properties = [];
    for (let index = offset; index < end; index++) {
      const code = `P${index}`;
      properties.push({ code, name: portuguese && index % 2 === 0 ? `Propriedade ${index}` : `P ${index}` });
    }
    return Response.json({ propertiesTotalCount: total, properties });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { seen, fetchMock };
}

const ask = (language: string) => GET(new NextRequest(`http://localhost:3000/api/bsdd/property-names?language=${language}`));

afterEach(() => {
  forgetPropertyNamesTables();
  vi.unstubAllGlobals();
});

describe("property names from bSDD", () => {
  it("keeps only the names bSDD translates, from every page", async () => {
    const { seen } = fakeBsdd();
    const response = await ask("pt-PT");
    expect(response.status).toBe(200);
    const table = await response.json();
    expect(table.language).toBe("pt-PT");
    expect(table.dictionary).toBe(IFC_DICTIONARY);
    expect(Object.keys(table.names)).toHaveLength(1251);
    expect(table.names.P2500).toBe("Propriedade 2500");
    expect(table.names.P1).toBeUndefined();
    // Three pages in each of English and Portuguese; nothing but the dictionary and the language.
    expect(seen).toHaveLength(6);
    for (const url of seen) {
      expect(url.origin + url.pathname).toBe("https://api.bsdd.buildingsmart.org/api/Dictionary/v1/Properties");
      expect([...url.searchParams.keys()].sort()).toEqual(
        url.searchParams.has("languageCode") ? ["Limit", "Offset", "Uri", "languageCode"] : ["Limit", "Offset", "Uri"],
      );
      expect(url.searchParams.get("Uri")).toBe(IFC_DICTIONARY);
    }
  });

  it("reads bSDD once a day, not once per viewer", async () => {
    const { fetchMock } = fakeBsdd(10);
    await Promise.all([ask("pt-PT"), ask("pt-PT")]);
    await ask("pt-PT");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await propertyNamesTable("pt-PT", Date.now() + 25 * 3600 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("answers nothing rather than part of the table when a page comes back short", async () => {
    fakeBsdd(2501, { short: true });
    expect((await ask("pt-PT")).status).toBe(502);
  });

  it("tries bSDD again after it failed", async () => {
    fakeBsdd(10, { status: 503 });
    expect((await ask("pt-PT")).status).toBe(502);
    fakeBsdd(10);
    expect((await ask("pt-PT")).status).toBe(200);
  });

  it("keeps serving yesterday's table while bSDD is down, and asks again ten minutes later", async () => {
    const day = 25 * 3600 * 1000;
    fakeBsdd(10);
    const today = await propertyNamesTable("pt-PT");
    const { fetchMock } = fakeBsdd(10, { status: 503 });
    expect(await propertyNamesTable("pt-PT", Date.now() + day)).toEqual(today);
    const calls = fetchMock.mock.calls.length;
    await propertyNamesTable("pt-PT", Date.now() + day + 60_000);
    expect(fetchMock.mock.calls.length).toBe(calls);
    fakeBsdd(10);
    const later = await propertyNamesTable("pt-PT", Date.now() + day + 11 * 60_000);
    expect(later.names).toEqual(today.names);
  });

  it("only for the interface's languages", async () => {
    const { fetchMock } = fakeBsdd(10);
    expect((await ask("de-DE")).status).toBe(404);
    expect((await ask("")).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
