import { describe, expect, it } from "vitest";

import { effectivePredefinedType, ifctesterPredefinedType, userDefinedAttributeOfType } from "../predefined-type";

const attrs = (values: Record<string, string>) => Object.entries(values).map(([name, value]) => ({ name, value }));
const wallType = (values: Record<string, string>) => ({ type: "IfcWallType", attributes: attrs(values) });

describe("effectivePredefinedType", () => {
  it("takes the type's when the occurrence has none", () => {
    expect(effectivePredefinedType(attrs({}), wallType({ PredefinedType: "STANDARD" }))).toEqual({
      value: "STANDARD",
      enumValue: "STANDARD",
      source: "type",
    });
  });

  it("names a USERDEFINED type by its ElementType (IDS: inherited predefined types)", () => {
    expect(effectivePredefinedType(attrs({ PredefinedType: "" }), wallType({ PredefinedType: "USERDEFINED", ElementType: "X" }))).toEqual({
      value: "X",
      enumValue: "USERDEFINED",
      source: "type",
      userDefinedIn: "ElementType",
    });
  });

  it("lets the type's override the occurrence's own, and says what was overridden", () => {
    const view = effectivePredefinedType(attrs({ PredefinedType: "PARTITIONING" }), wallType({ PredefinedType: "SOLIDWALL" }));
    expect(view).toMatchObject({ value: "SOLIDWALL", source: "type", overridden: "PARTITIONING" });
    const named = effectivePredefinedType(attrs({ PredefinedType: "USERDEFINED", ObjectType: "Acoustic" }), wallType({ PredefinedType: "SOLIDWALL" }));
    expect(named?.overridden).toBe("Acoustic");
  });

  it("keeps the occurrence's own when the type is NOTDEFINED (IDS: overridden predefined types)", () => {
    expect(effectivePredefinedType(attrs({ PredefinedType: "USERDEFINED", ObjectType: "X" }), wallType({ PredefinedType: "NOTDEFINED" }))).toEqual({
      value: "X",
      enumValue: "USERDEFINED",
      source: "occurrence",
      userDefinedIn: "ObjectType",
    });
  });

  it("keeps the occurrence's own without a type, or with a type that has none", () => {
    expect(effectivePredefinedType(attrs({ PredefinedType: "STANDARD" }), null)).toMatchObject({ value: "STANDARD", source: "occurrence" });
    expect(effectivePredefinedType(attrs({ PredefinedType: "STANDARD" }), wallType({ Name: "Basic" }))).toMatchObject({ source: "occurrence" });
  });

  it("shows NOTDEFINED from whichever says it, and nothing when neither says anything", () => {
    expect(effectivePredefinedType(attrs({ PredefinedType: "NOTDEFINED" }), wallType({ PredefinedType: "NOTDEFINED" }))).toMatchObject({ value: "NOTDEFINED", source: "occurrence" });
    expect(effectivePredefinedType(attrs({}), wallType({ PredefinedType: "NOTDEFINED" }))).toMatchObject({ value: "NOTDEFINED", source: "type" });
    expect(effectivePredefinedType(attrs({}), null)).toBeNull();
    expect(effectivePredefinedType(attrs({}), wallType({}))).toBeNull();
  });

  it("keeps USERDEFINED as the value when nothing names it", () => {
    expect(effectivePredefinedType(attrs({}), wallType({ PredefinedType: "USERDEFINED" }))).toEqual({
      value: "USERDEFINED",
      enumValue: "USERDEFINED",
      source: "type",
      userDefinedIn: "ElementType",
    });
  });

  it("reads an enumeration however it is written", () => {
    expect(effectivePredefinedType(attrs({ PredefinedType: ".standard." }), null)?.value).toBe("STANDARD");
  });

  it("finds a process or resource type's user-defined value where the schema keeps it", () => {
    expect(userDefinedAttributeOfType("IfcTaskType")).toBe("ProcessType");
    expect(userDefinedAttributeOfType("IfcEventType")).toBe("ProcessType");
    expect(userDefinedAttributeOfType("IfcLaborResourceType")).toBe("ResourceType");
    expect(userDefinedAttributeOfType("IfcSpaceType")).toBe("ElementType");
    expect(
      effectivePredefinedType(attrs({}), { type: "IfcTaskType", attributes: attrs({ PredefinedType: "USERDEFINED", ProcessType: "Curing" }) }),
    ).toMatchObject({ value: "Curing", userDefinedIn: "ProcessType" });
  });
});

describe("ifctesterPredefinedType", () => {
  it("reads it as IfcOpenShell's get_predefined_type and is_userdefined_type do", () => {
    // The type's wins; USERDEFINED is named by the type's ElementType.
    expect(ifctesterPredefinedType(attrs({}), attrs({ PredefinedType: "USERDEFINED", ElementType: "X" }))).toEqual({ value: "X", userDefined: true });
    // ObjectType with no PredefinedType is user-defined.
    expect(ifctesterPredefinedType(attrs({ ObjectType: "Basic Wall" }), null)).toEqual({ value: "Basic Wall", userDefined: true });
    // ElementType with no PredefinedType on the type is user-defined.
    expect(ifctesterPredefinedType(attrs({}), attrs({ PredefinedType: "", ElementType: "Desk" }))).toEqual({ value: "Desk", userDefined: true });
    // A USERDEFINED type naming nothing: the occurrence's value, still user-defined.
    expect(ifctesterPredefinedType(attrs({ PredefinedType: "STANDARD" }), attrs({ PredefinedType: "USERDEFINED", ElementType: "" }))).toEqual({ value: "STANDARD", userDefined: true });
    // A type's real value settles it: not user-defined, whatever the occurrence says.
    expect(ifctesterPredefinedType(attrs({ PredefinedType: "USERDEFINED", ObjectType: "Y" }), attrs({ PredefinedType: "SOLIDWALL" }))).toEqual({ value: "SOLIDWALL", userDefined: false });
    // A class without ElementType names it by ProcessType.
    expect(ifctesterPredefinedType(attrs({}), attrs({ PredefinedType: "USERDEFINED", ProcessType: "Curing" }))).toEqual({ value: "Curing", userDefined: true });
  });
});
