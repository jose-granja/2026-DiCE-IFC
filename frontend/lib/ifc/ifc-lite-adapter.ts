/**
 * IFC-lite implementation of `IfcEngineAdapter`.
 *
 * This is the ONLY file in the app allowed to import `@ifc-lite/*`. If a second
 * one appears, the swap point described in `docs/adr/001-ifc-engine.md` is gone.
 *
 * Designed to run inside a Web Worker: it holds parsed stores in a module-level
 * map keyed by `ModelId`, and every method is async so the Comlink wrapper is a
 * pass-through.
 */

import {
  IfcParser,
  extractEntityAttributesOnDemand,
  extractAllEntityAttributes,
  extractPropertiesOnDemand,
  extractGeoreferencingOnDemand,
  extractClassificationSystemsOnDemand,
  extractAllMaterialsOnDemand,
  extractClassificationsOnDemand,
  extractQuantitiesOnDemand,
  extractTypePropertiesOnDemand,
  extractGroupMembersOnDemand,
  computeAngleToGridNorth,
  getAttributeNamesAcrossSchemas,
  normalizeIfcTypeName,
  type IfcDataStore,
} from "@ifc-lite/parser";
import {
  IfcTypeEnum,
  type IfcAttributeValue,
  type SpatialNode,
} from "@ifc-lite/data";
import { GeometryProcessor } from "@ifc-lite/geometry";
import type { AABB as IfcLiteAabb, Vec3 as IfcLiteVec3 } from "@ifc-lite/geometry";
import { MutablePropertyView, StoreEditor } from "@ifc-lite/mutations";
import { StepExporter } from "@ifc-lite/export";
import { validateIDS, type IDSDocument } from "@ifc-lite/ids";
import { createDataAccessor } from "@ifc-lite/ids/bridge";

import type { EngineIdsDocument } from "./ids-document";
import {
  UnknownModelError,
  type EditableAttribute,
  type EntityQuery,
  type Aabb,
  type EntitySummary,
  type GeometryOptions,
  type GeoreferencePatch,
  type GeoreferenceView,
  type IfcEngineAdapter,
  type IfcSchemaVersion,
  type LoadModelInput,
  type LoadModelOptions,
  type ModelGeometry,
  type ModelId,
  type ElementInfo,
  type PropertyValue,
  type FilterFacets,
  type ModelVocabulary,
  type IdsModelReport,
  type IdsSpecificationResultView,
  type IdsValidationOptions,
  type ModelSummary,
  type PropertySetView,
  type QuantityQuery,
  type QuantityQueryResult,
  type RepresentationContextView,
  type SiteLocationView,
  type SpatialNodeView,
  type StepExportOptions,
  type StepExportResult,
  type Vec3,
  type VocabularyOptions,
} from "./types";
import {
  asFiniteNumber,
  compileQuantityExpression,
  findSetValue,
  matchesPropertyCondition,
} from "./quantity-query";

type LoadedModel = {
  summary: ModelSummary;
  store: IfcDataStore;
  view: MutablePropertyView;
  editor: StoreEditor;
  /** Staged georeferencing edits, applied at export time. */
  georefPatch: GeoreferencePatch | null;
};

const models = new Map<ModelId, LoadedModel>();

let nextModelSeq = 0;

function mint(name: string): ModelId {
  nextModelSeq += 1;
  // Deterministic and readable in logs; uniqueness only has to hold per session.
  return `m${nextModelSeq}:${name}`;
}

function must(modelId: ModelId): LoadedModel {
  const model = models.get(modelId);
  if (!model) throw new UnknownModelError(modelId);
  return model;
}

// ---------------------------------------------------------------------------
// Attribute helpers
// ---------------------------------------------------------------------------

/**
 * Positional index of a named attribute for an IFC class, resolved across the
 * bundled schema union so IFC4X3 infrastructure classes work too. Returns -1
 * when the class does not declare the attribute.
 */
function attributeIndex(type: string, attribute: string): number {
  return getAttributeNamesAcrossSchemas(normalizeIfcTypeName(type)).indexOf(
    attribute,
  );
}

/**
 * `entityIndex.byType` is keyed by the raw STEP token (`IFCWALL`), while the
 * app speaks canonical EXPRESS PascalCase (`IfcWall`). Callers may pass either,
 * so canonicalize first — that resolves aliases and IFC4X3 classes — then
 * upper-case to hit the index.
 */
function typeKey(type: string): string {
  return normalizeIfcTypeName(type).toUpperCase();
}

/** Unwrap the STEP value shapes into a plain number, or null. */
function toNumber(value: IfcAttributeValue | undefined): number | null {
  if (typeof value === "number") return value;
  if (value && typeof value === "object") {
    if ("real" in value) return value.real;
    if ("typed" in value && typeof value.typed.value === "number") {
      return value.typed.value;
    }
  }
  return null;
}

/**
 * IFC stores latitude and longitude as `IfcCompoundPlaneAngleMeasure`: a list of
 * [degrees, minutes, seconds] plus an optional millionths-of-a-second element.
 * All components carry the sign of the whole angle, so a naive sum of absolute
 * values would put southern-hemisphere sites in the wrong place.
 */
function compoundAngleToDegrees(
  value: IfcAttributeValue | undefined,
): number | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.map(toNumber);
  if (parts.length < 3 || parts.some((p) => p === null)) return undefined;

  const [degrees, minutes, seconds, millionths = 0] = parts as number[];
  const magnitude =
    Math.abs(degrees) +
    Math.abs(minutes) / 60 +
    Math.abs(seconds) / 3600 +
    Math.abs(millionths) / 3_600_000_000;

  // The sign lives on the first non-zero component.
  const sign =
    [degrees, minutes, seconds, millionths].find((p) => p !== 0) ?? 0;
  return sign < 0 ? -magnitude : magnitude;
}

/** `IfcSite.RefLatitude` / `RefLongitude` / `RefElevation`, if there is a site. */
function readSiteLocation(store: IfcDataStore): SiteLocationView | undefined {
  const siteIds = store.entityIndex.byType.get(typeKey("IfcSite"));
  if (!siteIds?.length) return undefined;

  const site = store.getEntity(siteIds[0]);
  if (!site) return undefined;

  const latIndex = attributeIndex(site.type, "RefLatitude");
  const lonIndex = attributeIndex(site.type, "RefLongitude");
  const elevIndex = attributeIndex(site.type, "RefElevation");

  const location: SiteLocationView = {
    latitude:
      latIndex >= 0 ? compoundAngleToDegrees(site.attributes[latIndex]) : undefined,
    longitude:
      lonIndex >= 0 ? compoundAngleToDegrees(site.attributes[lonIndex]) : undefined,
    elevation:
      elevIndex >= 0 ? (toNumber(site.attributes[elevIndex]) ?? undefined) : undefined,
  };

  const hasAny =
    location.latitude !== undefined ||
    location.longitude !== undefined ||
    location.elevation !== undefined;
  return hasAny ? location : undefined;
}

/**
 * `IfcGeometricRepresentationContext` for the `Model` context.
 *
 * `TrueNorth` is an `IfcDirection` of two or three ratios, *not* an angle: it
 * points at true north expressed in the model's own axes. The bearing is
 * therefore measured from the model's +Y (project north), clockwise, which is
 * `atan2(x, y)` rather than the usual `atan2(y, x)`.
 */
function readRepresentationContext(
  store: IfcDataStore,
): RepresentationContextView | undefined {
  const ids = store.entityIndex.byType.get(
    typeKey("IfcGeometricRepresentationContext"),
  );
  if (!ids?.length) return undefined;

  // A file can declare several contexts (Model, Plan, …); georeferencing hangs
  // off the Model one, which is also what IfcMapConversion.SourceCRS points at.
  let chosen = store.getEntity(ids[0]);
  for (const id of ids) {
    const candidate = store.getEntity(id);
    if (!candidate) continue;
    const typeIndex = attributeIndex(candidate.type, "ContextType");
    const contextType = candidate.attributes[typeIndex];
    if (typeof contextType === "string" && /model/i.test(contextType)) {
      chosen = candidate;
      break;
    }
  }
  if (!chosen) return undefined;

  const view: RepresentationContextView = { expressId: chosen.expressId };

  const precisionIndex = attributeIndex(chosen.type, "Precision");
  if (precisionIndex >= 0) {
    view.precision = toNumber(chosen.attributes[precisionIndex]) ?? undefined;
  }

  const wcsIndex = attributeIndex(chosen.type, "WorldCoordinateSystem");
  const wcs = readPlacementLocation(store, chosen.attributes[wcsIndex]);
  if (wcs) view.worldCoordinateSystem = wcs;

  const trueNorthIndex = attributeIndex(chosen.type, "TrueNorth");
  const direction = readDirectionRatios(store, chosen.attributes[trueNorthIndex]);
  if (direction && direction.length >= 2) {
    const [x, y] = direction;
    view.trueNorth = [x, y];
    // Bearing from the model's +Y, clockwise — the convention IFC uses.
    view.trueNorthDegrees = normalizeDegrees((Math.atan2(x, y) * 180) / Math.PI);
  }

  return view;
}

/** Resolve `#id` → `IfcAxis2Placement3D.Location` → its coordinates. */
function readPlacementLocation(
  store: IfcDataStore,
  reference: IfcAttributeValue | undefined,
): Vec3 | undefined {
  const placement = resolveReference(store, reference);
  if (!placement) return undefined;

  const locationIndex = attributeIndex(placement.type, "Location");
  const point = resolveReference(store, placement.attributes[locationIndex]);
  if (!point) return undefined;

  const coordsIndex = attributeIndex(point.type, "Coordinates");
  const coordinates = point.attributes[coordsIndex];
  if (!Array.isArray(coordinates)) return undefined;

  const values = coordinates.map(toNumber);
  if (values.length < 2 || values.slice(0, 2).some((v) => v === null)) {
    return undefined;
  }
  return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0] as Vec3;
}

/** Resolve `#id` → `IfcDirection.DirectionRatios`. */
function readDirectionRatios(
  store: IfcDataStore,
  reference: IfcAttributeValue | undefined,
): number[] | undefined {
  const direction = resolveReference(store, reference);
  if (!direction) return undefined;

  const ratiosIndex = attributeIndex(direction.type, "DirectionRatios");
  const ratios = direction.attributes[ratiosIndex];
  if (!Array.isArray(ratios)) return undefined;

  const values = ratios.map(toNumber);
  return values.some((v) => v === null) ? undefined : (values as number[]);
}

/**
 * Resolve a STEP entity reference.
 *
 * The columnar parser hands references back as **plain numbers** (`13`), not as
 * the `"#13"` text they appear as in the file. Both are accepted because the
 * string form is what the STEP writer and the mutation overlay produce, and a
 * reader that handles only one silently returns nothing for the other — which
 * looks like "the file has no TrueNorth" rather than like a bug.
 *
 * Only called in attribute slots that are declared as references, so treating a
 * bare number as an express id is unambiguous here.
 */
function resolveReference(
  store: IfcDataStore,
  reference: IfcAttributeValue | undefined,
) {
  if (typeof reference === "number") return store.getEntity(reference);
  if (typeof reference !== "string") return null;

  const match = /^#(\d+)$/.exec(reference.trim());
  if (!match) return null;
  return store.getEntity(Number(match[1]));
}

function normalizeDegrees(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** The engine speaks `{x, y, z}`; the adapter speaks tuples, which are cheaper
 *  to transfer across the worker boundary and are what three.js wants. */
function toVec3(v: IfcLiteVec3): Vec3 {
  return [v.x, v.y, v.z];
}

/**
 * Resolve every origin shift applied by the geometry pipeline into the one
 * render-frame translation used by the rest of the application.
 *
 * The WASM pre-pass subtracts its RTC offset while coordinates are still IFC
 * Z-up. `CoordinateHandler.originShift`, when present, is a later shift of the
 * already Y-up render meshes. Older code kept only the latter, which is
 * normally zero on the WASM path and therefore lost the large E/N offset that
 * Cesium and federation need to put the model back on the map.
 */
export function resolveRenderOriginShift(info: {
  originShift: IfcLiteVec3;
  wasmRtcOffset?: IfcLiteVec3;
}): Vec3 {
  const renderShift = toVec3(info.originShift);
  const rtc = info.wasmRtcOffset;
  if (!rtc) return renderShift;

  // IFC (x, y, z) -> render (x, z, -y).
  return [
    renderShift[0] + rtc.x,
    renderShift[1] + rtc.z,
    renderShift[2] - rtc.y,
  ];
}

function toAabb(box: IfcLiteAabb): Aabb {
  return { min: toVec3(box.min), max: toVec3(box.max) };
}

function toSpatialNodeView(node: SpatialNode): SpatialNodeView {
  return {
    expressId: node.expressId,
    // `type` is an enum ordinal in the engine's tree; the adapter speaks names.
    type: IfcTypeEnum[node.type] ?? String(node.type),
    name: node.longName ? `${node.name} — ${node.longName}` : node.name,
    elevation: node.elevation,
    children: node.children.map(toSpatialNodeView),
    elementIds: node.elements,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const ifcLiteAdapter: IfcEngineAdapter = {
  engineId: "ifc-lite",

  async loadModel(
    input: LoadModelInput,
    options: LoadModelOptions = {},
  ): Promise<ModelSummary> {
    const parser = new IfcParser();
    const startedAt = performance.now();

    const store = await parser.parseColumnar(input.bytes, {
      onProgress: options.onProgress,
      onSpatialReady: options.onSpatialReady
        ? () => options.onSpatialReady?.()
        : undefined,
    });

    if (options.signal?.aborted) {
      throw new DOMException("Model load aborted", "AbortError");
    }

    const view = new MutablePropertyView(store.properties ?? null, input.name);
    const editor = new StoreEditor(store, view);

    const summary: ModelSummary = {
      id: mint(input.name),
      name: input.name,
      schema: store.schemaVersion as IfcSchemaVersion,
      schemaToken: store.sourceHeader?.schemaIdentifiers?.[0],
      entityCount: store.entityCount,
      byteLength: input.bytes.byteLength,
      parseTimeMs: Math.round(performance.now() - startedAt),
      lengthUnitScale: store.lengthUnitScale ?? 1,
    };

    models.set(summary.id, { summary, store, view, editor, georefPatch: null });
    return summary;
  },

  async unloadModel(modelId: ModelId): Promise<void> {
    models.delete(modelId);
  },

  async getEntities(
    modelId: ModelId,
    query: EntityQuery = {},
  ): Promise<EntitySummary[]> {
    const { store } = must(modelId);

    const ids: number[] = [];
    if (query.types?.length) {
      for (const type of query.types) {
        const byType = store.entityIndex.byType.get(typeKey(type));
        if (byType) ids.push(...byType);
      }
      ids.sort((a, b) => a - b);
    } else {
      for (const typeIds of store.entityIndex.byType.values()) {
        ids.push(...typeIds);
      }
      ids.sort((a, b) => a - b);
    }

    const offset = query.offset ?? 0;
    const page = query.limit === undefined ? ids.slice(offset) : ids.slice(offset, offset + query.limit);

    return page.map((expressId) => {
      const entity = store.getEntity(expressId);
      const attributes = extractEntityAttributesOnDemand(store, expressId);
      return {
        expressId,
        type: entity ? normalizeIfcTypeName(entity.type) : "",
        globalId: attributes.globalId,
        name: attributes.name,
        description: attributes.description,
        objectType: attributes.objectType,
        tag: attributes.tag,
      };
    });
  },

  async getEntity(
    modelId: ModelId,
    expressId: number,
  ): Promise<EntitySummary | null> {
    const { store } = must(modelId);
    const entity = store.getEntity(expressId);
    if (!entity) return null;

    const attributes = extractEntityAttributesOnDemand(store, expressId);
    return {
      expressId,
      type: normalizeIfcTypeName(entity.type),
      globalId: attributes.globalId,
      name: attributes.name,
      description: attributes.description,
      objectType: attributes.objectType,
      tag: attributes.tag,
    };
  },

  async getEntityTypes(
    modelId: ModelId,
  ): Promise<Array<{ type: string; count: number }>> {
    const { store } = must(modelId);
    const out: Array<{ type: string; count: number }> = [];
    for (const [type, ids] of store.entityIndex.byType) {
      out.push({ type: normalizeIfcTypeName(type), count: ids.length });
    }
    out.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
    return out;
  },

  async getVocabulary(
    modelId: ModelId,
    options: VocabularyOptions = {},
  ): Promise<ModelVocabulary> {
    const { store } = must(modelId);
    const sampleSize = options.sampleSize ?? 2_000;

    const entityTypes: Array<{ type: string; count: number }> = [];
    for (const [type, ids] of store.entityIndex.byType) {
      entityTypes.push({ type: normalizeIfcTypeName(type), count: ids.length });
    }
    entityTypes.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

    // Property sets and materials are per-entity, so they need a walk. Sample
    // rather than exhaust: the set of *names* converges long before the set of
    // entities does, and this runs while someone is typing.
    const candidates: number[] = [];
    for (const [type, ids] of store.entityIndex.byType) {
      // Only real occurrences carry psets worth listing; geometry and
      // relationship entities never do.
      if (!/^IFC(REL|CARTESIAN|DIRECTION|AXIS|POLYLINE|EXTRUDED|SHAPE|PRODUCTDEF|GEOMETRIC|OWNER|PERSON|ORGANIZATION|APPLICATION|SIUNIT|UNITASSIGNMENT|PROPERTY|QUANTITY)/.test(type)) {
        candidates.push(...ids);
      }
    }
    candidates.sort((a, b) => a - b);

    const stride = Math.max(1, Math.ceil(candidates.length / sampleSize));
    const propertySets = new Map<string, Set<string>>();
    const quantitySets = new Map<string, Set<string>>();
    const materials = new Set<string>();
    const predefinedTypes = new Set<string>();
    const objectTypes = new Set<string>();

    for (let i = 0; i < candidates.length; i += stride) {
      const expressId = candidates[i];

      for (const set of extractPropertiesOnDemand(store, expressId)) {
        const properties = propertySets.get(set.name) ?? new Set<string>();
        for (const property of set.properties) properties.add(property.name);
        propertySets.set(set.name, properties);
      }

      const type = extractTypePropertiesOnDemand(store, expressId);
      for (const set of type?.properties ?? []) {
        const properties = propertySets.get(set.name) ?? new Set<string>();
        for (const property of set.properties) properties.add(property.name);
        propertySets.set(set.name, properties);
      }

      for (const set of extractQuantitiesOnDemand(store, expressId)) {
        const quantities = quantitySets.get(set.name) ?? new Set<string>();
        for (const quantity of set.quantities) quantities.add(quantity.name);
        quantitySets.set(set.name, quantities);
      }

      const attributes = extractEntityAttributesOnDemand(store, expressId);
      if (attributes.objectType?.trim()) objectTypes.add(attributes.objectType.trim());
      const predefinedType = extractAllEntityAttributes(store, expressId).find(
        (attribute) => attribute.name.toLocaleLowerCase() === "predefinedtype",
      )?.value;
      if (predefinedType !== undefined && String(predefinedType).trim()) {
        predefinedTypes.add(String(predefinedType).trim());
      }

      for (const material of extractAllMaterialsOnDemand(store, expressId)) {
        if (material.name) materials.add(material.name);
      }
    }

    return {
      entityTypes,
      propertySets: [...propertySets.entries()]
        .map(([name, properties]) => ({
          name,
          properties: [...properties].sort(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      quantitySets: [...quantitySets.entries()]
        .map(([name, quantities]) => ({
          name,
          quantities: [...quantities].sort(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      predefinedTypes: [...predefinedTypes].sort(),
      objectTypes: [...objectTypes].sort(),
      classificationSystems: extractClassificationSystemsOnDemand(store).sort(),
      materials: [...materials].sort(),
    };
  },

  async getElementInfo(
    modelId: ModelId,
    expressId: number,
  ): Promise<ElementInfo> {
    const { store } = must(modelId);

    const attributes = extractEntityAttributesOnDemand(store, expressId);
    const entity = store.getEntity(expressId);

    const toView = (
      sets: Array<{ name: string; properties: Array<{ name: string; value: unknown }> }>,
    ): PropertySetView[] =>
      sets.map((set) => ({
        name: set.name,
        properties: set.properties.map((property) => ({
          name: property.name,
          value: (property.value ?? null) as PropertyValue,
        })),
      }));

    // Type properties come back as one object with nested sets, or null when
    // the occurrence has no `IfcRelDefinesByType`.
    const type = extractTypePropertiesOnDemand(store, expressId);

    return {
      attributes: entity
        ? {
            expressId,
            type: normalizeIfcTypeName(entity.type),
            globalId: attributes.globalId,
            name: attributes.name,
            description: attributes.description,
            objectType: attributes.objectType,
            tag: attributes.tag,
          }
        : null,

      propertySets: extractPropertiesOnDemand(store, expressId).map((set) => ({
        name: set.name,
        properties: set.properties.map((property) => ({
          name: property.name,
          value: property.value as PropertyValue,
          dataType: property.type !== undefined ? String(property.type) : undefined,
        })),
      })),

      quantities: toView(
        extractQuantitiesOnDemand(store, expressId).map((set) => ({
          name: set.name,
          properties: set.quantities.map((quantity) => ({
            name: quantity.name,
            value: quantity.value,
          })),
        })),
      ),

      typeProperties: type ? toView(type.properties) : [],

      materials: [
        ...new Set(
          extractAllMaterialsOnDemand(store, expressId)
            .map((material) => material.name?.trim())
            .filter((name): name is string => Boolean(name)),
        ),
      ],

      classifications: extractClassificationsOnDemand(store, expressId).map(
        (entry) => ({
          system: entry.system ?? "",
          code: entry.identification ?? "",
          name: entry.name ?? "",
        }),
      ),
    };
  },

  async getFilterFacets(modelId: ModelId): Promise<FilterFacets> {
    const { store } = must(modelId);

    /*
      A full walk, unlike `getVocabulary`'s sample.

      The vocabulary only needs the set of *names*, which converges after a few
      hundred entities. A filter needs membership: hiding "everything made of
      concrete" has to know about every concrete element, and a sampled answer
      would leave some on screen after the user asked for them to go — a wrong
      answer that looks like a rendering bug.
    */
    /*
      Which entities are worth filtering by.

      The first attempt was a blocklist of prefixes — IFCREL, IFCCARTESIAN and
      so on — and it let `IfcLocalPlacement` and `IfcRectangleProfileDef` into
      the class list, because a blocklist only excludes what someone thought to
      name. The principled definition is the one the model already states:
      **things placed in the spatial hierarchy**. That is what "filter this
      building" means, and it needs no maintenance as schemas grow.

      Falls back to every entity when a file has no spatial hierarchy at all,
      because a filter over nothing is worse than a filter over too much.
    */
    const placed = new Set<number>();
    const hierarchy = store.spatialHierarchy;
    if (hierarchy) {
      // Through `toSpatialNodeView`, the same conversion `getSpatialTree`
      // uses. Reading `store.spatialHierarchy` raw was the mistake: its shape
      // is the engine's, not the view's, so the walk silently found nothing
      // and every entity in the file — units, directions, placements — ended
      // up offered as a filter.
      const walk = (node: SpatialNodeView) => {
        // Spaces are spatial nodes themselves, rather than entries in their
        // own `elementIds`. Include the node so IfcSpace appears under Class
        // and can be combined with hierarchy, type, material and group facets.
        if (node.type === "IfcSpace") placed.add(node.expressId);
        for (const id of node.elementIds) placed.add(id);
        for (const child of node.children) walk(child);
      };
      walk(toSpatialNodeView(hierarchy.project));
    }

    const isOccurrence = (expressId: number) =>
      placed.size === 0 || placed.has(expressId);

    const classes = new Map<string, number[]>();
    const types = new Map<string, number[]>();
    const materials = new Map<string, number[]>();
    const groups = new Map<string, number[]>();

    const occurrences: number[] = [];
    for (const [type, ids] of store.entityIndex.byType) {
      const kept = ids.filter((id) => isOccurrence(id));
      if (kept.length === 0) continue;
      classes.set(normalizeIfcTypeName(type), kept);
      occurrences.push(...kept);
    }

    for (const expressId of occurrences) {
      // The occurrence's own type name. `ObjectType` is where IFC puts it when
      // there is no `IfcRelDefinesByType`, and it is what most authoring tools
      // write, so it is the one field that is populated across exporters.
      const attributes = extractEntityAttributesOnDemand(store, expressId);
      const objectType = attributes.objectType?.trim();
      if (objectType) {
        const bucket = types.get(objectType) ?? [];
        bucket.push(expressId);
        types.set(objectType, bucket);
      }

      for (const material of extractAllMaterialsOnDemand(store, expressId)) {
        const name = material.name?.trim();
        if (!name) continue;
        const bucket = materials.get(name) ?? [];
        // A layered wall reports the same material once per layer.
        if (bucket.at(-1) !== expressId) bucket.push(expressId);
        materials.set(name, bucket);
      }
    }

    // Groups are the other way round: the membership lives on the group, not
    // on the element, so these are read per group rather than per occurrence.
    for (const [type, ids] of store.entityIndex.byType) {
      if (!/^IFC(GROUP|ZONE|SYSTEM|BUILDINGSYSTEM|DISTRIBUTIONSYSTEM)$/.test(type)) {
        continue;
      }
      for (const groupId of ids) {
        const attributes = extractEntityAttributesOnDemand(store, groupId);
        const label =
          attributes.name?.trim() ||
          `${normalizeIfcTypeName(type)} #${groupId}`;
        const members = extractGroupMembersOnDemand(store, groupId)
          .map((member) => member.id)
          .filter((id): id is number => typeof id === "number");
        if (members.length === 0) continue;

        const bucket = groups.get(label) ?? [];
        bucket.push(...members);
        groups.set(label, bucket);
      }
    }

    const toFacet = (source: Map<string, number[]>) =>
      [...source.entries()]
        .map(([value, expressIds]) => ({ value, expressIds }))
        .sort(
          (a, b) =>
            b.expressIds.length - a.expressIds.length ||
            a.value.localeCompare(b.value),
        );

    return {
      classes: toFacet(classes),
      types: toFacet(types),
      materials: toFacet(materials),
      groups: toFacet(groups),
    };
  },

  async evaluateQuantityQuery(
    modelId: ModelId,
    query: QuantityQuery,
  ): Promise<QuantityQueryResult> {
    const { store } = must(modelId);

    if (query.sources.length === 0) throw new Error("A quantity query needs at least one result source.");
    const aliases = new Set<string>();
    for (const source of query.sources) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(source.alias)) {
        throw new Error(`Invalid source alias “${source.alias}”.`);
      }
      if (aliases.has(source.alias)) throw new Error(`Duplicate source alias “${source.alias}”.`);
      aliases.add(source.alias);
      if (source.kind !== "count" && (!source.setName?.trim() || !source.valueName?.trim())) {
        throw new Error(`Source “${source.alias}” needs a set and value name.`);
      }
    }

    const formula = query.formula?.trim() ?? "";
    if (!formula && query.sources.length !== 1) {
      throw new Error("Add a formula when the query has more than one result source.");
    }
    for (const identifier of formula.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
      if (!aliases.has(identifier)) throw new Error(`The formula uses unknown source “${identifier}”.`);
    }
    const calculate = formula ? compileQuantityExpression(formula) : null;

    // Query only product occurrences. The spatial hierarchy is the model's
    // own declaration of those occurrences and also includes IfcSpace nodes.
    const placed = new Set<number>();
    if (store.spatialHierarchy) {
      const walk = (node: SpatialNodeView) => {
        if (node.type === "IfcSpace") placed.add(node.expressId);
        for (const id of node.elementIds) placed.add(id);
        for (const child of node.children) walk(child);
      };
      walk(toSpatialNodeView(store.spatialHierarchy.project));
    }

    const normalize = (value: string) => value.trim().toLocaleLowerCase();
    const wanted = (values: string[]) => new Set(values.map(normalize).filter(Boolean));
    const wantedClasses = wanted(query.filters.classes);
    const wantedPredefinedTypes = wanted(query.filters.predefinedTypes);
    const wantedObjectTypes = wanted(query.filters.objectTypes);
    const wantedMaterials = wanted(query.filters.materials);

    const candidateIds: number[] = [];
    for (const [rawType, ids] of store.entityIndex.byType) {
      const type = normalizeIfcTypeName(rawType);
      if (wantedClasses.size > 0 && !wantedClasses.has(normalize(type))) continue;
      for (const id of ids) {
        if (placed.size === 0 || placed.has(id)) candidateIds.push(id);
      }
    }
    candidateIds.sort((a, b) => a - b);

    const rows: QuantityQueryResult["rows"] = [];
    for (const expressId of candidateIds) {
      const entity = store.getEntity(expressId);
      if (!entity) continue;
      const type = normalizeIfcTypeName(entity.type);
      const attributes = extractEntityAttributesOnDemand(store, expressId);
      const predefinedType = String(
        extractAllEntityAttributes(store, expressId).find(
          (attribute) => attribute.name.toLocaleLowerCase() === "predefinedtype",
        )?.value ?? "",
      ).trim();
      const objectType = attributes.objectType?.trim() ?? "";
      if (
        wantedPredefinedTypes.size > 0 &&
        !wantedPredefinedTypes.has(normalize(predefinedType))
      ) continue;
      if (wantedObjectTypes.size > 0 && !wantedObjectTypes.has(normalize(objectType))) continue;

      const materials = [
        ...new Set(
          extractAllMaterialsOnDemand(store, expressId)
            .map((material) => material.name?.trim())
            .filter((name): name is string => Boolean(name)),
        ),
      ];
      if (
        wantedMaterials.size > 0 &&
        !materials.some((material) => wantedMaterials.has(normalize(material)))
      ) continue;

      const toView = (
        sets: Array<{ name: string; properties: Array<{ name: string; value: unknown }> }>,
      ): PropertySetView[] =>
        sets.map((set) => ({
          name: set.name,
          properties: set.properties.map((property) => ({
            name: property.name,
            value: (property.value ?? null) as PropertyValue,
          })),
        }));

      const occurrenceProperties = toView(extractPropertiesOnDemand(store, expressId));
      const inherited = extractTypePropertiesOnDemand(store, expressId);
      const properties = [
        ...occurrenceProperties,
        ...toView(inherited?.properties ?? []),
      ];
      const propertyMatches = query.filters.properties.map((condition) =>
          matchesPropertyCondition(
            findSetValue(properties, condition.setName, condition.propertyName),
            condition.operator,
            condition.value,
          ));
      if (
        query.filters.propertyCombination === "any"
          ? propertyMatches.length > 0 && !propertyMatches.some(Boolean)
          : !propertyMatches.every(Boolean)
      ) continue;

      const quantities = toView(
        extractQuantitiesOnDemand(store, expressId).map((set) => ({
          name: set.name,
          properties: set.quantities,
        })),
      );
      const inputs: Record<string, PropertyValue> = {};
      for (const source of query.sources) {
        if (source.kind === "count") inputs[source.alias] = 1;
        else if (source.kind === "property") {
          inputs[source.alias] =
            findSetValue(properties, source.setName!, source.valueName!) ?? null;
        } else {
          inputs[source.alias] =
            findSetValue(quantities, source.setName!, source.valueName!) ?? null;
        }
      }

      let value: PropertyValue = inputs[query.sources[0].alias] ?? null;
      if (calculate) {
        const variables: Record<string, number> = {};
        let complete = true;
        for (const source of query.sources) {
          const numeric = asFiniteNumber(inputs[source.alias]);
          if (numeric === null) {
            complete = false;
            break;
          }
          variables[source.alias] = numeric;
        }
        if (!complete) value = null;
        else {
          try {
            value = calculate(variables);
          } catch {
            value = null;
          }
        }
      }

      rows.push({
        expressId,
        type,
        globalId: attributes.globalId,
        name: attributes.name,
        predefinedType,
        objectType,
        materials,
        inputs,
        value,
      });
    }

    let total = 0;
    let numericValues = 0;
    let valueCount = 0;
    for (const row of rows) {
      if (row.value !== null && row.value !== "") valueCount += 1;
      const numeric = asFiniteNumber(row.value);
      if (numeric === null) continue;
      total += numeric;
      numericValues += 1;
    }

    return {
      modelId,
      matchedCount: rows.length,
      valueCount,
      missingValueCount: rows.length - valueCount,
      total: numericValues > 0 ? total : null,
      rows,
    };
  },

  async getProperties(
    modelId: ModelId,
    expressId: number,
  ): Promise<PropertySetView[]> {
    const { store } = must(modelId);
    return extractPropertiesOnDemand(store, expressId).map((set) => ({
      name: set.name,
      globalId: set.globalId,
      properties: set.properties.map((property) => ({
        name: property.name,
        value: (property.value ?? null) as PropertySetView["properties"][number]["value"],
        dataType: property.dataType,
        values: property.values,
      })),
    }));
  },

  async getSpatialTree(modelId: ModelId): Promise<SpatialNodeView> {
    const { store } = must(modelId);
    const hierarchy = store.spatialHierarchy;
    if (!hierarchy) {
      // A file with no IfcProject aggregation still needs a root to hang the
      // entity list off, rather than the UI special-casing "no tree".
      return {
        expressId: 0,
        type: "IfcProject",
        name: must(modelId).summary.name,
        children: [],
        elementIds: [],
      };
    }
    return toSpatialNodeView(hierarchy.project);
  },

  async getGeometry(
    modelId: ModelId,
    options: GeometryOptions = {},
  ): Promise<ModelGeometry> {
    const { store } = must(modelId);

    const processor = new GeometryProcessor();
    await processor.init();

    // `withMaterializedAsync` scopes the contiguous copy of the source to this
    // call, so a 200 MB model is not held twice for the life of the session.
    const result = await store.source.withMaterializedAsync((bytes) =>
      processor.process(bytes),
    );

    options.onProgress?.({ phase: "geometry", percent: 100 });

    const info = result.coordinateInfo;
    return {
      meshes: result.meshes
        // geometryClass 2 is an instanced *type template*: its occurrences are
        // emitted separately as class 0. Rendering it too draws every instanced
        // element twice, overlapping.
        .filter((mesh) => (mesh.geometryClass ?? 0) !== 2)
        .map((mesh) => ({
          expressId: mesh.expressId,
          type: mesh.ifcType ? normalizeIfcTypeName(mesh.ifcType) : undefined,
          // Absent means `positions` are already absolute — see MeshView.origin.
          origin: mesh.origin ? ([...mesh.origin] as Vec3) : ([0, 0, 0] as Vec3),
          positions: mesh.positions,
          normals: mesh.normals,
          indices: mesh.indices,
          color: mesh.color,
        })),
      coordinates: {
        originShift: resolveRenderOriginShift(info),
        originalBounds: toAabb(info.originalBounds),
        shiftedBounds: toAabb(info.shiftedBounds),
        hasLargeCoordinates:
          info.hasLargeCoordinates || info.wasmRtcOffset !== undefined,
        buildingRotation: info.buildingRotation,
        lengthUnitScale: info.lengthUnitScale,
      },
      totalTriangles: result.totalTriangles,
      totalVertices: result.totalVertices,
    };
  },

  async setEntityAttribute(
    modelId: ModelId,
    expressId: number,
    attribute: EditableAttribute,
    value: string,
  ): Promise<void> {
    const { editor } = must(modelId);
    editor.setAttribute(expressId, attribute, value);
  },

  /**
   * Validate against an IDS document parsed by `lib/ifc/ids-document.ts`.
   *
   * The engine's `createDataAccessor` bridge does the real work — it is the
   * same projection their buildingSMART corpus harness runs against, which is a
   * much stronger guarantee than anything we would write here. This method is a
   * translation layer: engine report in, our vendor-neutral report out, with
   * none of the engine's types escaping.
   *
   * The document arrives already parsed because this runs in a Worker, which
   * has no `DOMParser`. See `ids-document.ts`.
   */
  async validateIds(
    modelId: ModelId,
    document: EngineIdsDocument,
    options: IdsValidationOptions = {},
  ): Promise<IdsModelReport> {
    const model = must(modelId);
    const document_ = document as unknown as IDSDocument;

    const report = await validateIDS(
      document_,
      createDataAccessor(model.store),
      {
        modelId,
        // The exact FILE_SCHEMA token when the file carried one: the engine
        // scopes some facet semantics (the IFC2X3 occurrence/type mapping) by
        // schema, so `IFC4X3_ADD2` is worth more here than `IFC4X3`.
        schemaVersion: model.summary.schemaToken ?? model.summary.schema,
        entityCount: model.summary.entityCount,
      },
      {
        // Off by default. A large model against a large IDS produces millions
        // of passing rows that nothing renders, and holding them all is what
        // makes a validation run out of memory rather than merely take a while.
        includePassingEntities: options.includePassingEntities ?? false,
        onProgress: options.onProgress
          ? (progress) =>
              options.onProgress!({
                phase: progress.phase,
                specificationIndex: progress.specificationIndex,
                totalSpecifications: progress.totalSpecifications,
                percent: progress.percentage,
              })
          : undefined,
      },
    );

    const specifications: IdsSpecificationResultView[] =
      report.specificationResults.map((result, index) => ({
        index,
        name: result.specification.name,
        description: result.specification.description,
        status: result.status,
        applicableCount: result.applicableCount,
        passedCount: result.passedCount,
        failedCount: result.failedCount,
        passRate: result.passRate,
        cardinality: result.cardinalityResult
          ? {
              passed: result.cardinalityResult.passed,
              actualCount: result.cardinalityResult.actualCount,
              message: result.cardinalityResult.message,
            }
          : undefined,
        entities: result.entityResults.map((entity) => ({
          expressId: entity.expressId,
          type: entity.entityType,
          name: entity.entityName,
          globalId: entity.globalId,
          passed: entity.passed,
          requirements: entity.requirementResults.map((requirement) => ({
            status: requirement.status,
            facetType: requirement.facetType,
            description: requirement.checkedDescription,
            failureReason: requirement.failureReason,
            field: requirement.failure?.field,
            actual: requirement.failure?.actual ?? requirement.actualValue,
            expected: requirement.failure?.expected ?? requirement.expectedValue,
          })),
        })),
      }));

    return {
      modelId,
      schemaVersion: report.modelInfo.schemaVersion,
      entityCount: report.modelInfo.entityCount,
      specifications,
    };
  },

  async getGeoreferencing(modelId: ModelId): Promise<GeoreferenceView> {
    const { store } = must(modelId);
    const info = extractGeoreferencingOnDemand(store);
    const site = readSiteLocation(store);
    const context = readRepresentationContext(store);
    const lengthUnitScale = store.lengthUnitScale ?? 1;

    if (!info?.hasGeoreference) {
      return {
        // A WorldCoordinateSystem offset or a TrueNorth is georeferencing of a
        // sort (LoGeoRef 20/30); reporting "none" would hide it from the grader.
        hasGeoreference: Boolean(site),
        source: site ? "siteLocation" : undefined,
        site,
        context,
        lengthUnitScale,
      };
    }

    return {
      hasGeoreference: true,
      source: info.source,
      site,
      context,
      lengthUnitScale,
      mapConversion: info.mapConversion
        ? {
            eastings: info.mapConversion.eastings,
            northings: info.mapConversion.northings,
            orthogonalHeight: info.mapConversion.orthogonalHeight,
            xAxisAbscissa: info.mapConversion.xAxisAbscissa,
            xAxisOrdinate: info.mapConversion.xAxisOrdinate,
            scale: info.mapConversion.scale,
          }
        : undefined,
      projectedCRS: info.projectedCRS
        ? {
            name: info.projectedCRS.name,
            description: info.projectedCRS.description,
            geodeticDatum: info.projectedCRS.geodeticDatum,
            verticalDatum: info.projectedCRS.verticalDatum,
            mapProjection: info.projectedCRS.mapProjection,
            mapZone: info.projectedCRS.mapZone,
            mapUnit: info.projectedCRS.mapUnit,
          }
        : undefined,
      angleToGridNorth:
        computeAngleToGridNorth(
          info.mapConversion?.xAxisAbscissa,
          info.mapConversion?.xAxisOrdinate,
        ) ?? undefined,
    };
  },

  async setGeoreferencing(
    modelId: ModelId,
    patch: GeoreferencePatch,
  ): Promise<void> {
    const model = must(modelId);
    // Merged rather than replaced: the georef panel edits the CRS and the map
    // conversion in separate steps.
    model.georefPatch = {
      mapConversion: {
        ...model.georefPatch?.mapConversion,
        ...patch.mapConversion,
      },
      projectedCRS: {
        ...model.georefPatch?.projectedCRS,
        ...patch.projectedCRS,
      },
    };
  },

  async exportStep(
    modelId: ModelId,
    options: StepExportOptions = {},
  ): Promise<StepExportResult> {
    const { store, view, summary, georefPatch } = must(modelId);
    const exporter = new StepExporter(store, view);

    const patch = options.georeference ?? georefPatch;

    const result = await exporter.exportAsync({
      schema: (options.schema ?? summary.schema) as
        | "IFC2X3"
        | "IFC4"
        | "IFC4X3"
        | "IFC5",
      filename: options.filename ?? summary.name,
      author: options.author,
      organization: options.organization,
      application: "DiCE-IFC",
      georefMutations: patch
        ? {
            mapConversion: patch.mapConversion,
            projectedCRS: patch.projectedCRS,
          }
        : undefined,
    });

    return {
      content: result.content,
      entityCount: result.stats.entityCount,
      byteLength: result.stats.fileSize,
      warnings: result.stats.warnings,
    };
  },
};

/** Drops every loaded model. Used by tests and by "close all" in the viewer. */
export function resetIfcLiteAdapter(): void {
  models.clear();
  nextModelSeq = 0;
}
