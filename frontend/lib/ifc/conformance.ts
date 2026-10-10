/**
 * The adapter conformance suite.
 *
 * Any engine that wants to serve a module in this app has to pass this. It is
 * written against `IfcEngineAdapter` only — it must never import an engine —
 * so a That Open implementation can be dropped in and run through the same
 * assertions without a line of it changing.
 *
 * Call it from a Vitest file:
 *
 *   describe("ifc-lite", () => runAdapterConformance(ifcLiteAdapter, fixtures));
 */

import { expect, describe, it, beforeAll, afterAll } from "vitest";
import type { IfcEngineAdapter, ModelSummary } from "./types";

export type ConformanceFixtures = {
  /** A small IFC4 building with a wall, a Pset and an IfcMapConversion. */
  ifc4: { name: string; bytes: ArrayBuffer };
  /** A small IFC4X3_ADD2 infrastructure model, millimetre units, rotated grid. */
  ifc4x3: { name: string; bytes: ArrayBuffer };
};

export function runAdapterConformance(
  adapter: IfcEngineAdapter,
  fixtures: ConformanceFixtures,
) {
  describe(`${adapter.engineId} — IFC4`, () => {
    let model: ModelSummary;

    beforeAll(async () => {
      model = await adapter.loadModel(fixtures.ifc4);
    });

    afterAll(async () => {
      await adapter.unloadModel(model.id);
    });

    it("reports the schema and a plausible entity count", () => {
      expect(model.schema).toBe("IFC4");
      expect(model.schemaToken).toBe("IFC4");
      expect(model.entityCount).toBeGreaterThan(20);
      expect(model.byteLength).toBe(fixtures.ifc4.bytes.byteLength);
    });

    it("reads metres as a unit scale of 1", () => {
      expect(model.lengthUnitScale).toBeCloseTo(1, 6);
    });

    it("streams progress while parsing", async () => {
      const phases: string[] = [];
      const second = await adapter.loadModel(fixtures.ifc4, {
        onProgress: (p) => phases.push(p.phase),
      });
      await adapter.unloadModel(second.id);
      expect(phases.length).toBeGreaterThan(0);
    });

    it("mints a distinct id per load, so federation can hold two copies", async () => {
      const second = await adapter.loadModel(fixtures.ifc4);
      expect(second.id).not.toBe(model.id);
      await adapter.unloadModel(second.id);
    });

    it("lists entity types with counts", async () => {
      const types = await adapter.getEntityTypes(model.id);
      const byName = new Map(types.map((t) => [t.type, t.count]));
      expect(byName.get("IfcWall")).toBe(2);
      expect(byName.get("IfcSlab")).toBe(1);
    });

    it("filters entities by type and resolves their root attributes", async () => {
      const walls = await adapter.getEntities(model.id, { types: ["IfcWall"] });
      expect(walls).toHaveLength(2);

      const wallA = walls.find((w) => w.name === "Wall A");
      expect(wallA).toBeDefined();
      expect(wallA!.globalId).toBe("7YvctVUKr0kugbFTf53O9L");
      expect(wallA!.description).toBe("External wall");
      expect(wallA!.tag).toBe("WALL-A");
    });

    it("accepts UPPERCASE STEP type spellings", async () => {
      const walls = await adapter.getEntities(model.id, { types: ["IFCWALL"] });
      expect(walls).toHaveLength(2);
    });

    it("pages entities for virtualised tables", async () => {
      const all = await adapter.getEntities(model.id, { types: ["IfcWall"] });
      const page = await adapter.getEntities(model.id, {
        types: ["IfcWall"],
        offset: 1,
        limit: 1,
      });
      expect(page).toHaveLength(1);
      expect(page[0].expressId).toBe(all[1].expressId);
    });

    it("fetches entities by an explicit express id list, in the order given", async () => {
      const walls = await adapter.getEntities(model.id, { types: ["IfcWall"] });
      const wallA = walls.find((w) => w.name === "Wall A")!;
      const [slab] = await adapter.getEntities(model.id, { types: ["IfcSlab"] });

      // Reversed on purpose: a caller asking by id (a spatial node's own
      // element list) has already decided the order, and `types` — which
      // always returns ascending — must not override it.
      const reversed = await adapter.getEntities(model.id, {
        expressIds: [slab.expressId, wallA.expressId],
      });
      expect(reversed.map((entity) => entity.expressId)).toEqual([
        slab.expressId,
        wallA.expressId,
      ]);
      expect(reversed[1].name).toBe("Wall A");
    });

    it("collects the vocabulary an IDS author needs", async () => {
      const vocabulary = await adapter.getVocabulary(model.id);

      // Autocompleting from the model is the point: a specification written
      // against a mistyped Pset name reports every element as failing.
      expect(vocabulary.entityTypes.map((t) => t.type)).toContain("IfcWall");

      const wallCommon = vocabulary.propertySets.find(
        (set) => set.name === "Pset_WallCommon",
      );
      expect(wallCommon).toBeDefined();
      expect(wallCommon!.properties).toEqual(
        expect.arrayContaining(["FireRating", "IsExternal", "LoadBearing"]),
      );

      // The fixture has no classifications or materials, so these must be
      // empty rather than absent.
      expect(Array.isArray(vocabulary.classificationSystems)).toBe(true);
      expect(Array.isArray(vocabulary.materials)).toBe(true);
    });

    it("returns property sets for an entity", async () => {
      const [wallA] = await adapter.getEntities(model.id, {
        types: ["IfcWall"],
      });
      const sets = await adapter.getProperties(model.id, wallA.expressId);

      const common = sets.find((s) => s.name === "Pset_WallCommon");
      expect(common).toBeDefined();

      const fireRating = common!.properties.find((p) => p.name === "FireRating");
      expect(fireRating?.value).toBe("REI 60");

      const isExternal = common!.properties.find((p) => p.name === "IsExternal");
      // IFC booleans must not come back as the string "T".
      expect(isExternal?.value).toBe(true);
    });

    it("returns an empty list rather than throwing for an entity with no Psets", async () => {
      const [slab] = await adapter.getEntities(model.id, { types: ["IfcSlab"] });
      await expect(
        adapter.getProperties(model.id, slab.expressId),
      ).resolves.toEqual([]);
    });

    it("builds the spatial tree down to the storey", async () => {
      const root = await adapter.getSpatialTree(model.id);

      const site = root.children[0];
      expect(site).toBeDefined();
      const building = site.children[0];
      expect(building).toBeDefined();
      const storey = building.children[0];
      expect(storey).toBeDefined();

      // The engine stores these as numeric enum values. The adapter boundary
      // must expose canonical IFC names so filters can recognise IfcSpace.
      expect(root.type).toBe("IfcProject");
      expect(site.type).toBe("IfcSite");
      expect(building.type).toBe("IfcBuilding");
      expect(storey.type).toBe("IfcBuildingStorey");

      expect(storey.elevation).toBeCloseTo(0, 6);
      // The three elements are contained in the storey, not in the building.
      expect(storey.elementIds).toHaveLength(3);
    });

    it("tessellates the elements that have a representation", async () => {
      const geometry = await adapter.getGeometry(model.id);

      // Wall A and Slab A carry an IfcExtrudedAreaSolid; Wall B does not, and
      // must not silently acquire one.
      expect(geometry.meshes.length).toBeGreaterThanOrEqual(2);
      expect(geometry.totalTriangles).toBeGreaterThan(0);
      expect(geometry.totalVertices).toBeGreaterThan(0);

      for (const mesh of geometry.meshes) {
        expect(mesh.positions.length % 3).toBe(0);
        expect(mesh.normals.length).toBe(mesh.positions.length);
        expect(mesh.indices.length % 3).toBe(0);
        expect(mesh.color).toHaveLength(4);
        // Indices must address vertices that exist, or the renderer reads
        // past the buffer and draws garbage.
        const vertexCount = mesh.positions.length / 3;
        for (const index of mesh.indices) {
          expect(index).toBeLessThan(vertexCount);
        }
      }
    });

    it("places meshes in the world via origin, not by baking it into positions", async () => {
      const { meshes, coordinates } = await adapter.getGeometry(model.id);

      // `positions` are element-local for float32 precision; world position is
      // `origin + positions`. A renderer that ignores `origin` stacks every
      // element at 0,0,0 — and every mesh here would still individually look
      // correct, which is exactly why this needs asserting.
      const worldBounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      for (const mesh of meshes) {
        for (let i = 0; i < mesh.positions.length; i += 3) {
          for (let axis = 0; axis < 3; axis += 1) {
            const value = mesh.origin[axis] + mesh.positions[i + axis];
            worldBounds.min[axis] = Math.min(worldBounds.min[axis], value);
            worldBounds.max[axis] = Math.max(worldBounds.max[axis], value);
          }
        }
      }

      // Reconstructed world bounds must agree with what the engine reported.
      for (let axis = 0; axis < 3; axis += 1) {
        expect(worldBounds.min[axis]).toBeCloseTo(
          coordinates.originalBounds.min[axis],
          2,
        );
        expect(worldBounds.max[axis]).toBeCloseTo(
          coordinates.originalBounds.max[axis],
          2,
        );
      }
    });

    it("does not emit instanced type templates as renderable meshes", async () => {
      const { meshes } = await adapter.getGeometry(model.id);
      // One MeshData per element here; a duplicate expressId at the same origin
      // would mean a template slipped through and geometry is drawn twice.
      const seen = new Set<string>();
      for (const mesh of meshes) {
        const key = `${mesh.expressId}@${mesh.origin.join(",")}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    });

    it("reports the coordinate frame the meshes are in", async () => {
      const { coordinates } = await adapter.getGeometry(model.id);

      // The fixture models a 4 × 0.3 × 3 wall and a 5 × 4 × 0.2 slab at the
      // origin, so no RTC shift is needed.
      expect(coordinates.hasLargeCoordinates).toBe(false);
      expect(coordinates.lengthUnitScale).toBeCloseTo(1, 6);

      const size = coordinates.originalBounds.max.map(
        (v, i) => v - coordinates.originalBounds.min[i],
      );
      expect(Math.max(...size)).toBeGreaterThan(1);
      // A federated viewer needs a real box, not a degenerate one.
      expect(Math.min(...size)).toBeGreaterThan(0);
    });

    it("reads IfcMapConversion and IfcProjectedCRS", async () => {
      const georef = await adapter.getGeoreferencing(model.id);

      expect(georef.hasGeoreference).toBe(true);
      expect(georef.source).toBe("mapConversion");
      expect(georef.mapConversion?.eastings).toBeCloseTo(-40000, 6);
      expect(georef.mapConversion?.northings).toBeCloseTo(180000, 6);
      expect(georef.mapConversion?.orthogonalHeight).toBeCloseTo(190, 6);
      expect(georef.projectedCRS?.name).toBe("EPSG:3763");
      expect(georef.projectedCRS?.geodeticDatum).toBe("ETRS89");
      // XAxisAbscissa=1, XAxisOrdinate=0 → the model grid is aligned to map north.
      expect(georef.angleToGridNorth).toBeCloseTo(0, 6);
    });

    it("reads the Model representation context, TrueNorth included", async () => {
      const { context } = await adapter.getGeoreferencing(model.id);

      expect(context).toBeDefined();
      // The fixture's TrueNorth is (0, 1) — the model's +Y already points north,
      // so the bearing is 0. IFC stores a *direction*, not an angle, and reading
      // it as one would silently rotate every model.
      expect(context!.trueNorth).toEqual([0, 1]);
      expect(context!.trueNorthDegrees).toBeCloseTo(0, 6);
      expect(context!.worldCoordinateSystem).toEqual([0, 0, 0]);
      expect(context!.precision).toBeCloseTo(1e-5, 9);
    });

    it("reports the project length unit alongside the georeferencing", async () => {
      // Map conversion values are in project units, so a consumer that ignores
      // this places a millimetre model a thousand times too far away.
      const { lengthUnitScale } = await adapter.getGeoreferencing(model.id);
      expect(lengthUnitScale).toBeCloseTo(1, 6);
    });

    it("decodes IfcSite compound-degree latitude and longitude", async () => {
      const georef = await adapter.getGeoreferencing(model.id);
      // 41° 33' 04.5" N, 8° 25' 17.2" W
      expect(georef.site?.latitude).toBeCloseTo(41.551_25, 4);
      expect(georef.site?.longitude).toBeCloseTo(-8.421_444, 4);
      expect(georef.site?.elevation).toBeCloseTo(190, 6);
    });

    it("round-trips a STEP export", async () => {
      const result = await adapter.exportStep(model.id);
      expect(result.byteLength).toBeGreaterThan(0);

      const text = new TextDecoder().decode(result.content);
      expect(text.startsWith("ISO-10303-21;")).toBe(true);
      expect(text.trimEnd().endsWith("END-ISO-10303-21;")).toBe(true);
      expect(text).toContain("FILE_SCHEMA(('IFC4'))");
    });

    it("writes an edited attribute into the exported STEP", async () => {
      const [wallA] = await adapter.getEntities(model.id, { types: ["IfcWall"] });
      await adapter.setEntityAttribute(
        model.id,
        wallA.expressId,
        "Name",
        "Renamed wall",
      );

      const text = new TextDecoder().decode(
        (await adapter.exportStep(model.id)).content,
      );
      expect(text).toContain("Renamed wall");
    });

    it("writes staged georeferencing edits into the exported STEP", async () => {
      await adapter.setGeoreferencing(model.id, {
        mapConversion: { eastings: -41234.5, northings: 181234.5 },
        projectedCRS: { name: "EPSG:20790" },
      });

      const result = await adapter.exportStep(model.id);
      const text = new TextDecoder().decode(result.content);

      expect(text).toContain("EPSG:20790");
      expect(text).toContain("-41234.5");
      // Anything the export could not write must be reported, not swallowed.
      expect(Array.isArray(result.warnings)).toBe(true);
    });

    it("rejects an unknown model id", async () => {
      await expect(adapter.getEntities("nope")).rejects.toThrow(/not loaded/);
    });
  });

  describe(`${adapter.engineId} — IFC4X3`, () => {
    let model: ModelSummary;

    beforeAll(async () => {
      model = await adapter.loadModel(fixtures.ifc4x3);
    });

    afterAll(async () => {
      await adapter.unloadModel(model.id);
    });

    it("parses IFC4X3_ADD2 and preserves the exact schema token", () => {
      expect(model.schema).toBe("IFC4X3");
      expect(model.schemaToken).toBe("IFC4X3_ADD2");
    });

    it("reads millimetre units as a scale of 0.001", () => {
      expect(model.lengthUnitScale).toBeCloseTo(0.001, 9);
    });

    it("resolves IFC4X3 infrastructure classes the IFC4 registry does not know", async () => {
      const types = await adapter.getEntityTypes(model.id);
      const names = types.map((t) => t.type);
      expect(names).toContain("IfcBridge");
      expect(names).toContain("IfcBridgePart");

      const [bridge] = await adapter.getEntities(model.id, {
        types: ["IfcBridge"],
      });
      // LongName sits at index 7 for a spatial element; a fixed IfcElement
      // layout would read a different attribute here.
      expect(bridge.name).toBe("Bridge");
    });

    it("nests IfcBridgePart under IfcBridge in the spatial tree", async () => {
      const root = await adapter.getSpatialTree(model.id);
      const site = root.children[0];
      const bridge = site.children[0];
      expect(bridge.children[0]?.elementIds).toHaveLength(2);
    });

    it("reads a rotated map conversion and derives the angle to grid north", async () => {
      const georef = await adapter.getGeoreferencing(model.id);
      expect(georef.hasGeoreference).toBe(true);
      expect(georef.mapConversion?.eastings).toBeCloseTo(-37500.5, 6);
      // cos(10°), sin(10°)
      expect(georef.angleToGridNorth).toBeCloseTo(10, 3);
    });

    it("reports millimetre units on the IFC4X3 fixture", async () => {
      const { lengthUnitScale } = await adapter.getGeoreferencing(model.id);
      expect(lengthUnitScale).toBeCloseTo(0.001, 9);
    });

    it("round-trips a STEP export at IFC4X3", async () => {
      const text = new TextDecoder().decode(
        (await adapter.exportStep(model.id)).content,
      );
      expect(text).toContain("FILE_SCHEMA");
      expect(text).toContain("IFC4X3");
    });
  });
}
