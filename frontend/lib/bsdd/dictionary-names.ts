/**
 * Server side of the property-name labels (ADR 017): IFC 4.3's property names
 * in one language, read live from the buildingSMART Data Dictionary.
 *
 * bSDD sends no CORS headers, so the browser cannot ask it; this app's server
 * does, through `app/api/bsdd/property-names/route.ts`. What it sends bSDD is
 * the dictionary's URI and a language code — nothing from a model, and nothing
 * the user typed (AGENTS.md §1).
 *
 * `/api/Dictionary/v1/Properties` lists the dictionary's 2 501 properties a
 * thousand at a time, in the language asked for, and answers in English where
 * it has no translation without saying so. So the English listing is read too,
 * and only names that differ from it (and from the code) are kept: ~1 000 of
 * them in pt-PT, ~50 KB, where the six listings are ~1.5 MB.
 */

export const BSDD_API = "https://api.bsdd.buildingsmart.org";
export const IFC_DICTIONARY = "https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3";

/** The languages a table is built for: the interface's, other than English. */
export const PROPERTY_NAME_LANGUAGES = new Set(["pt-PT"]);

const PAGE = 1000;
/** IFC 4.3 has 2 501. Anything past this is not the dictionary we know. */
const MAX_PROPERTIES = 20_000;
/** bSDD's names change with a dictionary release; a day is plenty fresh. */
export const CACHE_SECONDS = 24 * 3600;

export type PropertyNamesTable = {
  version: 1;
  language: string;
  dictionary: string;
  updatedAt: string;
  names: Record<string, string>;
};

export class DictionaryNamesError extends Error {}

type Listing = {
  propertiesTotalCount?: number;
  properties?: { code?: string; name?: string }[];
};

async function page(language: string | null, offset: number, signal: AbortSignal): Promise<Listing> {
  const url = new URL("/api/Dictionary/v1/Properties", BSDD_API);
  url.searchParams.set("Uri", IFC_DICTIONARY);
  url.searchParams.set("Offset", String(offset));
  url.searchParams.set("Limit", String(PAGE));
  if (language) url.searchParams.set("languageCode", language);

  const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store", signal });
  if (!response.ok) throw new DictionaryNamesError(`bSDD returned ${response.status}.`);
  return (await response.json()) as Listing;
}

/** Every property's name, by code, in `language` (bSDD's English when null). Throws when the list is incomplete. */
export async function fetchNames(language: string | null, signal: AbortSignal): Promise<Map<string, string>> {
  const first = await page(language, 0, signal);
  const total = first.propertiesTotalCount ?? 0;
  if (!Number.isInteger(total) || total <= 0 || total > MAX_PROPERTIES) {
    throw new DictionaryNamesError(`bSDD listed an unexpected number of properties (${total}).`);
  }

  const offsets: number[] = [];
  for (let offset = PAGE; offset < total; offset += PAGE) offsets.push(offset);
  const rest = await Promise.all(offsets.map((offset) => page(language, offset, signal)));

  const names = new Map<string, string>();
  for (const listing of [first, ...rest]) {
    for (const property of listing.properties ?? []) {
      const code = property.code?.trim();
      const name = property.name?.trim();
      if (code && name) names.set(code, name);
    }
  }
  // A page that came back short would label some properties and silently not
  // others; better none, and a retry later.
  if (names.size !== total) {
    throw new DictionaryNamesError(`bSDD listed ${names.size} of the ${total} properties.`);
  }
  return names;
}

/** The table for `language`: the names bSDD translates, keyed by IFC property code. */
export async function buildTable(language: string, signal: AbortSignal, now = new Date()): Promise<PropertyNamesTable> {
  const [english, translated] = await Promise.all([fetchNames(null, signal), fetchNames(language, signal)]);

  const names: Record<string, string> = {};
  for (const code of [...translated.keys()].sort()) {
    const name = translated.get(code)!;
    if (name.length <= 300 && code.length <= 160 && name !== english.get(code) && name !== code) names[code] = name;
  }
  return {
    version: 1,
    language,
    dictionary: IFC_DICTIONARY,
    updatedAt: `${now.toISOString().slice(0, 19)}Z`,
    names,
  };
}

/** After a failed rebuild, how long the previous table is served before bSDD is asked again. */
const RETRY_SECONDS = 10 * 60;

const cached = new Map<string, { at: number; table: Promise<PropertyNamesTable> }>();
const lastGood = new Map<string, PropertyNamesTable>();

/**
 * The table for `language`, built at most once a day per server process.
 * Concurrent asks share one build. When a rebuild fails the previous table is
 * served and bSDD asked again ten minutes later; with no previous table the
 * failure is forgotten at once, so the next ask tries again.
 */
export function propertyNamesTable(language: string, now = Date.now()): Promise<PropertyNamesTable> {
  const hit = cached.get(language);
  if (hit && now - hit.at < CACHE_SECONDS * 1000) return hit.table;

  const entry = { at: now, table: Promise.resolve() as unknown as Promise<PropertyNamesTable> };
  entry.table = buildTable(language, AbortSignal.timeout(30_000)).then(
    (table) => {
      lastGood.set(language, table);
      return table;
    },
    (error: unknown) => {
      const previous = lastGood.get(language);
      if (cached.get(language) === entry) {
        if (previous) entry.at = now - (CACHE_SECONDS - RETRY_SECONDS) * 1000;
        else cached.delete(language);
      }
      if (previous) return previous;
      throw error;
    },
  );
  cached.set(language, entry);
  return entry.table;
}

/** For tests. */
export function forgetPropertyNamesTables() {
  cached.clear();
  lastGood.clear();
}
