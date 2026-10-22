import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  ifcLiteAdapter,
  resetIfcLiteAdapter,
  resolveRenderOriginShift,
} from "../ifc-lite-adapter";
import { runAdapterConformance, type ConformanceFixtures } from "../conformance";
import type { QuantityQuery, QuantityQueryFilters } from "../types";

const FIXTURES = path.resolve(__dirname, "../../../fixtures/ifc");

async function load(name: string) {
  const buffer = await readFile(path.join(FIXTURES, name));
  return {
    name,
    bytes: buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer,
  };
}

const fixtures: ConformanceFixtures = {
  ifc4: await load("georeferenced-wall-ifc4.ifc"),
  ifc4x3: await load("bridge-ifc4x3.ifc"),
};

afterAll(() => {
  resetIfcLiteAdapter();
});

runAdapterConformance(ifcLiteAdapter, fixtures);

describe("geometry coordinate metadata", () => {
  it("combines the IFC Z-up WASM RTC offset with the later render shift", () => {
    expect(
      resolveRenderOriginShift({
        originShift: { x: 1, y: 2, z: 3 },
        wasmRtcOffset: { x: 100, y: 200, z: 5 },
      }),
    ).toEqual([101, 7, -197]);
  });
});

/**
 * `facets-ifc4.ifc`'s own `ThermalTransmittance` is wrapped in a bare
 * `IFCREAL`, not a named measure type — realistic for that fixture's own
 * purpose (quantity queries), but not something the engine's unit resolver
 * can map to a unit, so it cannot exercise this. This one instead carries a
 * genuine `IFCPOSITIVELENGTHMEASURE` occurrence property, an
 * `IFCAREAMEASURE` type property and both a length and a count quantity —
 * the count is the one that must come back with NO unit, being dimensionless.
 */
const UNITS_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('units.ifc','2026-01-01T00:00:00',('A'),('B'),'C','D','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPERSON($,'A','B',$,$,$,$,$);
#2= IFCORGANIZATION($,'Org',$,$,$);
#3= IFCPERSONANDORGANIZATION(#1,#2,$);
#4= IFCAPPLICATION(#2,'1.0','App','APP');
#5= IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#10= IFCCARTESIANPOINT((0.,0.,0.));
#11= IFCDIRECTION((0.,0.,1.));
#12= IFCDIRECTION((1.,0.,0.));
#13= IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14= IFCDIRECTION((0.,1.));
#15= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#13,#14);
/* A millimetre project: the resolved unit must be the file's own "mm", not
   the engine's SI-default "m" — proof this reads the declared assignment
   rather than a hardcoded default. */
#20= IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#21= IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#22= IFCUNITASSIGNMENT((#20,#21));
#30= IFCPROJECT('0ZvctVUKr0kugbFTf53O9L',#5,'P',$,$,$,$,(#15),#22);
#40= IFCAXIS2PLACEMENT3D(#10,$,$);
#41= IFCLOCALPLACEMENT($,#40);
#71= IFCWALL('7ZvctVUKr0kugbFTf53O9L',#5,'Wall A',$,$,#41,$,'WALL-A',.STANDARD.);
#150= IFCPROPERTYSINGLEVALUE('Width',$,IFCPOSITIVELENGTHMEASURE(200.),$);
#151= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI 60'),$);
#152= IFCPROPERTYSET('2PsetOccurrence00000001',#5,'Pset_WallCommon',$,(#150,#151));
#153= IFCRELDEFINESBYPROPERTIES('2RelDefByProps0000001',#5,$,$,(#71),#152);
#160= IFCPROPERTYSINGLEVALUE('CrossSectionArea',$,IFCAREAMEASURE(0.04),$);
#161= IFCPROPERTYSET('2PsetType000000000001',#5,'Pset_WallTypeCommon',$,(#160));
#162= IFCWALLTYPE('2WallType00000000001',#5,'Basic Wall 200',$,$,(#161),$,$,$,.STANDARD.);
#163= IFCRELDEFINESBYTYPE('2RelDefByType00000001',#5,$,$,(#71),#162);
#170= IFCQUANTITYLENGTH('Length',$,$,3000.);
#171= IFCQUANTITYCOUNT('PanelCount',$,$,4.);
#172= IFCELEMENTQUANTITY('2ElementQuantity000001',#5,'Qto_WallBaseQuantities',$,$,(#170,#171));
#173= IFCRELDEFINESBYPROPERTIES('2RelDefByQto000000001',#5,$,$,(#71),#172);
ENDSEC;
END-ISO-10303-21;
`;

describe("getElementInfo units", () => {
  it("resolves the file's own declared unit for a measure property, quantity and type property — and none for a label or a count", async () => {
    const summary = await ifcLiteAdapter.loadModel({
      name: "units.ifc",
      bytes: new TextEncoder().encode(UNITS_IFC).buffer as ArrayBuffer,
    });
    try {
      const info = await ifcLiteAdapter.getElementInfo(summary.id, 71);

      const width = info.propertySets
        .flatMap((set) => set.properties)
        .find((property) => property.name === "Width");
      expect(width?.value).toBe(200);
      expect(width?.unit).toBe("mm");

      // A label carries no unit at all, not even an empty string.
      const fireRating = info.propertySets
        .flatMap((set) => set.properties)
        .find((property) => property.name === "FireRating");
      expect(fireRating?.unit).toBeUndefined();

      const length = info.quantities
        .flatMap((set) => set.properties)
        .find((property) => property.name === "Length");
      expect(length?.value).toBe(3000);
      expect(length?.unit).toBe("mm");

      // Count is dimensionless — a unit here would be a fabricated one.
      const panelCount = info.quantities
        .flatMap((set) => set.properties)
        .find((property) => property.name === "PanelCount");
      expect(panelCount?.value).toBe(4);
      expect(panelCount?.unit).toBeUndefined();

      const crossSection = info.typeProperties
        .flatMap((set) => set.properties)
        .find((property) => property.name === "CrossSectionArea");
      expect(crossSection?.value).toBe(0.04);
      expect(crossSection?.unit).toBe("m²");
    } finally {
      await ifcLiteAdapter.unloadModel(summary.id);
    }
  });
});

/**
 * A wall with a plain `IfcMaterial` (not a layer/profile/constituent set),
 * carrying its own `IfcMaterialProperties` pset — the thing `getMaterialInfo`
 * opens when the Materials tab is clicked. Attribute order for both entities
 * (`IfcMaterial`: Name, Description, Category; `IfcMaterialProperties`:
 * Name, Description, Properties, Material) is read from the engine's own
 * bundled IFC4 schema, not assumed from memory.
 */
const MATERIAL_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('material.ifc','2026-01-01T00:00:00',('A'),('B'),'C','D','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPERSON($,'A','B',$,$,$,$,$);
#2= IFCORGANIZATION($,'Org',$,$,$);
#3= IFCPERSONANDORGANIZATION(#1,#2,$);
#4= IFCAPPLICATION(#2,'1.0','App','APP');
#5= IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#10= IFCCARTESIANPOINT((0.,0.,0.));
#11= IFCDIRECTION((0.,0.,1.));
#12= IFCDIRECTION((1.,0.,0.));
#13= IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14= IFCDIRECTION((0.,1.));
#15= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#13,#14);
#20= IFCSIUNIT(*,.MASSUNIT.,.KILO.,.GRAM.);
#21= IFCUNITASSIGNMENT((#20));
#30= IFCPROJECT('0ZvctVUKr0kugbFTf53O9L',#5,'P',$,$,$,$,(#15),#21);
#40= IFCAXIS2PLACEMENT3D(#10,$,$);
#41= IFCLOCALPLACEMENT($,#40);
#71= IFCWALL('7ZvctVUKr0kugbFTf53O9L',#5,'Wall A',$,$,#41,$,'WALL-A',.STANDARD.);
#100= IFCMATERIAL('Concrete C30/37','A structural concrete','Concrete');
#110= IFCRELASSOCIATESMATERIAL('9ZvctVUKr0kugbFTf53O9L',#5,$,$,(#71),#100);
#200= IFCPROPERTYSINGLEVALUE('MassDensity',$,IFCMASSMEASURE(2400.),$);
#201= IFCMATERIALPROPERTIES('Pset_MaterialCommon',$,(#200),#100);
ENDSEC;
END-ISO-10303-21;
`;

describe("materials", () => {
  it("lists an element's materials by their own IfcMaterial express id, and getMaterialInfo opens that entity's own properties", async () => {
    const summary = await ifcLiteAdapter.loadModel({
      name: "material.ifc",
      bytes: new TextEncoder().encode(MATERIAL_IFC).buffer as ArrayBuffer,
    });
    try {
      const info = await ifcLiteAdapter.getElementInfo(summary.id, 71);
      expect(info.materials).toEqual([
        { expressId: 100, name: "Concrete C30/37", category: "Concrete" },
      ]);

      const material = await ifcLiteAdapter.getMaterialInfo(summary.id, 100);
      expect(material.name).toBe("Concrete C30/37");
      // Normalised like every other class name the panel shows — not the
      // raw STEP keyword `getMaterialDisplay` returns ("IFCMATERIAL").
      expect(material.type).toBe("IfcMaterial");
      expect(material.description).toBe("A structural concrete");
      expect(material.category).toBe("Concrete");

      const massDensity = material.propertySets
        .flatMap((set) => set.properties)
        .find((property) => property.name === "MassDensity");
      expect(massDensity?.value).toBe(2400);
      expect(massDensity?.unit).toBe("kg");
      expect(
        material.propertySets.map((set) => set.name),
      ).toContain("Pset_MaterialCommon");
    } finally {
      await ifcLiteAdapter.unloadModel(summary.id);
    }
  });
});

describe("quantity queries", () => {
  const missingSourcesQuery: QuantityQuery = {
    filters: { classes: ["IfcWall"], predefinedTypes: [], objectTypes: [], materials: [], properties: [] },
    sources: [
      { id: "area", alias: "area", kind: "quantity", setName: "Qto_WallBaseQuantities", valueName: "NetSideArea" },
      { id: "extra", alias: "extra", kind: "property", setName: "Pset_WallCommon", valueName: "MissingProperty" },
      { id: "extra_area", alias: "extra_area", kind: "quantity", setName: "MissingQuantitySet", valueName: "Area" },
    ],
    formula: "area + extra + extra_area",
  };

  it("adds missing properties and quantities as zero, including rows whose formula inputs are all missing", async () => {
    const summary = await ifcLiteAdapter.loadModel(await load("facets-ifc4.ifc"));
    try {
      const result = await ifcLiteAdapter.evaluateQuantityQuery(summary.id, missingSourcesQuery);
      expect(result.rows.map((row) => row.value)).toEqual([12.5, 12.5]);
      expect(result.total).toBe(25);
      expect(result.valueCount).toBe(2);
      expect(result.missingValueCount).toBe(0);
      expect(result.rows[0].inputs).toEqual({ area: 12.5, extra: null, extra_area: null });

      const allMissing = await ifcLiteAdapter.evaluateQuantityQuery(summary.id, {
        ...missingSourcesQuery, sources: missingSourcesQuery.sources.slice(1), formula: "extra + extra_area",
      });
      expect(allMissing.rows.map((row) => row.value)).toEqual([0, 0]);
      expect(allMissing.total).toBe(0);
      expect(allMissing.missingValueCount).toBe(0);

      const withoutFormula = await ifcLiteAdapter.evaluateQuantityQuery(summary.id, {
        ...missingSourcesQuery, sources: [missingSourcesQuery.sources[1]], formula: undefined,
      });
      expect(withoutFormula.rows.map((row) => row.value)).toEqual([null, null]);
      expect(withoutFormula.total).toBeNull();
    } finally {
      await ifcLiteAdapter.unloadModel(summary.id);
    }
  });

  it.each(["$", "IFCLABEL('')", "IFCLABEL('   ')"])("uses zero for an empty IFC value (%s)", async (emptyValue) => {
    const input = await load("facets-ifc4.ifc");
    const text = new TextDecoder().decode(input.bytes).replace("IFCLABEL('REI 60')", emptyValue);
    const summary = await ifcLiteAdapter.loadModel({ ...input, bytes: new TextEncoder().encode(text).buffer });
    try {
      const result = await ifcLiteAdapter.evaluateQuantityQuery(summary.id, {
        ...missingSourcesQuery,
        sources: missingSourcesQuery.sources.map((source) => source.alias === "extra" ? { ...source, valueName: "FireRating" } : source),
      });
      expect(result.rows.map((row) => row.value)).toEqual([12.5, 12.5]);
      expect(result.total).toBe(25);
    } finally {
      await ifcLiteAdapter.unloadModel(summary.id);
    }
  });

  it("still rejects unknown aliases, nonnumeric values and division by a missing denominator", async () => {
    const summary = await ifcLiteAdapter.loadModel(await load("facets-ifc4.ifc"));
    try {
      await expect(ifcLiteAdapter.evaluateQuantityQuery(summary.id, {
        ...missingSourcesQuery, formula: "area + typo",
      })).rejects.toThrow(/unknown source/);
      const text = await ifcLiteAdapter.evaluateQuantityQuery(summary.id, {
        ...missingSourcesQuery,
        sources: missingSourcesQuery.sources.map((source) => source.alias === "extra" ? { ...source, valueName: "FireRating" } : source),
      });
      expect(text.rows.map((row) => row.value)).toEqual([null, null]);
      const division = await ifcLiteAdapter.evaluateQuantityQuery(summary.id, {
        ...missingSourcesQuery, formula: "area / extra",
      });
      expect(division.total).toBeNull();
      expect(division.missingValueCount).toBe(2);
    } finally {
      await ifcLiteAdapter.unloadModel(summary.id);
    }
  });

  it("filters occurrences and combines occurrence quantities with type properties", async () => {
    const summary = await ifcLiteAdapter.loadModel(await load("facets-ifc4.ifc"));
    try {
      const vocabulary = await ifcLiteAdapter.getVocabulary(summary.id);
      expect(vocabulary.quantitySets).toContainEqual({
        name: "Qto_WallBaseQuantities",
        quantities: ["NetSideArea"],
      });

      const result = await ifcLiteAdapter.evaluateQuantityQuery(summary.id, {
        filters: {
          classes: ["IfcWall"],
          predefinedTypes: [],
          objectTypes: [],
          materials: ["Concrete C30/37"],
          properties: [
            {
              setName: "Pset_WallCommon",
              propertyName: "LoadBearing",
              operator: "equals",
              value: "TRUE",
            },
          ],
        },
        sources: [
          {
            id: "area",
            alias: "area",
            kind: "quantity",
            setName: "Qto_WallBaseQuantities",
            valueName: "NetSideArea",
          },
          {
            id: "u_value",
            alias: "u_value",
            kind: "property",
            setName: "Pset_WallCommon",
            valueName: "ThermalTransmittance",
          },
        ],
        formula: "area * u_value",
      });

      expect(result.matchedCount).toBe(2);
      expect(result.missingValueCount).toBe(0);
      expect(result.rows.map((row) => row.value)).toEqual([2.25, 2.25]);
      expect(result.total).toBe(4.5);

      const alternatives = await ifcLiteAdapter.evaluateQuantityQuery(summary.id, {
        filters: {
          classes: ["IfcWall"],
          predefinedTypes: [],
          objectTypes: [],
          materials: [],
          propertyCombination: "any",
          properties: [
            {
              setName: "Pset_WallCommon",
              propertyName: "LoadBearing",
              operator: "equals",
              value: "TRUE",
            },
            {
              setName: "Pset_DoorCommon",
              propertyName: "IsExternal",
              operator: "equals",
              value: "TRUE",
            },
          ],
        },
        sources: [{ id: "count", alias: "count", kind: "count" }],
      });
      expect(alternatives.total).toBe(2);
    } finally {
      await ifcLiteAdapter.unloadModel(summary.id);
    }
  });

  it("filters by occurrence PredefinedType", async () => {
    const summary = await ifcLiteAdapter.loadModel(
      await load("georeferenced-wall-ifc4.ifc"),
    );
    try {
      const result = await ifcLiteAdapter.evaluateQuantityQuery(summary.id, {
        filters: {
          classes: ["IfcWall"],
          predefinedTypes: ["STANDARD"],
          objectTypes: [],
          materials: [],
          properties: [],
        },
        sources: [{ id: "count", alias: "count", kind: "count" }],
      });

      expect(result.matchedCount).toBe(2);
      expect(result.total).toBe(2);
      expect(result.rows.every((row) => row.predefinedType === "STANDARD")).toBe(true);
    } finally {
      await ifcLiteAdapter.unloadModel(summary.id);
    }
  });
});

/**
 * Classification filtering, through the engine rather than against a stub.
 * `classified-wall-ifc4.ifc` puts Wall A in two systems at once, which is the
 * case the "same reference" rule in `classification-filter.ts` exists for and
 * the one a stubbed fact list cannot prove the engine actually reports.
 */
describe("quantity queries filtered by classification", () => {
  const count = async (
    modelId: string,
    filters: Partial<QuantityQueryFilters>,
  ) => {
    const result = await ifcLiteAdapter.evaluateQuantityQuery(modelId, {
      filters: {
        classes: [],
        predefinedTypes: [],
        objectTypes: [],
        materials: [],
        properties: [],
        ...filters,
      },
      sources: [{ id: "count", alias: "count", kind: "count" }],
    });
    return result.rows.map((row) => row.name).sort();
  };

  it("reports the systems and the codes found in each of them", async () => {
    const summary = await ifcLiteAdapter.loadModel(await load("classified-wall-ifc4.ifc"));
    try {
      const vocabulary = await ifcLiteAdapter.getVocabulary(summary.id);
      expect(vocabulary.classificationSystems).toEqual(["Sistema Nacional", "Uniclass 2015"]);
      expect(vocabulary.classificationCodes).toEqual([
        { system: "Sistema Nacional", codes: ["EF_25_10"] },
        { system: "Uniclass 2015", codes: ["Ss_25_10_30", "Ss_25_10_60", "Ss_30_10_30"] },
      ]);
    } finally {
      await ifcLiteAdapter.unloadModel(summary.id);
    }
  });

  it("selects by code, by system, by both, and by a branch of codes", async () => {
    const summary = await ifcLiteAdapter.loadModel(await load("classified-wall-ifc4.ifc"));
    try {
      // Nothing asked: every placed element, classification or not.
      expect(await count(summary.id, {})).toEqual(["Slab A", "Wall A", "Wall B"]);

      expect(await count(summary.id, { classificationCodes: ["Ss_25_10_30"] })).toEqual(["Wall A"]);
      expect(await count(summary.id, { classificationSystem: "Sistema Nacional" })).toEqual(["Wall A"]);
      expect(
        await count(summary.id, {
          classificationSystem: "Uniclass 2015",
          classificationCodes: ["Ss_25*"],
        }),
      ).toEqual(["Wall A", "Wall B"]);

      // Wall A is Ss_25_10_30, and is in Sistema Nacional — but not that code
      // *in* that system, so it is not a match.
      expect(
        await count(summary.id, {
          classificationSystem: "Sistema Nacional",
          classificationCodes: ["Ss_25_10_30"],
        }),
      ).toEqual([]);
    } finally {
      await ifcLiteAdapter.unloadModel(summary.id);
    }
  });

  it("combines with the other filters rather than replacing them", async () => {
    const summary = await ifcLiteAdapter.loadModel(await load("classified-wall-ifc4.ifc"));
    try {
      expect(
        await count(summary.id, { classes: ["IfcSlab"], classificationCodes: ["Ss_30*"] }),
      ).toEqual(["Slab A"]);
      // The code is a wall's; the class is the slab's. Both must hold.
      expect(
        await count(summary.id, { classes: ["IfcSlab"], classificationCodes: ["Ss_25*"] }),
      ).toEqual([]);
    } finally {
      await ifcLiteAdapter.unloadModel(summary.id);
    }
  });

  it("matches nothing on a model that carries no classification at all", async () => {
    const summary = await ifcLiteAdapter.loadModel(await load("georeferenced-wall-ifc4.ifc"));
    try {
      const vocabulary = await ifcLiteAdapter.getVocabulary(summary.id);
      expect(vocabulary.classificationSystems).toEqual([]);
      expect(vocabulary.classificationCodes).toEqual([]);
      expect(await count(summary.id, { classificationCodes: ["Ss_25_10_30"] })).toEqual([]);
      // …and an untouched filter still selects everything.
      expect(await count(summary.id, { classificationSystem: "", classificationCodes: [] })).toEqual([
        "Slab A",
        "Wall A",
        "Wall B",
      ]);
    } finally {
      await ifcLiteAdapter.unloadModel(summary.id);
    }
  });
});
