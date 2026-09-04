"use client";

/**
 * The buildingSMART Data Dictionary, as this app uses it.
 *
 * bSDD is a catalogue of classes (IfcWall, and national equivalents) and the
 * properties that belong to them. An IDS says "walls must carry
 * Pset_WallCommon.FireRating"; bSDD is where the author finds out that such a
 * property exists, what it is called exactly, and what values it accepts.
 * Typing those from memory is how a specification ends up referring to a
 * property that no model will ever have.
 *
 * Everything goes through `/api/bsdd` — bSDD sends no CORS headers, so the
 * browser cannot call it. See that route for what leaves the deployment.
 *
 * The types here are deliberately narrow: only the fields the editor uses, so a
 * change upstream shows up as a compile error in one file rather than as
 * `undefined` in a dropdown.
 */

export type BsddDictionary = {
  uri: string;
  name: string;
  code: string;
  version: string;
  organizationNameOwner: string;
};

export type BsddClass = {
  uri: string;
  name: string;
  /** The IFC class name, e.g. `IfcWall`. What an entity facet needs. */
  referenceCode: string;
  dictionaryName: string;
  description?: string;
};

export type BsddAllowedValue = {
  code: string;
  value: string;
  description?: string;
};

export type BsddProperty = {
  /** Human name, e.g. "Acoustic Rating". */
  name: string;
  /**
   * The class-scoped property URI —
   * `.../class/IfcWall/prop/Pset_WallCommon/Status`.
   *
   * This is the one an IDS facet wants: it identifies the property *in this
   * property set on this class*, which is exactly what the facet constrains.
   * `propertyUri` is the dictionary-level definition (`.../prop/Status`), true
   * of every class that uses it and therefore less specific than the facet.
   */
  uri?: string;
  /** The dictionary-level property definition, shared across classes. */
  propertyUri?: string;
  /** The IFC property name, e.g. `AcousticRating`. What IDS wants. */
  propertyCode: string;
  /** e.g. `Pset_WallCommon`. */
  propertySet?: string;
  /** bSDD's own vocabulary: `String`, `Real`, `Boolean`, `Time`. */
  dataType?: string;
  description?: string;
  allowedValues?: BsddAllowedValue[];
};

export class BsddError extends Error {}

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  const query = new URLSearchParams({ path, ...params });
  const response = await fetch(`/api/bsdd?${query}`);

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new BsddError(body.error ?? `bSDD request failed (${response.status}).`);
  }
  return (await response.json()) as T;
}

export async function listDictionaries(): Promise<BsddDictionary[]> {
  const data = await get<{ dictionaries?: BsddDictionary[] }>(
    "/api/Dictionary/v1",
    { limit: "200" },
  );
  return (data.dictionaries ?? []).sort((a, b) => a.name.localeCompare(b.name));
}

/** Classes matching `search` across the chosen dictionaries. */
export async function searchClasses(
  dictionaryUris: string[],
  search: string,
  limit = 20,
): Promise<BsddClass[]> {
  if (dictionaryUris.length === 0 || search.trim().length < 2) return [];

  const data = await get<{ classes?: BsddClass[] }>("/api/Class/Search/v1", {
    // The API takes the parameter repeated; URLSearchParams would collapse a
    // joined string, so they are sent comma-separated, which it also accepts.
    DictionaryUris: dictionaryUris.join(","),
    SearchText: search.trim(),
    Limit: String(limit),
  });
  return data.classes ?? [];
}

/**
 * One class with its properties.
 *
 * This is the call that makes the feature worth having: it returns every
 * property bSDD knows for the class, with its property set, its data type and —
 * for enumerated ones — the values it accepts.
 */
export async function getClass(uri: string): Promise<{
  name: string;
  referenceCode: string;
  definition?: string;
  properties: BsddProperty[];
}> {
  const data = await get<{
    name: string;
    referenceCode: string;
    definition?: string;
    classProperties?: BsddProperty[];
  }>("/api/Class/v1", { Uri: uri, IncludeClassProperties: "true" });

  return {
    name: data.name,
    referenceCode: data.referenceCode,
    definition: data.definition,
    properties: (data.classProperties ?? []).filter((p) => p.propertyCode),
  };
}

/**
 * bSDD's data types onto the IFC measure names an IDS property facet uses.
 *
 * Only the mappings that are actually sound are returned, because a wrong
 * `dataType` is worse than an absent one: IDS matches the measure type, so a
 * facet saying `IFCREAL` against a model storing
 * `IfcThermalTransmittanceMeasure` matches **nothing** and reports a pass over
 * an empty set — the silent failure this whole feature exists to prevent.
 *
 * That is why `Real` is deliberately absent. bSDD's vocabulary is coarse: of
 * the 233 properties it lists for `IfcWall`, 110 are `Real`, and they span
 * `IfcThermalTransmittanceMeasure`, `IfcPositiveLengthMeasure`,
 * `IfcPlaneAngleMeasure` and more. Which one applies is per-property knowledge
 * bSDD does not carry, so the author is asked rather than guessed at.
 */
export function idsDataType(dataType: string | undefined): string | undefined {
  switch (dataType) {
    case "String":
      return "IFCLABEL";
    case "Boolean":
      return "IFCBOOLEAN";
    case "Integer":
      return "IFCINTEGER";
    case "Time":
      return "IFCDATETIME";
    // "Real" intentionally unmapped — see above.
    default:
      return undefined;
  }
}

/**
 * True when bSDD knows the property is numeric but not which IFC measure.
 *
 * The editor uses this to explain the gap instead of leaving the field
 * mysteriously blank.
 */
export function isUnmappedNumeric(dataType: string | undefined): boolean {
  return dataType === "Real";
}
