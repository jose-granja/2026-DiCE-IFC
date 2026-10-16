/**
 * The adapter's own vocabulary.
 *
 * Nothing in this file references `@ifc-lite/*` (or any other engine). That is
 * the whole point: modules speak these types, an engine implementation
 * translates. When a module needs something the engine happens to expose but
 * this file does not, add it here first — never by importing the engine.
 */

export type IfcSchemaVersion = "IFC2X3" | "IFC4" | "IFC4X3" | "IFC5";

/** Opaque per-session model identifier minted by the adapter on load. */
import type { EngineIdsDocument } from "./ids-document";

export type ModelId = string;

/** An entity's identity within a model. Stable for the life of the session. */
export type ExpressId = number;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export type LoadModelInput = {
  /** Display name, normally the file name. Never sent anywhere. */
  name: string;
  /** The file bytes, exactly as read from disk. */
  bytes: ArrayBuffer;
};

export type LoadProgress = {
  phase: string;
  /** 0–100. */
  percent: number;
};

export type LoadModelOptions = {
  onProgress?: (progress: LoadProgress) => void;
  /**
   * Called as soon as the spatial hierarchy is available, before property
   * parsing finishes, so the tree panel can render early.
   */
  onSpatialReady?: () => void;
  signal?: AbortSignal;
};

export type ModelSummary = {
  id: ModelId;
  name: string;
  schema: IfcSchemaVersion;
  /** The exact `FILE_SCHEMA` token, e.g. `IFC4X3_ADD2`, when the file had one. */
  schemaToken?: string;
  entityCount: number;
  byteLength: number;
  /** Milliseconds spent parsing. Used by the engine spike. */
  parseTimeMs: number;
  /** Project-level length unit scale to base SI metres (1 for m, 0.001 for mm). */
  lengthUnitScale: number;
};

// ---------------------------------------------------------------------------
// Entities and properties
// ---------------------------------------------------------------------------

export type EntityQuery = {
  /**
   * IFC class names, e.g. `["IfcWall", "IfcSlab"]`. Matched exactly, without
   * subtype expansion — ask for the subtypes you want.
   */
  types?: string[];
  /**
   * Fetch exactly these express ids, in the given order, ignoring `types`.
   * For a caller that already knows which entities it wants (a spatial
   * node's own element list) rather than which class — asking by type would
   * return every instance of it in the model, not just the ones in scope.
   */
  expressIds?: number[];
  /** Cap the number of results. Omit for all of them. */
  limit?: number;
  /** Skip this many results; use with `limit` to page a virtualised table. */
  offset?: number;
};

export type EntitySummary = {
  expressId: ExpressId;
  type: string;
  globalId: string;
  name: string;
  description: string;
  objectType: string;
  tag: string;
};

export type PropertyValue = string | number | boolean | null;

export type PropertyView = {
  name: string;
  value: PropertyValue;
  /** IFC measure type when the engine knows it, e.g. `IfcLabel`. */
  dataType?: string;
  /**
   * Display unit symbol (e.g. `m`, `m²`, `kg`), resolved from the project's own
   * declared `IfcUnitAssignment` when `dataType` is a measure type that carries
   * one. Absent for non-measure types (`IfcLabel`, `IfcBoolean`, …) and for
   * dimensionless measures (`IfcCountMeasure`, `IfcRatioMeasure`).
   */
  unit?: string;
  /**
   * Candidate values for enumerated / bounded / list / table properties. An IDS
   * property facet passes when any candidate matches.
   */
  values?: string[];
};

export type PropertySetView = {
  name: string;
  globalId?: string;
  properties: PropertyView[];
};

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export type Vec3 = [number, number, number];

/** Axis-aligned bounding box in the model's own coordinates. */
export type Aabb = { min: Vec3; max: Vec3 };

export type MeshView = {
  expressId: ExpressId;
  /** IFC class, when the engine attaches it to the mesh. */
  type?: string;
  /**
   * Per-element frame origin, in render-space metres.
   *
   * **World position of vertex `i` is `origin + positions[3i..3i+3]`.** The
   * engine keeps `positions` element-local so building-scale coordinates stay
   * within float32 precision; a renderer that ignores this draws every element
   * stacked at the origin. Apply it as a per-mesh translation, not per-vertex.
   */
  origin: Vec3;
  /** Interleaved xyz, three floats per vertex, relative to `origin`. */
  positions: Float32Array;
  normals: Float32Array;
  /**
   * Triangle indices. **Winding order is unreliable** — meshes are
   * double-sided by design, so never use winding for face culling or
   * normal direction. Render with `side: DoubleSide`.
   */
  indices: Uint32Array;
  /** Linear RGBA in 0–1, from IfcSurfaceStyleRendering when authored. */
  color: [number, number, number, number];
};

/**
 * Where a model's geometry sits, and what had to be done to make it renderable.
 *
 * Large real-world coordinates (a projected CRS puts a building at
 * e.g. E −40 000, N 180 000) exceed float32 precision, so the engine shifts
 * geometry to a local origin. Federation has to undo that consistently across
 * models or they will not line up — see `lib/viewer/federation.ts`.
 */
export type CoordinateInfo = {
  /**
   * Total translation the engine applied to bring the model near the origin,
   * expressed in render coordinates (Y-up metres). This includes both the
   * IFC-frame WASM RTC shift and any later render-frame shift.
   */
  originShift: Vec3;
  /** Bounds before the shift, i.e. in the file's own coordinates. */
  originalBounds: Aabb;
  /** Bounds after the shift, i.e. what the renderer sees. */
  shiftedBounds: Aabb;
  /**
   * True when the shift was needed. **Not** the same as being georeferenced:
   * a model can have large coordinates and no `IfcMapConversion` at all.
   */
  hasLargeCoordinates: boolean;
  /** Rotation of the building's principal axes, radians, from IfcSite. */
  buildingRotation?: number;
  /** File length units → metres (1 for m, 0.001 for mm). */
  lengthUnitScale?: number;
};

export type ModelGeometry = {
  meshes: MeshView[];
  coordinates: CoordinateInfo;
  totalTriangles: number;
  totalVertices: number;
};

export type GeometryOptions = {
  onProgress?: (progress: LoadProgress) => void;
};

// ---------------------------------------------------------------------------
// Model vocabulary
// ---------------------------------------------------------------------------

/**
 * What a model actually contains, for autocompleting IDS facets.
 *
 * The point of this is that an author writes specifications against the terms
 * their models really use — `Pset_WallCommon` spelled exactly, the
 * classification systems already applied — rather than from memory or from a
 * PDF. Typos in a property name are the single most common reason an IDS
 * reports everything as failing.
 */
export type ModelVocabulary = {
  /** IFC classes present, most frequent first. */
  entityTypes: Array<{ type: string; count: number }>;
  /** Property sets, each with the property names found in them. */
  propertySets: Array<{ name: string; properties: string[] }>;
  /** Quantity sets, each with the quantities found in them. */
  quantitySets: Array<{ name: string; quantities: string[] }>;
  /** Occurrence `PredefinedType` values authored in the model. */
  predefinedTypes: string[];
  /** Occurrence `ObjectType` values authored in the model. */
  objectTypes: string[];
  /**
   * Classification systems referenced by the model. Exact: read from the
   * `IfcClassification` entities themselves, not from the sample below.
   */
  classificationSystems: string[];
  /**
   * Codes found on the sampled elements, grouped by the system they belong to.
   * A hint for a filter field, like the sets above — a model may use codes the
   * sample did not reach.
   */
  classificationCodes: Array<{ system: string; codes: string[] }>;
  /** Material names assigned anywhere in the model. */
  materials: string[];
};

/**
 * One value a model can be filtered by, with the elements that carry it.
 *
 * The ids are the point. A name alone lets the UI draw a checkbox; only
 * membership lets it hide anything, and computing membership per click would
 * mean walking the model on every keystroke.
 */
export type FilterFacetValue = {
  value: string;
  expressIds: ExpressId[];
};

/**
 * Everything the viewer can filter by, resolved in one pass.
 *
 * Five dimensions, because they answer different questions: *where* something
 * is (hierarchy), *what kind* of thing it is (class), *which* of that kind
 * (type), *what it is made of* (material), and *what it belongs to* (group).
 *
 * `hierarchy` is absent here — the spatial tree already carries it, and
 * duplicating it would let the two disagree.
 */
/**
 * What a lens colours by (`lib/lens/`): one value per element, each distinct
 * value its own colour. `model` is not here — it needs no worker, every
 * element of a model has that model's name.
 */
export type ElementGroupSource =
  | { kind: "class" }
  | { kind: "objectType" }
  | { kind: "predefinedType" }
  | { kind: "material" }
  | { kind: "group" }
  | { kind: "storey" }
  /** Codes of one system, or of every system when `system` is empty. */
  | { kind: "classification"; system?: string }
  | { kind: "property"; setName: string; propertyName: string };

export type FilterFacets = {
  /** IFC class, e.g. `IfcWall`. */
  classes: FilterFacetValue[];
  /**
   * The occurrence's type, from `IfcRelDefinesByType` or its `ObjectType`.
   *
   * Distinct from class: every `IfcWall` shares a class, and a type is the
   * particular wall build-up the model author defined once and reused.
   */
  types: FilterFacetValue[];
  materials: FilterFacetValue[];
  /** `IfcGroup`, `IfcZone` and `IfcSystem` membership. */
  groups: FilterFacetValue[];
};

// ---------------------------------------------------------------------------
// Quantity queries
// ---------------------------------------------------------------------------

export type QuantityQueryOperator =
  | "equals"
  | "notEquals"
  | "contains"
  | "greaterThan"
  | "greaterOrEqual"
  | "lessThan"
  | "lessOrEqual"
  | "exists";

export type QuantityQueryPropertyCondition = {
  setName: string;
  propertyName: string;
  operator: QuantityQueryOperator;
  /** Not used by `exists`. Kept as text so TRUE/FALSE and numbers survive input. */
  value: string;
};

/**
 * Which elements to pick, by what they are made of and called. Used by clash
 * detection groups. Every populated field must match; values inside one field
 * are alternatives (fixed text, `*` wildcards or `/regex/`, see `text-match.ts`).
 */
export type ElementFilter = {
  classes: string[];
  /** The element's `Name` attribute. */
  names: string[];
  predefinedTypes: string[];
  objectTypes: string[];
  materials: string[];
  /** `IfcMaterial.Category`. */
  materialCategories: string[];
  /**
   * `IfcClassification.Name` — one system, which the codes below are read in.
   * Absent in filters saved before it existed.
   */
  classificationSystem?: string;
  /**
   * `IfcClassificationReference.Identification` values; any of them matches.
   * Both halves must hold on the *same* reference — see `classification-filter.ts`.
   */
  classificationCodes?: string[];
  propertyCombination?: "all" | "any";
  properties: QuantityQueryPropertyCondition[];
};

export const EMPTY_ELEMENT_FILTER: ElementFilter = {
  classes: [],
  names: [],
  predefinedTypes: [],
  objectTypes: [],
  materials: [],
  materialCategories: [],
  properties: [],
};

/** An element an `ElementFilter` selected. */
export type ElementMatch = {
  expressId: ExpressId;
  type: string;
  globalId: string;
  name: string;
};

export type QuantityQueryFilters = {
  /** Values inside one field are ORed; populated fields are ANDed together. */
  classes: string[];
  predefinedTypes: string[];
  objectTypes: string[];
  materials: string[];
  /** `IfcMaterial.Category`. Absent in queries saved before it existed. */
  materialCategories?: string[];
  /**
   * `IfcClassification.Name` — one system, which the codes below are read in.
   * Absent in queries saved before it existed.
   */
  classificationSystem?: string;
  /**
   * `IfcClassificationReference.Identification` values; any of them matches.
   * Both halves must hold on the *same* reference — see `classification-filter.ts`.
   */
  classificationCodes?: string[];
  /** Property conditions use AND by default; imported tables may list alternatives. */
  propertyCombination?: "all" | "any";
  properties: QuantityQueryPropertyCondition[];
};

export type QuantityQuerySource = {
  id: string;
  /** Identifier used by the formula, e.g. `area` in `area * rate`. */
  alias: string;
  kind: "count" | "property" | "quantity";
  setName?: string;
  valueName?: string;
};

export type QuantityQuery = {
  filters: QuantityQueryFilters;
  sources: QuantityQuerySource[];
  /** Optional when there is exactly one source. Supports +, -, *, /, ^ and parentheses. */
  formula?: string;
  /** Display/export label. Values are not converted automatically. */
  unit?: string;
};

export type QuantityQueryRow = {
  expressId: ExpressId;
  type: string;
  globalId: string;
  name: string;
  predefinedType: string;
  objectType: string;
  materials: string[];
  inputs: Record<string, PropertyValue>;
  value: PropertyValue;
};

export type QuantityQueryResult = {
  modelId: ModelId;
  matchedCount: number;
  valueCount: number;
  missingValueCount: number;
  /** Sum of numeric row results. Null when no row has a numeric result. */
  total: number | null;
  rows: QuantityQueryRow[];
};

/**
 * A base `IfcMaterial` an element is made of — resolved past any
 * `IfcMaterialLayerSet` / `*ProfileSet` / `*ConstituentSet` / `*List` wrapper
 * down to the leaf material entity, so `expressId` names something
 * `getMaterialInfo` can actually open.
 */
export type MaterialRef = {
  expressId: ExpressId;
  name: string;
  /** `IfcMaterial.Category` (IFC4+), when the file declares one. */
  category?: string;
};

/**
 * Everything worth showing about one element.
 *
 * `getProperties` returns only `IfcPropertySet`s. An element's story is wider
 * than that: what it is made of, what it is classified as, how much of it there
 * is, and what its *type* defines for every occurrence of it. A panel that
 * shows only property sets leaves the reader to guess whether the rest is
 * absent from the model or merely absent from the panel.
 */
export type ElementInfo = {
  attributes: EntitySummary | null;
  propertySets: PropertySetView[];
  /** `IfcElementQuantity` — areas, volumes, lengths, counts. */
  quantities: PropertySetView[];
  /** Property sets inherited from the element's type, not its occurrence. */
  typeProperties: PropertySetView[];
  materials: MaterialRef[];
  classifications: Array<{ system: string; code: string; name: string }>;
};

/**
 * A material entity's own record — `IfcMaterial` is not an `IfcRoot` subtype
 * (no `GlobalId`), and its property sets are reached through
 * `IfcMaterialProperties`, not `IfcRelDefinesByProperties`, so this is a
 * separate read from `getElementInfo` rather than a special case of it.
 */
export type MaterialDetailView = {
  expressId: ExpressId;
  name: string;
  /** IFC class of the material entity, e.g. `IfcMaterial`. */
  type: string;
  description?: string;
  category?: string;
  propertySets: PropertySetView[];
};

export type VocabularyOptions = {
  /**
   * How many entities to sample when collecting property sets and materials.
   * Reading every entity of a 300 000-element model to list its Psets would
   * take seconds for a list that stops changing after the first few hundred.
   */
  sampleSize?: number;
};

// ---------------------------------------------------------------------------
// Spatial structure
// ---------------------------------------------------------------------------

export type SpatialNodeView = {
  expressId: ExpressId;
  type: string;
  name: string;
  /** Storey elevation in project length units, when the node is a storey. */
  elevation?: number;
  children: SpatialNodeView[];
  /**
   * Elements contained in this node. Kept out of `children` so the tree can be
   * rendered lazily: a storey with 40 000 elements should not force them all
   * into memory as nodes.
   */
  elementIds: ExpressId[];
};

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/**
 * The IfcRoot-family attributes the adapter can edit by name. Deliberately
 * narrow — georeferencing has its own typed path, and arbitrary positional
 * STEP edits are not something a UI should be doing.
 */
export type EditableAttribute =
  | "Name"
  | "Description"
  | "ObjectType"
  | "Tag"
  | "LongName";

// ---------------------------------------------------------------------------
// Georeferencing
// ---------------------------------------------------------------------------

export type MapConversionView = {
  eastings: number;
  northings: number;
  orthogonalHeight: number;
  xAxisAbscissa?: number;
  xAxisOrdinate?: number;
  scale?: number;
};

export type ProjectedCrsView = {
  /** Usually an EPSG code as `EPSG:3763`, but the IFC field is free text. */
  name: string;
  description?: string;
  geodeticDatum?: string;
  verticalDatum?: string;
  mapProjection?: string;
  mapZone?: string;
  mapUnit?: string;
};

export type SiteLocationView = {
  /** Decimal degrees, converted from IFC's compound-degrees form. */
  latitude?: number;
  longitude?: number;
  /** Elevation in project length units. */
  elevation?: number;
};

/**
 * `IfcGeometricRepresentationContext` — the model's own frame.
 *
 * Needed to grade LoGeoRef: level 20 is a `WorldCoordinateSystem` offset, level
 * 30 adds `TrueNorth`. Both are meaningful on their own, and both are commonly
 * the *only* georeferencing a model has.
 */
export type RepresentationContextView = {
  expressId: ExpressId;
  /** Translation of the world coordinate system, in project length units. */
  worldCoordinateSystem?: Vec3;
  /**
   * True north as a plan direction `(x, y)` in the model's own frame. IFC
   * stores a direction, not an angle; `trueNorthDegrees` is the derived
   * bearing, clockwise from the model's +Y.
   */
  trueNorth?: [number, number];
  trueNorthDegrees?: number;
  /** Model precision, useful when reporting whether a fit is meaningful. */
  precision?: number;
};

export type GeoreferenceView = {
  hasGeoreference: boolean;
  /**
   * Where the information came from. `siteLocation` alone is LoGeoRef 20/30;
   * `ePSetMapConversion` is the IFC2x3 property-set fallback.
   */
  source?: "mapConversion" | "ePSetMapConversion" | "siteLocation";
  mapConversion?: MapConversionView;
  projectedCRS?: ProjectedCrsView;
  site?: SiteLocationView;
  /** True north as a counter-clockwise angle in degrees from map X, if derivable. */
  angleToGridNorth?: number;
  /** The `Model` representation context, when the file declares one. */
  context?: RepresentationContextView;
  /** Project length units → metres. Map conversion values are in these units. */
  lengthUnitScale?: number;
};

export type GeoreferencePatch = {
  mapConversion?: Partial<MapConversionView>;
  projectedCRS?: Partial<ProjectedCrsView>;
  /** `IfcSite.RefLatitude` / `RefLongitude` (decimal degrees) and `RefElevation` (project length units). */
  site?: { latitude?: number; longitude?: number; elevation?: number };
};

// ---------------------------------------------------------------------------
// IDS validation
// ---------------------------------------------------------------------------

/**
 * IDS validation results, in the adapter's own vocabulary.
 *
 * Deliberately not the engine's report type. The engine returns its report with
 * its own parsed IDS document embedded in every specification result, which
 * would put an `@ifc-lite` type in every component that renders a table — and
 * `docs/adr/001-ifc-engine.md` exists precisely to stop that. This carries only
 * what the UI, the BCF export and the HTML report need.
 */
export type IdsRequirementStatus = "pass" | "fail" | "not_applicable";

export type IdsRequirementResultView = {
  /** Which of the specification's requirements this is — `IdsSpecificationResultView.requirements[].id`. */
  requirementId?: string;
  status: IdsRequirementStatus;
  /** Facet kind: `entity`, `attribute`, `property`, … */
  facetType: string;
  /** What was checked, in prose. */
  description: string;
  /** Why it failed, in prose. Absent when it passed. */
  failureReason?: string;
  /** e.g. `Pset_WallCommon.FireRating`. */
  field?: string;
  actual?: string;
  expected?: string;
};

export type IdsEntityResultView = {
  expressId: ExpressId;
  type: string;
  name?: string;
  /** IFC GlobalId. What a BCF viewpoint needs; absent on unrooted entities. */
  globalId?: string;
  passed: boolean;
  requirements: IdsRequirementResultView[];
};

export type IdsRequirementView = {
  id: string;
  /** What is checked, in prose — the same wording as an entity result's `description`. */
  label: string;
  optionality: "required" | "optional" | "prohibited";
  /** The author's own advice for meeting it, when the IDS gives some. */
  instructions?: string;
};

export type IdsSpecificationResultView = {
  /** Index in the source document, so results can be joined back to it. */
  index: number;
  name: string;
  description?: string;
  status: "pass" | "fail" | "not_applicable";
  applicableCount: number;
  passedCount: number;
  failedCount: number;
  /** 0–100. */
  passRate: number;
  /**
   * The specification's requirements as the document states them, whether or
   * not anything failed one — so a breakdown can list every check, including
   * those every element passed, which have no entity result to come from
   * (passing entities are not kept; see `includePassingEntities`).
   */
  requirements: IdsRequirementView[];
  entities: IdsEntityResultView[];
  /** Set only when the specification declared min/max occurrences. */
  cardinality?: {
    passed: boolean;
    actualCount: number;
    message: string;
  };
};

/** One model's results. Federation aggregation happens in `lib/ids/report.ts`. */
export type IdsModelReport = {
  modelId: ModelId;
  schemaVersion: string;
  entityCount: number;
  specifications: IdsSpecificationResultView[];
};

export type IdsValidationProgress = {
  phase: "filtering" | "validating" | "complete";
  specificationIndex: number;
  totalSpecifications: number;
  percent: number;
};

export type IdsValidationOptions = {
  onProgress?: (progress: IdsValidationProgress) => void;
  /**
   * Keep passing entities in the result. Off by default: a 200 MB model against
   * a 40-specification IDS produces millions of passing rows that nothing
   * renders, and holding them is what makes validation run out of memory.
   */
  includePassingEntities?: boolean;
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export type StepExportOptions = {
  /** Defaults to the model's own schema — changing it triggers a conversion. */
  schema?: IfcSchemaVersion;
  filename?: string;
  author?: string;
  organization?: string;
  /** Georeferencing edits to write into the output. */
  georeference?: GeoreferencePatch;
};

export type StepExportResult = {
  content: Uint8Array;
  entityCount: number;
  byteLength: number;
  /**
   * Things the export was asked for but could not write — for example an
   * `IfcMapConversion` with no representation context to reference. Surface
   * these; an empty output slot is otherwise indistinguishable from success.
   */
  warnings: string[];
};

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * The only surface through which this app touches an IFC engine.
 *
 * Every method is async so an implementation is free to live in a worker, and
 * so swapping in a different engine cannot change a call site's shape.
 */
export interface IfcEngineAdapter {
  /** Identifies the implementation in logs, ADRs and the conformance report. */
  readonly engineId: string;

  loadModel(
    input: LoadModelInput,
    options?: LoadModelOptions,
  ): Promise<ModelSummary>;

  unloadModel(modelId: ModelId): Promise<void>;

  getEntities(
    modelId: ModelId,
    query?: EntityQuery,
  ): Promise<EntitySummary[]>;

  /** One entity by express id. Null when the model has no such entity. */
  getEntity(
    modelId: ModelId,
    expressId: ExpressId,
  ): Promise<EntitySummary | null>;

  /** Distinct IFC class names present in the model, with their counts. */
  getEntityTypes(modelId: ModelId): Promise<Array<{ type: string; count: number }>>;

  /**
   * The property sets, classifications and materials the model actually uses,
   * for autocompleting IDS facets against real data rather than from memory.
   */
  getVocabulary(
    modelId: ModelId,
    options?: VocabularyOptions,
  ): Promise<ModelVocabulary>;

  getProperties(
    modelId: ModelId,
    expressId: ExpressId,
  ): Promise<PropertySetView[]>;

  getSpatialTree(modelId: ModelId): Promise<SpatialNodeView>;

  /** Everything the information panel shows for one element, in one read. */
  getElementInfo(modelId: ModelId, expressId: ExpressId): Promise<ElementInfo>;

  /**
   * Everything the information panel shows for one material — opened from a
   * `MaterialRef` in `ElementInfo.materials`, never from the viewer's own
   * selection: a material has no mesh and is not an `EntityRef` the store
   * tracks.
   */
  getMaterialInfo(
    modelId: ModelId,
    materialExpressId: ExpressId,
  ): Promise<MaterialDetailView>;

  /**
   * What the model can be filtered by, with membership.
   *
   * A full walk rather than the sample `getVocabulary` takes: a filter that
   * hides elements has to know about every element, and a sampled one would
   * quietly leave things on screen that the user asked to hide.
   */
  getFilterFacets(modelId: ModelId): Promise<FilterFacets>;

  /**
   * Every placed element grouped by one value — its class, material, storey, a
   * property… — for a lens to give each value a colour. Elements without the
   * value are in no group. Largest group first.
   */
  groupElementsByValue(modelId: ModelId, source: ElementGroupSource): Promise<FilterFacetValue[]>;

  /** The elements of one model that an `ElementFilter` selects. */
  selectElements(modelId: ModelId, filter: ElementFilter): Promise<ElementMatch[]>;

  /** Evaluate a configurable quantity takeoff without moving IFC data to the UI thread. */
  evaluateQuantityQuery(
    modelId: ModelId,
    query: QuantityQuery,
  ): Promise<QuantityQueryResult>;

  /**
   * Tessellated geometry for the whole model.
   *
   * Expensive and memory-heavy, so it is deliberately separate from
   * `loadModel`: the spatial tree and the property inspector are useful long
   * before the meshes are ready, and a module that never renders (`/ids/validate`
   * running headless) must not pay for them.
   */
  getGeometry(
    modelId: ModelId,
    options?: GeometryOptions,
  ): Promise<ModelGeometry>;

  setEntityAttribute(
    modelId: ModelId,
    expressId: ExpressId,
    attribute: EditableAttribute,
    value: string,
  ): Promise<void>;

  /**
   * Validate this model against an already-parsed IDS document.
   *
   * Parsed, not XML: the engine's IDS parser needs `DOMParser`, which a Web
   * Worker does not have — so parsing happens on the main thread via
   * `lib/ifc/ids-document.ts` and the plain-data result is cloned in. Taking
   * XML here is what made the first version fail with "No DOMParser
   * implementation available".
   */
  validateIds(
    modelId: ModelId,
    document: EngineIdsDocument,
    options?: IdsValidationOptions,
  ): Promise<IdsModelReport>;

  getGeoreferencing(modelId: ModelId): Promise<GeoreferenceView>;

  /**
   * Stage a georeferencing edit. It is applied on the next `exportStep` — the
   * in-memory store is not rewritten, so the original bytes stay intact for
   * signing.
   */
  setGeoreferencing(
    modelId: ModelId,
    patch: GeoreferencePatch,
  ): Promise<void>;

  exportStep(
    modelId: ModelId,
    options?: StepExportOptions,
  ): Promise<StepExportResult>;
}

/** Thrown when a `ModelId` is not (or no longer) loaded. */
export class UnknownModelError extends Error {
  constructor(modelId: ModelId) {
    super(`Model "${modelId}" is not loaded`);
    this.name = "UnknownModelError";
  }
}
