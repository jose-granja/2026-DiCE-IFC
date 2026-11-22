/**
 * IFC property names in the interface's language, from the buildingSMART Data
 * Dictionary's IFC 4.3 dictionary (ADR 017).
 *
 * A label only: `FireRating` stays the property's name everywhere — it is what
 * IDS, filters, quantities and exports match on — and "Classe de Resistência ao
 * Fogo" (in Portuguese) or "Fire Rating" (in English) is shown beside it.
 *
 * Entity attributes (`ObjectType` → "Tipo de Objeto") are labelled the same
 * way, from the same table (`attributeLabel`).
 *
 * Read live from bSDD, through this app's server (`/api/bsdd/property-names`,
 * since bSDD sends no CORS headers), once per page. The request names a
 * language and nothing about a model (AGENTS.md §1). When bSDD cannot be
 * reached there are no labels; the IFC names are shown as always.
 */

import { z } from "zod";

/** The label shown for each interface language, in bSDD's codes: Portuguese is Portugal's. */
const LANGUAGES: Record<string, string[]> = { pt: ["pt-PT"], en: ["en"] };

export const propertyNamesUrl = (language: string) => `/api/bsdd/property-names?language=${encodeURIComponent(language)}`;

const tableSchema = z.object({
  version: z.literal(1),
  language: z.string(),
  dictionary: z.string(),
  updatedAt: z.string(),
  names: z.record(z.string().min(1).max(160), z.string().min(1).max(300)),
});

export type PropertyNameTable = {
  language: string;
  updatedAt: string;
  names: ReadonlyMap<string, string>;
};

/** bSDD's codes for the labels shown in the interface's `locale`: its own language only. */
export function propertyNameLanguages(locale: string): string[] {
  return LANGUAGES[locale] ?? ["en"];
}

async function fromBsdd(language: string): Promise<PropertyNameTable | null> {
  try {
    // Building the table can take bSDD a few seconds when this server has not
    // read it today. The cookies go with it (the default, same origin): with
    // the human check on (ADR 013) the proxy refuses an API call without its
    // pass cookie, and `credentials: "omit"` made that a 403 in production.
    const response = await fetch(propertyNamesUrl(language), { credentials: "same-origin", signal: AbortSignal.timeout(45_000) });
    if (!response.ok) return null;
    const parsed = tableSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.language !== language) return null;
    return { language, updatedAt: parsed.data.updatedAt, names: new Map(Object.entries(parsed.data.names)) };
  } catch {
    return null;
  }
}

const tables = new Map<string, Promise<PropertyNameTable | null>>();

/** The table for `language`, read once per page, or null when bSDD has none for it or cannot be reached. Never throws. */
export function loadPropertyNames(language: string): Promise<PropertyNameTable | null> {
  let table = tables.get(language);
  if (!table) {
    table = fromBsdd(language);
    // A failure is not remembered: the next panel to open asks again.
    table.then((found) => {
      if (!found && tables.get(language) === table) tables.delete(language);
    });
    tables.set(language, table);
  }
  return table;
}

/** For tests: forget what was read. */
export function forgetPropertyNames() {
  tables.clear();
}

/**
 * The dictionary names buildingSMART's own sets, so only a property in one is
 * labelled: `Pset_` and `Qto_` are reserved for them by IFC. A company's
 * `Status` in its own set may mean something else.
 */
export function isStandardSet(set: string | undefined): set is string {
  return Boolean(set && /^(Pset|Qto)_/.test(set));
}

/** The label for `property` in `set`, when the table has one. */
export function propertyLabel(table: PropertyNameTable | null | undefined, set: string | undefined, property: string): string | undefined {
  if (!table || !isStandardSet(set)) return undefined;
  return nameIn(table, property);
}

/**
 * The label for an entity attribute (`Name`, `ObjectType`, a door's
 * `OperationType`…), when the table has one. The dictionary lists IFC's
 * attributes among its properties, by the same code, and an attribute's name
 * is the schema's — no company can give it another meaning, so unlike a
 * property it needs no set to vouch for it. `PredefinedType` is not listed.
 */
export function attributeLabel(table: PropertyNameTable | null | undefined, attribute: string): string | undefined {
  return table ? nameIn(table, attribute) : undefined;
}

function nameIn(table: PropertyNameTable, code: string): string | undefined {
  const name = table.names.get(code);
  return name && name !== code ? name : undefined;
}
