// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ifcLiteAdapter as adapter, resetIfcLiteAdapter } from "@/lib/ifc/ifc-lite-adapter";
import { parseIdsForEngine } from "@/lib/ifc/ids-document";
import { parseIds } from "../parse";
import { serializeIds } from "../serialize";
import { validateAgainstSchema } from "../validate";
import { simple, type Facet, type Requirement } from "../types";

const fixtures = path.resolve(__dirname, "../../../fixtures");
const source = await readFile(path.join(fixtures, "ifc/facets-ifc4.ifc"), "utf8");
const xml = await readFile(path.join(fixtures, "ids/property-inspector.ids"), "utf8");
async function load(text = source) {
  return adapter.loadModel({ name: "facets.ifc", bytes: new TextEncoder().encode(text).buffer });
}
const model = await load();
afterAll(resetIfcLiteAdapter);

const property = (name: string, set = "Pset_WallCommon"): Facet => ({
  kind: "property", propertySet: simple(set), baseName: simple(name),
});
function custom(requirements: Facet[], applicability?: Facet[], cardinality: Requirement["cardinality"] = "required") {
  const { document } = parseIds(xml);
  const spec = document.specifications[0];
  document.specifications = [spec];
  spec.requirements = requirements.map((facet, i) => ({ id: String(i), facet, cardinality }));
  if (applicability) spec.applicability.facets = applicability.map((facet, i) => ({ id: String(i), facet }));
  return parseIdsForEngine(serializeIds(document));
}

describe("IDS property inspector", () => {
  it("uses a schema-valid IDS fixture", async () => {
    expect((await validateAgainstSchema(parseIds(xml).document)).errors).toEqual([]);
  });

  it("lists actual values, inheritance, quantities and missing requirements without a validation run", async () => {
    const rows = await adapter.getIdsProperties(model.id, 100, parseIdsForEngine(xml));
    expect(rows).toHaveLength(6);
    expect(rows.find((r) => r.name === "FireRating")).toMatchObject({ values: ["REI 60"], specifications: ["Wall information", "Fire safety"] });
    expect(rows.find((r) => r.name === "LoadBearing")).toMatchObject({ values: [true], state: "present" });
    expect(rows.find((r) => r.name === "ThermalTransmittance")).toMatchObject({ values: [0.18] });
    expect(rows.find((r) => r.name === "NetSideArea")).toMatchObject({ values: [12.5], unit: "m²" });
    expect(rows.find((r) => r.name === "IsExternal")).toMatchObject({ values: [], state: "missing" });
    expect(rows.find((r) => r.name === "Name")).toMatchObject({ kind: "attribute", values: ["Wall A"] });
    expect(await adapter.getIdsProperties(model.id, 102, parseIdsForEngine(xml))).toEqual([]);
  });

  it("checks all applicability facets, not just the IFC class", async () => {
    const document = custom([property("IsExternal")], [
      { kind: "entity", name: simple("IFCWALL") },
      { kind: "attribute", name: simple("Name"), value: simple("Wall A") },
      { ...property("FireRating"), value: simple("REI 60") } as Facet,
    ]);
    expect(await adapter.getIdsProperties(model.id, 100, document)).toHaveLength(1);
    expect(await adapter.getIdsProperties(model.id, 101, document)).toEqual([]);
  });

  it("labels converted measures in SI, including inherited properties and explicit unit overrides", async () => {
    const changed = await load(source
      .replace(".LENGTHUNIT.,$,.METRE.", ".LENGTHUNIT.,.MILLI.,.METRE.")
      .replace("IFCREAL(0.18)", "IFCTHERMALTRANSMITTANCEMEASURE(0.18)")
      .replace("(#150,#151)", "(#150,#151,#180,#181,#182)")
      .replace("ENDSEC;\nEND-ISO", `
#180= IFCPROPERTYSINGLEVALUE('Width',$,IFCPOSITIVELENGTHMEASURE(200.),$);
#181= IFCPROPERTYSINGLEVALUE('OwnUnitWidth',$,IFCLENGTHMEASURE(20.),#183);
#182= IFCPROPERTYLISTVALUE('Lengths',$,(IFCLENGTHMEASURE(100.),IFCLENGTHMEASURE(250.)),$);
#183= IFCSIUNIT(*,.LENGTHUNIT.,.CENTI.,.METRE.);
ENDSEC;\nEND-ISO`));
    const rows = await adapter.getIdsProperties(changed.id, 100, custom([
      property("Width"), property("OwnUnitWidth"), property("Lengths"), property("ThermalTransmittance"),
      property("NetSideArea", "Qto_WallBaseQuantities"),
    ]));
    expect(rows.find((r) => r.name === "Width")).toMatchObject({ values: [0.2], unit: "m" });
    expect(rows.find((r) => r.name === "OwnUnitWidth")).toMatchObject({ values: [0.2], unit: "m" });
    expect(rows.find((r) => r.name === "Lengths")).toMatchObject({ values: ["0.1", "0.25"], unit: "m" });
    expect(rows.find((r) => r.name === "ThermalTransmittance")).toMatchObject({ values: [0.18], unit: "W/(m²·K)" });
    expect(rows.find((r) => r.name === "NetSideArea")).toMatchObject({ values: [12.5], unit: "m²" });
    // The ordinary properties tab still shows author units; only IDS uses SI.
    const raw = await adapter.getElementInfo(changed.id, 100);
    expect(raw.propertySets.flatMap((set) => set.properties).find((p) => p.name === "Width"))
      .toMatchObject({ value: 200, unit: "mm" });
  });

  it("does not invent units for unitless, mixed, missing or mistyped values", async () => {
    const changed = await load(source.replace("(#150,#151)", "(#150,#151,#180,#181)")
      .replace("ENDSEC;\nEND-ISO", `
#180= IFCPROPERTYSINGLEVALUE('Count',$,IFCCOUNTMEASURE(3.),$);
#181= IFCPROPERTYLISTVALUE('Mixed',$,(IFCLENGTHMEASURE(2.),IFCAREAMEASURE(5.)),$);
ENDSEC;\nEND-ISO`));
    const rows = await adapter.getIdsProperties(changed.id, 100, custom([
      // The IDS expects a length, but the actual property is a label.
      { ...property("FireRating"), dataType: "IFCLENGTHMEASURE" } as Facet,
      property("LoadBearing"), property("ThermalTransmittance"), property("Count"), property("Mixed"), property("Missing"),
    ]));
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row.unit, row.name).toBeUndefined();
  });

  it("also labels measure-typed attributes using the entity schema", async () => {
    const changed = await load(source
      .replace(".LENGTHUNIT.,$,.METRE.", ".LENGTHUNIT.,.MILLI.,.METRE.")
      .replace(/#100= IFCWALL\([^\n]+/, "#100= IFCDOOR('2FacetWall00000000001',#5,'Door',$,$,#70,#65,$,2100.,900.,.DOOR.,.SINGLE_SWING_LEFT.,$);"));
    const rows = await adapter.getIdsProperties(changed.id, 100, custom([
      { kind: "attribute", name: simple("OverallHeight") },
      { kind: "attribute", name: simple("overallwidth") },
    ], [{ kind: "entity", name: simple("IFCDOOR") }]));
    expect(rows[0]).toMatchObject({ values: [2.1], unit: "m" });
    expect(rows[1]).toMatchObject({ values: [0.9], unit: "m" });
  });

  it("expands name patterns, and keeps missing fields in every matching set", async () => {
    const document = custom([{
      kind: "property", propertySet: { kind: "restriction", base: "xs:string", pattern: "Pset_.*" },
      baseName: { kind: "restriction", base: "xs:string", pattern: "Fire.*|Load.*" },
    }, property("Missing", "Absent_Set")]);
    const rows = await adapter.getIdsProperties(model.id, 100, document);
    expect(rows.map((r) => r.name)).toEqual(["FireRating", "LoadBearing", "Missing"]);
    expect(rows[2]).toMatchObject({ propertySet: "Absent_Set", state: "missing" });
  });

  it("does not hide present values that fail an IDS data type or value constraint", async () => {
    const document = custom([{
      kind: "property", propertySet: simple("Pset_WallCommon"), baseName: simple("FireRating"),
      dataType: "IFCINTEGER", value: simple("90"),
    }]);
    expect((await adapter.getIdsProperties(model.id, 100, document))[0].values).toEqual(["REI 60"]);
  });

  it("preserves zero and false and distinguishes an empty value from a missing property", async () => {
    const changed = await load(source.replace("IFCBOOLEAN(.T.)", "IFCBOOLEAN(.F.)")
      .replace("IFCREAL(0.18)", "IFCREAL(0.)").replace("IFCLABEL('REI 60')", "IFCLABEL('')"));
    const rows = await adapter.getIdsProperties(changed.id, 100, parseIdsForEngine(xml));
    expect(rows.find((r) => r.name === "LoadBearing")).toMatchObject({ values: [false], state: "present" });
    expect(rows.find((r) => r.name === "ThermalTransmittance")).toMatchObject({ values: [0], state: "present" });
    expect(rows.find((r) => r.name === "FireRating")).toMatchObject({ state: "empty" });
    // Another model's identical express ID must still return its own values.
    expect((await adapter.getIdsProperties(model.id, 100, parseIdsForEngine(xml))).find((r) => r.name === "LoadBearing")?.values).toEqual([true]);
  });

  it("shows an occurrence override instead of the inherited type value", async () => {
    const changed = await load(source.replace("(#150,#151)", "(#150,#151,#180)")
      .replace("ENDSEC;\nEND-ISO", "#180= IFCPROPERTYSINGLEVALUE('ThermalTransmittance',$,IFCREAL(0.5),$);\nENDSEC;\nEND-ISO"));
    const rows = await adapter.getIdsProperties(changed.id, 100, parseIdsForEngine(xml));
    expect(rows.filter((r) => r.name === "ThermalTransmittance").map((r) => r.values)).toEqual([[0.5]]);
  });

  it("does not label optional or prohibited fields, or another schema's requirements, as required", async () => {
    for (const cardinality of ["optional", "prohibited"] as const) {
      expect(await adapter.getIdsProperties(model.id, 100, custom([property("FireRating")], undefined, cardinality))).toEqual([]);
    }
    expect(await adapter.getIdsProperties(model.id, 100, parseIdsForEngine(xml.replaceAll('ifcVersion="IFC4"', 'ifcVersion="IFC2X3"')))).toEqual([]);
  });
});
