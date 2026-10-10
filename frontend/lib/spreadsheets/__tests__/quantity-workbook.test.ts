// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  createQuantityWorkbook,
  parseQuantityConfigurationRows,
  readQuantityWorkbook,
} from "../quantity-workbook";

describe("quantity workbook", () => {
  it("imports the WBS table structure from the reference document", () => {
    const definitions = parseQuantityConfigurationRows([
      ["WBS", "Description", "IfcClass", "Predefined Type", "ObjectType", "Material", "Property", "Quantity", "Unit"],
      ["13", "ALVENARIAS"],
      ["13.01.01", "PAREDES", "IfcWall", "PARTITIONING", "", "MASONRY", "Pset_WallCommon.LoadBearing = FALSE", "Qto_WallBaseQuantities.NetSideArea", "m2"],
      ["14.04.01", "EQUIPAMENTOS FIXOS", "IfcFurniture", "USERDEFINED", "STONE FURNITURE", "", "Pset_FurnitureTypeCommon.IsBuiltIn = TRUE", "(element count)", "un"],
    ]);

    expect(definitions).toHaveLength(2);
    expect(definitions[0]).toMatchObject({
      code: "13.01.01",
      description: "PAREDES",
      query: {
        filters: {
          classes: ["IfcWall"],
          predefinedTypes: ["PARTITIONING"],
          materials: ["MASONRY"],
          properties: [{
            setName: "Pset_WallCommon",
            propertyName: "LoadBearing",
            operator: "equals",
            value: "FALSE",
          }],
        },
        sources: [{
          kind: "quantity",
          setName: "Qto_WallBaseQuantities",
          valueName: "NetSideArea",
        }],
        unit: "m2",
      },
    });
    expect(definitions[1].query.sources[0].kind).toBe("count");
  });

  it("round trips configurations and writes summary and detail values", () => {
    const bytes = createQuantityWorkbook([{
      code: "13.01.01",
      description: "Walls",
      query: {
        filters: {
          classes: ["IfcWall"],
          predefinedTypes: ["PARTITIONING"],
          objectTypes: [],
          materials: ["MASONRY"],
          materialCategories: ["Masonry", "Concrete"],
          properties: [{
            setName: "Pset_WallCommon",
            propertyName: "LoadBearing",
            operator: "equals",
            value: "FALSE",
          }],
        },
        sources: [{
          id: "area",
          alias: "area",
          kind: "quantity",
          setName: "Qto_WallBaseQuantities",
          valueName: "NetSideArea",
        }],
        unit: "m2",
      },
      result: {
        matchedCount: 1,
        missingValueCount: 0,
        total: 12.5,
        rows: [{
          modelName: "building.ifc",
          expressId: 42,
          globalId: "wall-guid",
          type: "IfcWall",
          name: "Wall 1",
          predefinedType: "PARTITIONING",
          objectType: "",
          materials: ["MASONRY"],
          inputs: { area: 12.5 },
          value: 12.5,
        }],
      },
    }]);

    expect(bytes[0]).toBe(0x50); // ZIP / XLSX signature
    expect(bytes[1]).toBe(0x4b);
    const [definition] = readQuantityWorkbook(bytes);
    expect(definition.code).toBe("13.01.01");
    expect(definition.description).toBe("Walls");
    expect(definition.query.filters.materials).toEqual(["MASONRY"]);
    expect(definition.query.filters.materialCategories).toEqual(["Masonry", "Concrete"]);
    expect(definition.query.sources[0]).toMatchObject({
      kind: "quantity",
      setName: "Qto_WallBaseQuantities",
      valueName: "NetSideArea",
    });
  });

  it("imports property and quantity sources used by an equation", () => {
    const [definition] = parseQuantityConfigurationRows([
      ["Code", "Description", "IfcClass", "Quantity", "Formula", "Unit"],
      [
        "20.01",
        "Calculated wall value",
        "IfcWall",
        "area = quantity:Qto_WallBaseQuantities.NetSideArea\nfactor = property:Pset_WallCommon.ThermalTransmittance",
        "area * factor",
        "W/K",
      ],
    ]);

    expect(definition.query.sources).toMatchObject([
      { alias: "area", kind: "quantity", setName: "Qto_WallBaseQuantities", valueName: "NetSideArea" },
      { alias: "factor", kind: "property", setName: "Pset_WallCommon", valueName: "ThermalTransmittance" },
    ]);
    expect(definition.query.formula).toBe("area * factor");
  });
});
