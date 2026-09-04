import { beforeEach, describe, expect, it } from "vitest";

import { useIdsStore } from "../store";
import { serializeIds } from "../serialize";
import { applicabilityCardinality } from "../types";

/** The specification the store is currently editing, by store id. */
function spec(id: string) {
  const found = useIdsStore
    .getState()
    .document.specifications.find((s) => s.id === id);
  if (!found) throw new Error(`no specification ${id}`);
  return found;
}

describe("setApplicabilityCardinality", () => {
  beforeEach(() => useIdsStore.getState().reset());

  it("maps each filter optionality to IDS occurrence limits", () => {
    const { addSpecification, setApplicabilityCardinality } = useIdsStore.getState();
    addSpecification();
    const id = useIdsStore.getState().selectedId!;

    expect(applicabilityCardinality(spec(id).applicability)).toBe("required");
    for (const [choice, expected] of [
      ["optional", '<applicability minOccurs="0" maxOccurs="unbounded"/>'],
      ["prohibited", '<applicability minOccurs="0" maxOccurs="0"/>'],
      ["required", '<applicability minOccurs="1" maxOccurs="unbounded"/>'],
    ] as const) {
      setApplicabilityCardinality(id, choice);
      expect(applicabilityCardinality(spec(id).applicability)).toBe(choice);
      expect(serializeIds(useIdsStore.getState().document)).toContain(expected);
    }
  });
});

describe("setRequirementType", () => {
  beforeEach(() => {
    useIdsStore.getState().reset();
  });

  it("applies one cardinality to every requirement that allows it", () => {
    const { addSpecification, addFacet, setRequirementType } = useIdsStore.getState();

    addSpecification();
    const id = useIdsStore.getState().selectedId!;
    addFacet(id, "requirements", "property");
    addFacet(id, "requirements", "attribute");

    setRequirementType(id, "prohibited");

    expect(spec(id).requirements.map((r) => r.cardinality)).toEqual([
      "prohibited",
      "prohibited",
    ]);
  });

  it("remembers a choice before any requirements exist", () => {
    const { addSpecification, addFacet, setRequirementType } = useIdsStore.getState();

    addSpecification();
    const id = useIdsStore.getState().selectedId!;
    setRequirementType(id, "optional");

    expect(spec(id).defaultRequirementCardinality).toBe("optional");
    addFacet(id, "requirements", "property");
    expect(spec(id).requirements[0].cardinality).toBe("optional");
  });

  it("skips a facet kind that has no optional cardinality", () => {
    const { addSpecification, addFacet, setRequirementType } = useIdsStore.getState();

    addSpecification();
    const id = useIdsStore.getState().selectedId!;
    addFacet(id, "requirements", "entity");
    addFacet(id, "requirements", "property");

    setRequirementType(id, "optional");

    const [entity, property] = spec(id).requirements;
    // Entity's `simpleCardinality` has no `optional` in the XSD, so the entity
    // requirement is left untouched rather than written invalid.
    expect(entity.cardinality).toBe("required");
    expect(property.cardinality).toBe("optional");
    expect(spec(id).defaultRequirementCardinality).toBe("optional");
  });
});

describe("addFacet on the requirements block", () => {
  beforeEach(() => {
    useIdsStore.getState().reset();
  });

  it("defaults a new facet to the specification's existing requirement type", () => {
    const { addSpecification, addFacet, setRequirementType } = useIdsStore.getState();

    addSpecification();
    const id = useIdsStore.getState().selectedId!;
    addFacet(id, "requirements", "property");
    setRequirementType(id, "optional");

    addFacet(id, "requirements", "attribute");

    expect(spec(id).requirements.at(-1)!.cardinality).toBe("optional");
  });

  it("falls back to required when the existing type is not allowed for the new kind", () => {
    const { addSpecification, addFacet, setRequirementType } = useIdsStore.getState();

    addSpecification();
    const id = useIdsStore.getState().selectedId!;
    addFacet(id, "requirements", "property");
    setRequirementType(id, "optional");

    // Entity has no `optional`, so it cannot inherit the spec's current type.
    addFacet(id, "requirements", "entity");

    expect(spec(id).requirements.at(-1)!.cardinality).toBe("required");
  });
});
