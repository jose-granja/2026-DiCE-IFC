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

describe("startNew", () => {
  beforeEach(() => useIdsStore.getState().reset());

  it("starts with blank metadata, no specifications and file metadata selected", async () => {
    const { addSpecification, updateInfo, startNew } = useIdsStore.getState();
    addSpecification();
    updateInfo({ title: "Existing IDS", description: "Work in progress" });

    await startNew();

    const state = useIdsStore.getState();
    expect(state.document.info.title).toBe("Untitled specification");
    expect(state.document.info.description).toBeUndefined();
    expect(state.document.specifications).toEqual([]);
    expect(state.selectedId).toBeNull();
    expect(state.dirty).toBe(false);
  });
});

describe("setRequirementType", () => {
  beforeEach(() => {
    useIdsStore.getState().reset();
  });

  it("sets the specification's occurrence limits from the requirement type", () => {
    const { addSpecification, setRequirementType } = useIdsStore.getState();
    addSpecification();
    const id = useIdsStore.getState().selectedId!;

    expect(applicabilityCardinality(spec(id).applicability)).toBe("required");
    for (const [choice, expected] of [
      ["optional", '<applicability minOccurs="0" maxOccurs="unbounded"/>'],
      ["prohibited", '<applicability minOccurs="0" maxOccurs="0"/>'],
      ["required", '<applicability minOccurs="1" maxOccurs="unbounded"/>'],
    ] as const) {
      setRequirementType(id, choice);
      expect(applicabilityCardinality(spec(id).applicability)).toBe(choice);
      expect(serializeIds(useIdsStore.getState().document)).toContain(expected);
    }
  });

  it("leaves each existing requirement on its own cardinality", () => {
    const { addSpecification, addFacet, setCardinality, setRequirementType } =
      useIdsStore.getState();

    addSpecification();
    const id = useIdsStore.getState().selectedId!;
    addFacet(id, "requirements", "property");
    addFacet(id, "requirements", "attribute");
    const [first, second] = spec(id).requirements;
    setCardinality(id, second.id, "prohibited");

    setRequirementType(id, "optional");

    expect(spec(id).requirements.map((r) => r.cardinality)).toEqual([
      first.cardinality,
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

  it("never gives a facet kind a cardinality its XSD type forbids", () => {
    const { addSpecification, addFacet, setRequirementType } = useIdsStore.getState();

    addSpecification();
    const id = useIdsStore.getState().selectedId!;
    setRequirementType(id, "optional");
    addFacet(id, "requirements", "entity");
    addFacet(id, "requirements", "property");

    const [entity, property] = spec(id).requirements;
    // Entity's `simpleCardinality` has no `optional`, so a new entity
    // requirement starts as required instead.
    expect(entity.cardinality).toBe("required");
    expect(property.cardinality).toBe("optional");
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
