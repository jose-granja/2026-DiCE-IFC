"use client";

/**
 * The federated 3D renderer, on three.js/WebGL.
 *
 * WebGL, not WebGPU, is the shipped path — ADR 001 requires the fallback from
 * day one and forbids requiring WebGPU. {@link detectWebGpu} exists so the UI
 * can say what the machine supports, not so this class can branch on it.
 *
 * ## Why meshes are batched
 *
 * A 200 MB model is ~300 000 elements. One `THREE.Mesh` each would mean 300 000
 * draw calls and 300 000 JS objects — the tab would freeze building the scene
 * before it ever rendered a frame. So each model's meshes are concatenated into
 * a handful of large `BufferGeometry` batches, and per-entity behaviour is
 * recovered from a per-vertex `expressId` attribute:
 *
 *   - **picking** — raycast hits a batch, read the face's first vertex, look up
 *     its `expressId`;
 *   - **selection / colouring** — write the per-vertex colour attribute;
 *   - **hiding / isolating** — rebuild the batch's index buffer to omit the
 *     hidden entities' triangles. O(n) per change, but visibility changes are
 *     user-driven and rare, whereas a per-frame cost would not be.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { getGlobeCanvas } from "./globe-canvas";
import type { Globe } from "./globe";
import type { WgsPoint } from "@/lib/georef/transform";
import {
  orthographicPlanes,
  perspectiveDistance,
  perspectiveViewHeight,
  standardViewDirection,
  type CameraProjection,
  type StandardView,
} from "./camera";

/**
 * Far plane while a 3D tile set is loaded.
 *
 * Comfortably past the far side of the ellipsoid (~12 742 km), so a tileset's
 * planet-scale root bounding volume is inside the frustum wherever the camera
 * is standing. The logarithmic depth buffer is what makes this affordable.
 */
const EARTH_SCALE_FAR = 40_000_000;

import type { MeshView, Vec3 } from "@/lib/ifc/types";
import {
  mergeMeshes,
  planBatches,
  visibleIndices,
  type VertexSpan,
} from "./batching";
import {
  angleLabelPoint,
  boxCentre,
  cross,
  distance,
  dot,
  facePatchCentroid,
  facePatchOutline,
  floodFillCoplanarPatch,
  horizontalMidpoint,
  measurementCorner,
  meshVolume,
  midpoint,
  NEGLIGIBLE_LEG,
  polygonCentroid,
  rotateSectionPlane,
  sectionDirection,
  sectionPlaneCentre,
  sectionRange,
  snapThresholdFor,
  snapToTriangle,
  subtract,
  toClipPlane,
  verticalMidpoint,
  type AngleMeasurement,
  type AreaMeasurement,
  type Measurement,
  type SectionPlane,
  type SnapTargets,
  type SnapTargetType,
  type Triangle,
  type VolumeMeasurement,
} from "./tools";

const SELECTION_COLOUR = new THREE.Color("#ffb020");
const MEASURE_COLOUR = new THREE.Color("#1b6ea8");
// Angle and area overlays get their own colour: they are still measurement
// annotations (see MEASURE_COLOUR above) but need to read as visually
// distinct kinds of thing at a glance, the way the snap markers' shapes do
// for snap targets.
const ANGLE_COLOUR = new THREE.Color("#e0af68");
const AREA_COLOUR = new THREE.Color("#9ece6a");
const VOLUME_BOX_COLOUR = new THREE.Color("#bb9af7");
const SECTION_MOVE_COLOUR = new THREE.Color("#7aa2f7");
const SECTION_ROTATE_COLOUR = new THREE.Color("#e0af68");
const ORIGIN_AXIS_COLOURS = {
  x: new THREE.Color("#f7768e"),
  y: new THREE.Color("#9ece6a"),
  z: new THREE.Color("#7aa2f7"),
};
// Requested explicitly as the snap-preview colour: bright yellow, distinct
// from both the placed-point blue above and the orange selection highlight,
// so a hover marker never gets mistaken for either.
const SNAP_PREVIEW_COLOUR = "#FFEA00";

/**
 * A point-sprite outline texture for one snap marker shape: stroke only, no
 * fill, so the interior stays transparent per the shape spec. Built per
 * renderer instance (in the constructor, alongside the geometry it decorates)
 * rather than at module scope, since it touches `document` — this module is
 * `"use client"`, but nothing stops it being imported in a non-browser
 * environment that never constructs a renderer.
 */
function createSnapMarkerTexture(shape: "square" | "triangle" | "circle"): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d")!;

  context.strokeStyle = SNAP_PREVIEW_COLOUR;
  context.lineWidth = 6;
  const pad = 12;

  context.beginPath();
  if (shape === "square") {
    context.rect(pad, pad, size - pad * 2, size - pad * 2);
  } else if (shape === "triangle") {
    context.moveTo(size / 2, pad);
    context.lineTo(size - pad, size - pad);
    context.lineTo(pad, size - pad);
    context.closePath();
  } else {
    context.arc(size / 2, size / 2, size / 2 - pad, 0, Math.PI * 2);
  }
  context.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/** A small screen-readable label at the end of one model-origin axis. */
function createOriginAxisLabel(
  label: "X" | "Y" | "Z",
  colour: THREE.Color,
): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d")!;
  context.font = "700 44px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = `#${colour.getHexString()}`;
  context.fillText(label, 32, 34);

  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
    }),
  );
  sprite.scale.setScalar(0.32);
  sprite.renderOrder = 1001;
  sprite.frustumCulled = false;
  return sprite;
}

/**
 * IFC-axis tripod at a model's authored (0,0,0).
 *
 * IFC is Z-up while the renderer is Y-up: IFC +X → render +X, IFC +Y →
 * render -Z, and IFC +Z → render +Y. The familiar red/green/blue labels keep
 * that authored frame visible after the conversion.
 */
function createModelOriginMarker(): THREE.Group {
  const marker = new THREE.Group();
  const axes: Array<{
    label: "X" | "Y" | "Z";
    direction: THREE.Vector3;
    colour: THREE.Color;
  }> = [
    { label: "X", direction: new THREE.Vector3(1, 0, 0), colour: ORIGIN_AXIS_COLOURS.x },
    { label: "Y", direction: new THREE.Vector3(0, 0, -1), colour: ORIGIN_AXIS_COLOURS.y },
    { label: "Z", direction: new THREE.Vector3(0, 1, 0), colour: ORIGIN_AXIS_COLOURS.z },
  ];

  const centre = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 14, 10),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  centre.renderOrder = 1000;
  centre.frustumCulled = false;
  marker.add(centre);

  for (const { label, direction, colour } of axes) {
    const lineGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      direction.clone().multiplyScalar(0.82),
    ]);
    const line = new THREE.Line(
      lineGeometry,
      new THREE.LineBasicMaterial({
        color: colour,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    line.renderOrder = 1000;
    line.frustumCulled = false;
    marker.add(line);

    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.075, 0.22, 12),
      new THREE.MeshBasicMaterial({
        color: colour,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    cone.position.copy(direction).multiplyScalar(0.89);
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    cone.renderOrder = 1000;
    cone.frustumCulled = false;
    marker.add(cone);

    const axisLabel = createOriginAxisLabel(label, colour);
    axisLabel.position.copy(direction).multiplyScalar(1.18);
    marker.add(axisLabel);
  }

  marker.visible = false;
  return marker;
}

/**
 * Sampled points tracing the arc between an angle measurement's two rays,
 * as consecutive pairs ready for `LineSegments`. Empty when either ray has
 * zero length — nothing meaningful to draw.
 *
 * The two rays need not be coplanar with any convenient axis, so the sweep
 * from one to the other is a quaternion slerp between their unit vectors
 * rather than a 2D angle interpolation — that generalises to any relative
 * orientation for free.
 */
function angleArcPositions(measurement: AngleMeasurement, segments = 24): number[] {
  const vertex = new THREE.Vector3(...measurement.vertex);
  const from = new THREE.Vector3(...measurement.a).sub(vertex);
  const to = new THREE.Vector3(...measurement.c).sub(vertex);
  if (from.lengthSq() === 0 || to.lengthSq() === 0) return [];

  const radius = Math.min(from.length(), to.length()) * 0.3;
  const fromUnit = from.clone().normalize();
  const toUnit = to.clone().normalize();
  const sweep = new THREE.Quaternion().setFromUnitVectors(fromUnit, toUnit);
  const identity = new THREE.Quaternion();

  const positions: number[] = [];
  let previous: THREE.Vector3 | null = null;
  for (let i = 0; i <= segments; i += 1) {
    const step = identity.clone().slerp(sweep, i / segments);
    const point = fromUnit.clone().applyQuaternion(step).multiplyScalar(radius).add(vertex);
    if (previous) positions.push(previous.x, previous.y, previous.z, point.x, point.y, point.z);
    previous = point;
  }
  return positions;
}

/** The 12 edges of the axis-aligned box between two opposite corners, as consecutive pairs for `LineSegments`. */
function boxEdgePositions(corner1: Vec3, corner2: Vec3): number[] {
  const min: Vec3 = [
    Math.min(corner1[0], corner2[0]),
    Math.min(corner1[1], corner2[1]),
    Math.min(corner1[2], corner2[2]),
  ];
  const max: Vec3 = [
    Math.max(corner1[0], corner2[0]),
    Math.max(corner1[1], corner2[1]),
    Math.max(corner1[2], corner2[2]),
  ];

  const corners: Vec3[] = [
    [min[0], min[1], min[2]],
    [max[0], min[1], min[2]],
    [max[0], max[1], min[2]],
    [min[0], max[1], min[2]],
    [min[0], min[1], max[2]],
    [max[0], min[1], max[2]],
    [max[0], max[1], max[2]],
    [min[0], max[1], max[2]],
  ];
  const edges: Array<[number, number]> = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0], // bottom
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4], // top
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7], // verticals
  ];

  const positions: number[] = [];
  for (const [i, j] of edges) positions.push(...corners[i], ...corners[j]);
  return positions;
}

export type WebGpuSupport = {
  available: boolean;
  /**
   * Why, as a code rather than a rendered string — this module is not a
   * component and cannot call `useTranslations`. The caller (`ViewerCanvas`)
   * maps this to `viewer.canvas.webgpu.*` for the toast the user sees.
   */
  reason: "noWebGpu" | "available" | "noAdapter" | "probeFailed";
};

/**
 * Whether this browser exposes WebGPU. Reported to the user; never used to gate
 * rendering.
 */
export async function detectWebGpu(): Promise<WebGpuSupport> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } })
    .gpu;
  if (!gpu) {
    return { available: false, reason: "noWebGpu" };
  }
  try {
    const adapter = await gpu.requestAdapter();
    return adapter
      ? { available: true, reason: "available" }
      : { available: false, reason: "noAdapter" };
  } catch {
    return { available: false, reason: "probeFailed" };
  }
}

type Batch = {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  /** Per-vertex express ids, for picking and per-entity updates. */
  entityIds: Uint32Array;
  /** Every triangle, as originally built. The live index is a subset of this. */
  allIndices: Uint32Array;
  /** Base colour per vertex, so selection can be undone without a rebuild. */
  baseColours: Float32Array;
};

type ModelScene = {
  modelId: string;
  group: THREE.Group;
  /** IFC (0,0,0), expressed in this model's RTC-shifted render frame. */
  originMarker: THREE.Group;
  batches: Batch[];
  /** expressId → the vertex ranges holding it, for colour updates. */
  ranges: Map<number, Array<VertexSpan & { batch: number }>>;
};

export type PickResult = { modelId: string; expressId: number } | null;

/** A pick that also reports where on the surface the ray landed. */
export type PointPick = {
  /**
   * Absent when the point landed on the context model: it has no elements —
   * see `setContextGeometry` — so there is no expressId to report, only a
   * point. Measurements don't care which; they store raw points, never a
   * model/expressId pair (`lib/viewer/store.ts`).
   */
  modelId?: string;
  expressId?: number;
  /** World point in render space, snapped to an enabled target when close. */
  point: Vec3;
  /** Which kind of target it snapped to — null when the raw hit was kept. */
  snapType: SnapTargetType | null;
};

/** Where a world point lands on screen, for HTML overlays. */
export type ScreenPoint = { x: number; y: number; visible: boolean };

type ViewerCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

export type ViewerCameraState = {
  position: Vec3;
  target: Vec3;
  projection?: CameraProjection;
  fov?: number;
  /** Visible vertical span in world units for an orthographic camera. */
  viewHeight?: number;
};

export type SectionGizmoUpdate = {
  id: string;
  patch: Pick<SectionPlane, "position"> & Partial<Pick<SectionPlane, "rotation">>;
};

type SectionGizmoDrag = {
  id: string;
  kind: "translate" | "rotate";
  plane: SectionPlane;
  bounds: { min: Vec3; max: Vec3 } | null;
  centre: THREE.Vector3;
  pointerStart: THREE.Vector2;
  screenDirection: THREE.Vector2;
  worldPerPixel: number;
  ringAngleStart: number | null;
};

export class ViewerRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: ViewerCamera;
  private controls: OrbitControls<THREE.Camera>;
  private raycaster = new THREE.Raycaster();
  private models = new Map<string, ModelScene>();
  private resizeObserver: ResizeObserver;
  private frame = 0;
  private disposed = false;
  private clipPlanes: THREE.Plane[] = [];
  private sectionGizmoGroup = new THREE.Group();
  private sectionGizmoTargets: THREE.Mesh[] = [];
  private sectionPlaneState = new Map<string, SectionPlane>();
  private sectionBounds: { min: Vec3; max: Vec3 } | null = null;
  private sectionGizmoDrag: SectionGizmoDrag | null = null;
  private measurementGroup = new THREE.Group();
  /** Angle measurements: the two rays plus an arc, per measurement — rebuilt on every change, same as `measurementGroup`. */
  private angleGroup = new THREE.Group();
  /** Area measurements: outline plus a translucent fan-triangulated fill. */
  private areaGroup = new THREE.Group();
  /** Volume measurements: a wireframe box per `"box"`-kind entry — an `"element"`-kind entry is shown via ordinary selection instead (see `getElementVolume`). */
  private volumeGroup = new THREE.Group();
  /**
   * Where the measurement tool's next click would land, if snapped — one
   * marker per `SnapTargetType`, shaped differently (square/triangle/circle)
   * so the type is visible, not just the position. At most one is ever
   * visible at a time; `setSnapPreview` hides the rest. Not part of
   * `measurementGroup`: these move on every pointer move, so each is a
   * transform update rather than a rebuilt `BufferGeometry` —
   * `measurementGroup` is disposed and recreated on every change, which is
   * fine for a list that changes on click, not on hover.
   */
  private snapPreviewMarkers: Record<SnapTargetType, THREE.Points>;
  private contextMesh: THREE.Mesh | null = null;
  private globe: Globe | null = null;
  private depthProxy: THREE.Mesh | null = null;
  private globeOrigin: WgsPoint | null = null;
  /** Grid convergence at `globeOrigin`, radians — see `lib/georef/transform.ts`. */
  private globeNorthCorrection = 0;
  private backgroundColour = "#1a1b26";
  /** Far plane for the model alone, restored when the globe is switched off. */
  private modelFar = 10_000;
  private perspectiveFov = 60;
  private originsVisible = false;
  private projectionListeners = new Set<(projection: CameraProjection) => void>();
  private cameraRotationListeners = new Set<
    (rotation: { azimuth: number; elevation: number }) => void
  >();

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      // Needed for the BCF snapshot in Phase 6: without it the drawing buffer
      // is cleared before toDataURL can read it.
      preserveDrawingBuffer: true,
      // Transparent, so a Cesium globe drawn on the canvas behind shows through
      // wherever there is no geometry. `setBackgroundColor` still paints an
      // opaque backdrop when there is no globe, so BCF snapshots keep their sky
      // rather than a transparent hole.
      alpha: true,
      // A building is millimetres-to-metres; a 3D tile set is planet-scale, and
      // its root bounding volume sits ~6 371 km from our origin. Both have to be
      // in the same frustum, and a linear depth buffer across that range leaves
      // the model z-fighting with itself. This is a constructor-only option, so
      // it is on always rather than switched when tiles are enabled.
      logarithmicDepthBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 10_000);
    this.camera.position.set(20, 20, 20);

    this.controls = new OrbitControls<THREE.Camera>(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.addEventListener("change", this.notifyCameraRotation);

    // Two lights and an ambient term. Meshes are double-sided with unreliable
    // winding (see MeshView.indices), so lighting must not depend on normals
    // pointing outward.
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, 2, 1);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.8);
    fill.position.set(-1, 0.5, -1);
    this.scene.add(fill);

    this.measurementGroup.renderOrder = 999;
    this.scene.add(this.measurementGroup);
    this.angleGroup.renderOrder = 999;
    this.scene.add(this.angleGroup);
    this.areaGroup.renderOrder = 999;
    this.scene.add(this.areaGroup);
    this.volumeGroup.renderOrder = 999;
    this.scene.add(this.volumeGroup);
    this.scene.add(this.sectionGizmoGroup);

    this.snapPreviewMarkers = {
      corner: this.createSnapPreviewMarker("square"),
      edgeMidpoint: this.createSnapPreviewMarker("triangle"),
      edge: this.createSnapPreviewMarker("circle"),
    };

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.animate();
  }

  /** A hidden, screen-constant-size point sprite textured with one snap marker shape. */
  private createSnapPreviewMarker(shape: "square" | "triangle" | "circle"): THREE.Points {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));

    const marker = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        map: createSnapMarkerTexture(shape),
        size: 20,
        sizeAttenuation: false,
        depthTest: false,
        transparent: true,
      }),
    );
    marker.visible = false;
    marker.renderOrder = 999;
    this.scene.add(marker);
    return marker;
  }

  private resize() {
    const { clientWidth, clientHeight } = this.canvas;
    if (clientWidth === 0 || clientHeight === 0) return;
    this.renderer.setSize(clientWidth, clientHeight, false);
    const aspect = clientWidth / clientHeight;
    if (this.camera instanceof THREE.PerspectiveCamera) {
      this.camera.aspect = aspect;
    } else {
      const viewHeight =
        (this.camera.top - this.camera.bottom) / this.camera.zoom;
      const planes = orthographicPlanes(viewHeight, aspect);
      this.camera.left = planes.left;
      this.camera.right = planes.right;
      this.camera.top = planes.top;
      this.camera.bottom = planes.bottom;
      this.camera.zoom = 1;
    }
    this.camera.updateProjectionMatrix();
  }

  private animate = () => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.animate);
    this.controls.update();
    this.updateOriginMarkerScales();
    this.updateSectionGizmoScales();
    // Before the draw: the tile set streams from where the camera is now, and
    // updating after would render a frame behind the camera every frame.
    if (this.globe && this.globeOrigin) {
      // Before the draw, so the globe is rendered for the camera this frame
      // rather than the previous one — a frame of lag reads as the world
      // sliding against the model whenever the camera moves.
      this.globe.sync(this.camera, this.globeOrigin, this.globeNorthCorrection);
    }

    this.renderer.render(this.scene, this.camera);
  };

  // -------------------------------------------------------------------------
  // Models
  // -------------------------------------------------------------------------

  /**
   * Add or replace a model's geometry.
   *
   * `tint` blends the model's list colour into every element, so a federation
   * reads as distinct models rather than one undifferentiated grey mass. At 0
   * the authored IFC colours come through unchanged.
   */
  setModelGeometry(
    modelId: string,
    meshes: MeshView[],
    options: {
      tint?: THREE.ColorRepresentation;
      tintAmount?: number;
      originShift?: Vec3;
    } = {},
  ) {
    this.removeModel(modelId);

    const group = new THREE.Group();
    const batches: Batch[] = [];
    const ranges: ModelScene["ranges"] = new Map();

    const tint = options.tint ? new THREE.Color(options.tint) : null;
    const tintAmount = options.tintAmount ?? 0;
    const originShift = options.originShift ?? [0, 0, 0];
    const originMarker = createModelOriginMarker();
    originMarker.position.set(-originShift[0], -originShift[1], -originShift[2]);
    originMarker.visible = this.originsVisible;
    group.add(originMarker);

    planBatches(meshes).forEach((group_, batchIndex) => {
      const merged = mergeMeshes(group_, {
        tint: tint ? [tint.r, tint.g, tint.b] : undefined,
        tintAmount,
      });

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(merged.positions, 3),
      );
      geometry.setAttribute("normal", new THREE.BufferAttribute(merged.normals, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(merged.colours, 3));
      geometry.setIndex(new THREE.BufferAttribute(merged.indices, 1));
      geometry.computeBoundingSphere();

      const mesh = new THREE.Mesh(geometry);
      mesh.frustumCulled = true;

      for (const [expressId, spans] of merged.spans) {
        const existing = ranges.get(expressId) ?? [];
        for (const span of spans) existing.push({ batch: batchIndex, ...span });
        ranges.set(expressId, existing);
      }

      batches.push({
        mesh,
        geometry,
        entityIds: merged.entityIds,
        allIndices: merged.indices,
        baseColours: merged.colours.slice(),
      });
      group.add(mesh);
    });

    for (const batch of batches) batch.mesh.material = this.material();

    this.scene.add(group);
    this.models.set(modelId, {
      modelId,
      group,
      originMarker,
      batches,
      ranges,
    });
  }

  private material(): THREE.Material {
    return new THREE.MeshLambertMaterial({
      vertexColors: true,
      // Winding order is unreliable, so back-face culling would punch holes.
      side: THREE.DoubleSide,
      clippingPlanes: this.clipPlanes,
      clipShadows: false,
    });
  }

  /**
   * How many models are in the scene.
   *
   * The store and the scene are separate things, and a model can be gone from
   * one while still drawn in the other — which is exactly the bug this exists
   * to make visible. Surfaced on the canvas as `data-rendered-models`.
   */
  get modelCount(): number {
    return this.models.size;
  }

  removeModel(modelId: string) {
    const model = this.models.get(modelId);
    if (!model) return;

    this.scene.remove(model.group);
    for (const batch of model.batches) {
      batch.geometry.dispose();
      (batch.mesh.material as THREE.Material).dispose();
    }
    disposeObject(model.originMarker);
    this.models.delete(modelId);
  }

  /** Position a model in the federated frame. */
  setPlacement(modelId: string, offset: Vec3, rotationY = 0, scale = 1) {
    const model = this.models.get(modelId);
    if (!model) return;
    model.group.position.set(offset[0], offset[1], offset[2]);
    model.group.rotation.y = rotationY;
    model.group.scale.setScalar(scale);
  }

  setModelVisible(modelId: string, visible: boolean) {
    const model = this.models.get(modelId);
    if (model) model.group.visible = visible;
  }

  /** Show or hide the authored IFC origin of every loaded model. */
  setOriginsVisible(visible: boolean) {
    this.originsVisible = visible;
    for (const model of this.models.values()) {
      model.originMarker.visible = visible;
    }
  }

  /** Keep every origin tripod approximately 68 CSS pixels long on screen. */
  private updateOriginMarkerScales() {
    if (!this.originsVisible || this.canvas.clientHeight === 0) return;

    const markerWorldPosition = new THREE.Vector3();
    for (const model of this.models.values()) {
      model.originMarker.getWorldPosition(markerWorldPosition);
      const worldPerPixel =
        this.camera instanceof THREE.PerspectiveCamera
          ? (2 *
              this.camera.position.distanceTo(markerWorldPosition) *
              Math.tan((this.camera.fov * Math.PI) / 360)) /
            this.canvas.clientHeight
          : ((this.camera.top - this.camera.bottom) / this.camera.zoom) /
            this.canvas.clientHeight;
      const parentScale = Math.max(Math.abs(model.group.scale.x), 0.0001);
      model.originMarker.scale.setScalar((worldPerPixel * 68) / parentScale);
    }
  }

  // -------------------------------------------------------------------------
  // Per-entity appearance
  // -------------------------------------------------------------------------

  /**
   * Highlight a selection and restore everything else.
   *
   * Writes the per-vertex colour attribute rather than swapping materials,
   * because a selection can span several entities inside one batch.
   */
  setSelection(refs: Array<{ modelId: string; expressId: number }>) {
    for (const model of this.models.values()) {
      for (const batch of model.batches) {
        const colours = batch.geometry.getAttribute("color") as THREE.BufferAttribute;
        (colours.array as Float32Array).set(batch.baseColours);
        colours.needsUpdate = true;
      }
    }

    for (const ref of refs) {
      const model = this.models.get(ref.modelId);
      const spans = model?.ranges.get(ref.expressId);
      if (!model || !spans) continue;

      for (const span of spans) {
        const colours = model.batches[span.batch].geometry.getAttribute(
          "color",
        ) as THREE.BufferAttribute;
        const array = colours.array as Float32Array;
        for (let v = span.start; v < span.start + span.count; v += 1) {
          array[v * 3] = SELECTION_COLOUR.r;
          array[v * 3 + 1] = SELECTION_COLOUR.g;
          array[v * 3 + 2] = SELECTION_COLOUR.b;
        }
        colours.needsUpdate = true;
      }
    }
  }

  /**
   * Show only the entities `isVisible` accepts.
   *
   * Rebuilds each batch's index buffer. Deliberately O(triangles): the cost
   * lands on an explicit user action (hide, isolate, filter), never per frame.
   */
  setEntityVisibility(
    modelId: string,
    isVisible: (expressId: number) => boolean,
  ) {
    const model = this.models.get(modelId);
    if (!model) return;

    let total = 0;
    let shown = 0;
    for (const batch of model.batches) {
      for (const id of new Set(batch.entityIds)) {
        total += 1;
        if (isVisible(id)) shown += 1;
      }
      const kept = visibleIndices(batch.allIndices, batch.entityIds, isVisible);
      batch.geometry.setIndex(
        new THREE.BufferAttribute(new Uint32Array(kept), 1),
      );
      batch.geometry.index!.needsUpdate = true;
    }

    const marker = document.querySelector<HTMLElement>("[data-rendered-models]");
    if (marker) marker.dataset.visibleEntities = `${shown}/${total}`;
  }

  // -------------------------------------------------------------------------
  // Camera and interaction
  // -------------------------------------------------------------------------

  fitToBounds(bounds: { min: Vec3; max: Vec3 } | null) {
    if (!bounds) return;

    const box = new THREE.Box3(
      new THREE.Vector3(...bounds.min),
      new THREE.Vector3(...bounds.max),
    );
    if (box.isEmpty()) return;

    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1);

    const distance =
      radius / Math.sin((this.perspectiveFov * Math.PI) / 360);
    // Far plane follows the model, or a 40 km infrastructure alignment clips.
    // Remembered, so switching 3D tiles off restores the model's own range
    // rather than leaving the camera at planet scale.
    this.modelFar = Math.max(distance * 10, 10_000);
    this.camera.far = this.globe ? EARTH_SCALE_FAR : this.modelFar;
    this.camera.near = Math.max(distance / 10_000, 0.01);
    if (this.camera instanceof THREE.OrthographicCamera) {
      // A bounding sphere must fit both axes; portrait viewports therefore
      // need more vertical span so the horizontal diameter is not clipped.
      const viewHeight =
        (radius * 2.2) / Math.min(1, Math.max(this.aspectRatio, 0.0001));
      const planes = orthographicPlanes(viewHeight, this.aspectRatio);
      this.camera.left = planes.left;
      this.camera.right = planes.right;
      this.camera.top = planes.top;
      this.camera.bottom = planes.bottom;
      this.camera.zoom = 1;
    }
    this.camera.updateProjectionMatrix();

    const direction = new THREE.Vector3(1, 0.8, 1).normalize();
    this.camera.position.copy(centre).addScaledVector(direction, distance);
    this.controls.target.copy(centre);
    this.controls.update();
  }

  /** Frame visible model geometry together with every visible model origin. */
  fitToBoundsAndOrigins(bounds: { min: Vec3; max: Vec3 } | null) {
    const box = bounds
      ? new THREE.Box3(
          new THREE.Vector3(...bounds.min),
          new THREE.Vector3(...bounds.max),
        )
      : new THREE.Box3();
    const origin = new THREE.Vector3();
    for (const model of this.models.values()) {
      if (!model.group.visible) continue;
      model.originMarker.getWorldPosition(origin);
      box.expandByPoint(origin);
    }
    if (box.isEmpty()) return;
    this.fitToBounds({
      min: box.min.toArray() as Vec3,
      max: box.max.toArray() as Vec3,
    });
  }

  /**
   * Render-space bounding box of a specific set of entities.
   *
   * `federationBounds` (the viewer store's own) covers every visible *model*,
   * not a subset of elements — the wrong tool for framing one failing wall
   * in a BCF viewpoint, which used to fit the camera to the whole building
   * instead. `model.ranges` already maps an expressId to its vertex spans
   * (built for `setSelection`'s per-vertex colouring), so this reads
   * positions from the same spans and carries them through the model's own
   * transform (`group.matrixWorld`) into the shared render frame.
   */
  boundsOfRefs(
    refs: Array<{ modelId: string; expressId: number }>,
  ): { min: Vec3; max: Vec3 } | null {
    const box = new THREE.Box3();
    const vertex = new THREE.Vector3();
    let found = false;

    for (const ref of refs) {
      const model = this.models.get(ref.modelId);
      const spans = model?.ranges.get(ref.expressId);
      if (!model || !spans) continue;

      model.group.updateMatrixWorld();
      for (const span of spans) {
        const positions = model.batches[span.batch].geometry.getAttribute(
          "position",
        ) as THREE.BufferAttribute;
        for (let v = span.start; v < span.start + span.count; v += 1) {
          vertex.fromBufferAttribute(positions, v).applyMatrix4(model.group.matrixWorld);
          box.expandByPoint(vertex);
          found = true;
        }
      }
    }

    if (!found || box.isEmpty()) return null;
    return { min: box.min.toArray() as Vec3, max: box.max.toArray() as Vec3 };
  }

  /**
   * Nearest hit under the cursor, across the whole federation.
   *
   * Two things this must get right and an obvious implementation does not:
   *
   *  - **Nearest across all models, not the first model with a hit.** Iterating
   *    models and returning the first would pick an occluded element from
   *    whichever model happened to load first.
   *  - **Respect the section planes.** three's raycaster knows nothing about
   *    clipping, so without this you can select and measure surfaces that have
   *    been sliced away and are not on screen.
   */
  /**
   * `includeContext` is off by default: element selection (`pick()`) must
   * never resolve to the context mesh, which has no expressId and is not an
   * element — see `setContextGeometry`. Only the measurement tool
   * (`pickPoint()`) turns it on, because a measurement is just two points and
   * does not care what surface they came from.
   */
  private raycast(
    offsetX: number,
    offsetY: number,
    includeContext = false,
  ):
    | { kind: "model"; model: ModelScene; batch: Batch; hit: THREE.Intersection }
    | { kind: "context"; mesh: THREE.Mesh; hit: THREE.Intersection }
    | null {
    const rect = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      (offsetX / rect.width) * 2 - 1,
      -(offsetY / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);

    const targets: THREE.Object3D[] = [];
    for (const model of this.models.values()) {
      if (!model.group.visible) continue;
      for (const batch of model.batches) targets.push(batch.mesh);
    }
    if (includeContext && this.contextMesh) targets.push(this.contextMesh);

    for (const hit of this.raycaster.intersectObjects(targets, false)) {
      if (!hit.face) continue;
      if (this.isClipped(hit.point)) continue;

      if (this.contextMesh && hit.object === this.contextMesh) {
        return { kind: "context", mesh: this.contextMesh, hit };
      }
      for (const model of this.models.values()) {
        const batch = model.batches.find((b) => b.mesh === hit.object);
        if (batch) return { kind: "model", model, batch, hit };
      }
    }
    return null;
  }

  private isClipped(point: THREE.Vector3): boolean {
    return this.clipPlanes.some((plane) => plane.distanceToPoint(point) < 0);
  }

  /** Pick at canvas-relative pixel coordinates. */
  pick(offsetX: number, offsetY: number): PickResult {
    const result = this.raycast(offsetX, offsetY);
    if (!result || result.kind !== "model") return null;
    return {
      modelId: result.model.modelId,
      expressId: result.batch.entityIds[result.hit.face!.a],
    };
  }

  /**
   * One element's own solid volume and label-anchor centroid, for the volume
   * measurement tool's "element" mode. Null when the model or the entity
   * (already removed, or never had geometry) cannot be found.
   *
   * Walks every batch's triangles once, keeping the ones tagged with this
   * `expressId` — the same "all three vertices share one entity" fact
   * `visibleIndices` in `batching.ts` relies on. Computed from *local*
   * geometry, before the model group's placement transform: see
   * `meshVolume`'s own doc comment for why that is exactly as correct as
   * doing it in world space, and considerably cheaper.
   */
  getElementVolume(modelId: string, expressId: number): { volume: number; centroid: Vec3 } | null {
    const model = this.models.get(modelId);
    if (!model) return null;

    const triangles: Triangle[] = [];
    let sum: Vec3 = [0, 0, 0];
    let vertexCount = 0;

    for (const batch of model.batches) {
      const positions = batch.geometry.getAttribute("position") as THREE.BufferAttribute;
      const normals = batch.geometry.getAttribute("normal") as THREE.BufferAttribute;
      const { allIndices, entityIds } = batch;

      for (let i = 0; i < allIndices.length; i += 3) {
        const ia = allIndices[i];
        if (entityIds[ia] !== expressId) continue;
        const ib = allIndices[i + 1];
        const ic = allIndices[i + 2];

        const a: Vec3 = [positions.getX(ia), positions.getY(ia), positions.getZ(ia)];
        const b: Vec3 = [positions.getX(ib), positions.getY(ib), positions.getZ(ib)];
        const c: Vec3 = [positions.getX(ic), positions.getY(ic), positions.getZ(ic)];

        // `meshVolume` needs every triangle wound the same way, which IFC
        // meshes cannot be assumed to have (AGENTS.md §5 — it is why
        // materials are double-sided rather than depending on winding). The
        // authored per-vertex normal stays trustworthy regardless, so it is
        // what decides whether this triangle's winding agrees with "outward"
        // — flip it when the winding-derived face normal points the other way.
        const faceNormal = cross(subtract(b, a), subtract(c, a));
        const authoredNormal: Vec3 = [
          normals.getX(ia) + normals.getX(ib) + normals.getX(ic),
          normals.getY(ia) + normals.getY(ib) + normals.getY(ic),
          normals.getZ(ia) + normals.getZ(ib) + normals.getZ(ic),
        ];
        triangles.push(dot(faceNormal, authoredNormal) >= 0 ? [a, b, c] : [a, c, b]);

        sum = [sum[0] + a[0] + b[0] + c[0], sum[1] + a[1] + b[1] + c[1], sum[2] + a[2] + b[2] + c[2]];
        vertexCount += 3;
      }
    }

    if (triangles.length === 0) return null;
    return {
      volume: meshVolume(triangles),
      centroid: [sum[0] / vertexCount, sum[1] / vertexCount, sum[2] / vertexCount],
    };
  }

  /**
   * The flat face under a screen point, for the area measurement tool's
   * "face" mode: the connected, coplanar patch of the hit entity's own
   * triangles that the click landed on (`floodFillCoplanarPatch`) — a wall's
   * face, a slab's topside. Null off the model; never reaches the context
   * mesh, which has no expressId to report (same exclusion as `pick()`).
   *
   * Collects the *whole* entity's triangles first, same as
   * `getElementVolume`, because the flood fill needs every candidate
   * neighbour available to grow into, not just the ones in the batch near
   * the seed. Local space throughout — a rigid placement transform preserves
   * area exactly as it preserves volume (see `meshVolume`'s doc comment).
   */
  pickFace(offsetX: number, offsetY: number): { modelId: string; expressId: number; triangles: Triangle[] } | null {
    const result = this.raycast(offsetX, offsetY, false);
    if (!result || result.kind !== "model") return null;

    const face = result.hit.face!;
    const expressId = result.batch.entityIds[face.a];

    const triangles: Triangle[] = [];
    let seedIndex = -1;

    for (const batch of result.model.batches) {
      const positions = batch.geometry.getAttribute("position") as THREE.BufferAttribute;
      const { allIndices, entityIds } = batch;

      for (let i = 0; i < allIndices.length; i += 3) {
        const ia = allIndices[i];
        if (entityIds[ia] !== expressId) continue;
        const ib = allIndices[i + 1];
        const ic = allIndices[i + 2];

        if (batch === result.batch && ia === face.a && ib === face.b && ic === face.c) {
          seedIndex = triangles.length;
        }
        triangles.push([
          [positions.getX(ia), positions.getY(ia), positions.getZ(ia)],
          [positions.getX(ib), positions.getY(ib), positions.getZ(ib)],
          [positions.getX(ic), positions.getY(ic), positions.getZ(ic)],
        ]);
      }
    }

    // Should always be found — the seed triangle is what raycast just hit —
    // but a click that lands exactly as geometry is swapped out from under it
    // is possible, and a null here is far better than measuring the wrong face.
    if (seedIndex === -1) return null;

    return {
      modelId: result.model.modelId,
      expressId,
      triangles: floodFillCoplanarPatch(triangles, seedIndex),
    };
  }

  /**
   * Pick a point on a surface, snapped to the nearest enabled target on the
   * triangle it hit — a corner, an edge midpoint, or the nearest point on an
   * edge — when one is close enough. Used by the measurement tool, which is
   * also the one caller that can land on the context model — see `raycast()`.
   *
   * `targets` defaults to corner-only — measuring between corners is what
   * people actually want — but a face's true midpoint or an arbitrary edge
   * point has no other way to be reached, so the caller (the measure panel's
   * snap checkboxes) can ask for any combination, or none for the raw hit.
   * Skipped entirely when nothing is enabled, rather than computed and
   * discarded: reading back the triangle's vertex positions is the whole
   * cost of snapping, and there is nothing to spend it on when it is off.
   */
  pickPoint(
    offsetX: number,
    offsetY: number,
    targets: SnapTargets = { corner: true, edgeMidpoint: false, edge: false },
  ): PointPick | null {
    const result = this.raycast(offsetX, offsetY, true);
    if (!result) return null;

    const { hit } = result;
    const face = hit.face!;
    const point = hit.point.toArray() as Vec3;

    let snapped: { point: Vec3; snapped: boolean; type: SnapTargetType | null } = {
      point,
      snapped: false,
      type: null,
    };
    if (targets.corner || targets.edgeMidpoint || targets.edge) {
      // The hit point is in world space, but the mesh's vertices are local to
      // whatever carries its placement — the model's group, or (for the
      // context mesh, which has no group of its own) the mesh itself.
      // Comparing them in different frames would make snapping silently
      // never fire on anything offset from the render origin.
      const object = result.kind === "model" ? result.model.group : result.mesh;
      const geometry =
        result.kind === "model" ? result.batch.geometry : result.mesh.geometry;
      const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
      const corners = [face.a, face.b, face.c].map((index) => {
        const local = new THREE.Vector3().fromBufferAttribute(positions, index);
        return object.localToWorld(local).toArray() as Vec3;
      }) as [Vec3, Vec3, Vec3];

      const threshold = snapThresholdFor(this.camera.position.distanceTo(hit.point));
      snapped = snapToTriangle(point, corners, threshold, targets);
    }

    if (result.kind === "context") {
      return { point: snapped.point, snapType: snapped.type };
    }
    return {
      modelId: result.model.modelId,
      expressId: result.batch.entityIds[face.a],
      point: snapped.point,
      snapType: snapped.type,
    };
  }

  /** Where a world point lands on the canvas, in CSS pixels. */
  projectPoint(point: Vec3): ScreenPoint {
    const projected = new THREE.Vector3(...point).project(this.camera);
    const rect = this.canvas.getBoundingClientRect();

    return {
      x: ((projected.x + 1) / 2) * rect.width,
      y: ((1 - projected.y) / 2) * rect.height,
      // z outside [-1, 1] means behind the camera or beyond the far plane;
      // without this the label reappears mirrored behind the viewer.
      visible: projected.z >= -1 && projected.z <= 1,
    };
  }

  /** Camera state, for BCF viewpoints and workspace persistence. */
  getCameraState(): ViewerCameraState {
    return {
      position: this.camera.position.toArray() as Vec3,
      target: this.controls.target.toArray() as Vec3,
      projection: this.projection,
      fov:
        this.camera instanceof THREE.PerspectiveCamera
          ? this.camera.fov
          : undefined,
      viewHeight: this.camera instanceof THREE.OrthographicCamera
        ? (this.camera.top - this.camera.bottom) / this.camera.zoom
        : undefined,
    };
  }

  get projection(): CameraProjection {
    return this.camera instanceof THREE.OrthographicCamera
      ? "orthographic"
      : "perspective";
  }

  /**
   * Swap the real three.js camera while keeping the same target and apparent
   * scale. OrbitControls can manage either camera through its `object` field,
   * so its listeners and camera-settled subscriptions remain attached.
   */
  setProjection(projection: CameraProjection) {
    if (projection === this.projection) return;

    const current = this.camera;
    const target = this.controls.target.clone();
    const direction = current.position.clone().sub(target).normalize();
    const distance = Math.max(current.position.distanceTo(target), 0.001);
    const far = current.far;
    const near = current.near;
    let next: ViewerCamera;

    if (projection === "orthographic") {
      const viewHeight = perspectiveViewHeight(distance, this.perspectiveFov);
      const planes = orthographicPlanes(viewHeight, this.aspectRatio);
      next = new THREE.OrthographicCamera(
        planes.left,
        planes.right,
        planes.top,
        planes.bottom,
        near,
        far,
      );
    } else {
      const viewHeight = current instanceof THREE.OrthographicCamera
        ? (current.top - current.bottom) / current.zoom
        : perspectiveViewHeight(distance, this.perspectiveFov);
      const perspectiveDistanceToTarget = perspectiveDistance(
        viewHeight,
        this.perspectiveFov,
      );
      next = new THREE.PerspectiveCamera(
        this.perspectiveFov,
        this.aspectRatio,
        near,
        far,
      );
      next.position
        .copy(target)
        .addScaledVector(direction, perspectiveDistanceToTarget);
    }

    if (projection === "orthographic") next.position.copy(current.position);
    next.up.copy(current.up);
    next.quaternion.copy(current.quaternion);
    next.updateProjectionMatrix();

    this.camera = next;
    this.controls.object = next;
    this.controls.update();
    for (const listener of this.projectionListeners) listener(projection);
  }

  onProjectionChange(
    listener: (projection: CameraProjection) => void,
  ): () => void {
    this.projectionListeners.add(listener);
    return () => this.projectionListeners.delete(listener);
  }

  /** Live orbit angles used by the orientation cube. */
  onCameraRotationChange(
    listener: (rotation: { azimuth: number; elevation: number }) => void,
  ): () => void {
    this.cameraRotationListeners.add(listener);
    listener(this.cameraRotation());
    return () => this.cameraRotationListeners.delete(listener);
  }

  private cameraRotation() {
    return {
      azimuth: (this.controls.getAzimuthalAngle() * 180) / Math.PI,
      elevation: 90 - (this.controls.getPolarAngle() * 180) / Math.PI,
    };
  }

  private notifyCameraRotation = () => {
    const rotation = this.cameraRotation();
    for (const listener of this.cameraRotationListeners) listener(rotation);
  };

  /** Orbit by cube-drag deltas expressed in degrees. */
  orbit(deltaX: number, deltaY: number) {
    this.controls.rotateLeft((deltaX * Math.PI) / 180);
    this.controls.rotateUp((deltaY * Math.PI) / 180);
    this.controls.update();
  }

  /** Move to a named building view without changing zoom or orbit target. */
  setStandardView(view: StandardView) {
    const direction = new THREE.Vector3(...standardViewDirection(view)).normalize();
    const distance = Math.max(
      this.camera.position.distanceTo(this.controls.target),
      0.001,
    );

    this.camera.position
      .copy(this.controls.target)
      .addScaledVector(direction, distance);
    this.camera.up.set(
      0,
      Math.abs(direction.y) > 0.999 ? 0 : 1,
      direction.y > 0.999 ? -1 : direction.y < -0.999 ? 1 : 0,
    );
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    // OrbitControls normally emits `change`, but an exact preset can compare
    // equal to its last internal state. The cube still needs the authoritative
    // camera angles immediately after every face click.
    this.notifyCameraRotation();
  }

  /**
   * Call back once the camera has stopped moving.
   *
   * OrbitControls fires `end` on pointer-up, which covers drag and pinch but
   * not wheel zoom — that emits `change` with no `end` at all. So both are
   * watched and debounced together; re-rendering a basemap on every wheel tick
   * would queue a MapLibre instance per frame.
   */
  onCameraSettled(callback: () => void, quietMs = 350): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(callback, quietMs);
    };

    this.controls.addEventListener("change", schedule);
    this.controls.addEventListener("end", schedule);

    return () => {
      if (timer !== undefined) clearTimeout(timer);
      this.controls.removeEventListener("change", schedule);
      this.controls.removeEventListener("end", schedule);
    };
  }

  /**
   * Show or hide the world behind the model.
   *
   * The globe owns its own canvas and its own WebGL context; this decides
   * whether the model's canvas is transparent enough to see through, keeps the
   * two cameras in step, and opens the frustum far enough to contain a planet.
   */
  setGlobe(globe: Globe | null, origin: WgsPoint | null, northCorrection = 0) {
    this.globe = globe;
    this.globeOrigin = origin;
    this.globeNorthCorrection = northCorrection;
    globe?.setSectionPlanes(
      this.clipPlanes.map((plane) => ({
        normal: plane.normal.toArray() as Vec3,
        constant: plane.constant,
      })),
    );
    // The proxy stands in for terrain that is no longer drawn; leaving it would
    // punch an invisible hole in the model.
    if (!globe) this.setDepthProxy(null);

    // An opaque scene background would hide the globe completely, and a
    // permanently transparent one would give BCF snapshots a hole where the sky
    // should be. So it follows the globe rather than being set once.
    this.scene.background = globe
      ? null
      : new THREE.Color(this.backgroundColour);

    // A globe reaches the horizon, and the horizon is thousands of kilometres
    // away. The building-scale far plane would clip it to a disc around the
    // model — and clip any 3D tile set whose root bounding volume is
    // planet-scale before a single tile was requested.
    this.camera.far = globe ? EARTH_SCALE_FAR : this.modelFar;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Roughly how much ground the camera can see, in metres.
   *
   * Used to size the terrain occluder. Approximate on purpose: it decides how
   * far the invisible surface extends, and covering too much costs a few
   * thousand triangles nobody draws, while covering too little lets the model
   * pop through a hill at the edge of the view.
   */
  visibleGroundMetres(): number {
    const across = this.camera instanceof THREE.PerspectiveCamera
      ? 2 *
        this.camera.position.distanceTo(this.controls.target) *
        Math.tan((this.camera.fov * Math.PI) / 360) *
        this.camera.aspect
      : (this.camera.right - this.camera.left) / this.camera.zoom;
    // Floored so a close-up still gets the slope it is standing on, and capped
    // so a zoomed-out view does not ask for a continent.
    return Math.min(Math.max(across * 2, 500), 20_000);
  }

  /**
   * A depth-only surface standing in for the globe's terrain.
   *
   * The globe draws on its own canvas, and the browser composites the two by
   * alpha alone — it has no depth, so the model wins every pixel it draws,
   * including where a hillside is in front of it. Two WebGL contexts cannot
   * share a depth buffer and reading one back per frame would stall the
   * pipeline, so instead a coarse copy of the terrain lives *here*, writes
   * depth, and writes no colour. The model then occludes and is occluded
   * correctly while Cesium still draws the terrain that is actually seen.
   *
   * Invisible by construction: `colorWrite` is off. If this ever becomes
   * visible, something has changed it — it must never paint, or it would cover
   * the globe it is standing in for.
   */
  setDepthProxy(proxy: { positions: Float32Array; indices: Uint32Array } | null) {
    if (this.depthProxy) {
      this.scene.remove(this.depthProxy);
      this.depthProxy.geometry.dispose();
      (this.depthProxy.material as THREE.Material).dispose();
      this.depthProxy = null;
    }
    document.querySelector("[data-depth-proxy]")?.remove();

    if (!proxy || proxy.positions.length === 0) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(proxy.positions, 3),
    );
    geometry.setIndex(new THREE.BufferAttribute(proxy.indices, 1));
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        colorWrite: false,
        depthWrite: true,
        depthTest: true,
        clippingPlanes: this.clipPlanes,
        // Terrain is a surface, not a solid: seen from below it should still
        // occlude, or a model under an overhang pops through.
        side: THREE.DoubleSide,
      }),
    );
    // First, so everything drawn afterwards tests against it.
    mesh.renderOrder = -1000;

    this.depthProxy = mesh;
    this.scene.add(mesh);

    const marker = this.canvas.parentElement?.appendChild(
      document.createElement("div"),
    );
    if (marker) {
      marker.setAttribute("data-depth-proxy", "true");
      marker.dataset.depthTriangles = String(proxy.indices.length / 3);
      // The height range, so e2e can tell real terrain from a flat plane —
      // a proxy that is accidentally flat occludes nothing and looks fine.
      let low = Infinity;
      let high = -Infinity;
      for (let i = 1; i < proxy.positions.length; i += 3) {
        if (proxy.positions[i] < low) low = proxy.positions[i];
        if (proxy.positions[i] > high) high = proxy.positions[i];
      }
      marker.dataset.depthRelief = `${Math.round(low)}..${Math.round(high)}`;
      marker.style.display = "none";
    }
  }

  /**
   * A CityJSON context model — the neighbours, the terrain, the street.
   *
   * Separate from `setModelGeometry` on purpose. This is not a model under
   * review: it is not selectable, not in the spatial tree, not validated, and
   * not part of the federation bounds. Treating it as a model would put someone
   * else's city into the user's IDS results.
   */
  setContextGeometry(
    data: { positions: Float32Array; colours: Float32Array } | null,
    offset: Vec3 = [0, 0, 0],
  ) {
    if (this.contextMesh) {
      this.scene.remove(this.contextMesh);
      this.contextMesh.geometry.dispose();
      (this.contextMesh.material as THREE.Material).dispose();
      this.contextMesh = null;
    }
    document.querySelector("[data-context-model]")?.remove();

    if (!data || data.positions.length === 0) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(data.colours, 3));
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshLambertMaterial({
        vertexColors: true,
        // City models are surface soups rather than closed solids, so a
        // back-face cull leaves holes wherever a winding disagrees.
        side: THREE.DoubleSide,
        clippingPlanes: this.clipPlanes,
      }),
    );
    mesh.position.set(offset[0], offset[1], offset[2]);
    // Behind the model in the depth sort, so the thing being checked wins.
    mesh.renderOrder = -1;

    this.contextMesh = mesh;
    this.scene.add(mesh);

    const marker = this.canvas.parentElement?.appendChild(
      document.createElement("div"),
    );
    if (marker) {
      marker.dataset.contextModel = "true";
      marker.dataset.contextTriangles = String(data.positions.length / 9);
      marker.style.display = "none";
    }
  }

  /**
   * The viewport backdrop.
   *
   * A WebGL canvas clears to its own colour and cannot inherit the page's, so
   * without this the viewport is black in both themes. Setting
   * `scene.background` rather than making the canvas transparent keeps BCF
   * snapshots on the same backdrop — `preserveDrawingBuffer` with an alpha
   * canvas would produce PNGs with a transparent hole where the sky should be.
   */
  setBackgroundColor(colour: string) {
    // Remembered, because the globe takes the background away and putting it
    // back has to restore the theme's colour rather than a default.
    this.backgroundColour = colour;
    if (!this.globe) this.scene.background = new THREE.Color(colour);
  }

  /**
   * Viewport width ÷ height. Required on every BCF camera, and the renderer is
   * the only thing that knows the canvas' laid-out size.
   */
  get aspectRatio(): number {
    const rect = this.canvas.getBoundingClientRect();
    return rect.height > 0 ? rect.width / rect.height : 16 / 9;
  }

  setCameraState(state: ViewerCameraState) {
    if (state.projection) this.setProjection(state.projection);
    this.camera.position.set(...state.position);
    this.controls.target.set(...state.target);
    if (state.fov && this.camera instanceof THREE.PerspectiveCamera) {
      this.perspectiveFov = state.fov;
      this.camera.fov = state.fov;
    }
    if (
      state.viewHeight &&
      state.viewHeight > 0 &&
      this.camera instanceof THREE.OrthographicCamera
    ) {
      const planes = orthographicPlanes(state.viewHeight, this.aspectRatio);
      this.camera.left = planes.left;
      this.camera.right = planes.right;
      this.camera.top = planes.top;
      this.camera.bottom = planes.bottom;
      this.camera.zoom = 1;
    }
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /**
   * Apply the enabled section planes.
   *
   * The `clipPlanes` array is shared by reference with every material, so it is
   * mutated in place — replacing it would leave existing batches clipping
   * against the old array.
   */
  setSectionPlanes(
    planes: SectionPlane[],
    bounds: { min: Vec3; max: Vec3 } | null = null,
  ) {
    this.clipPlanes.length = 0;
    for (const plane of planes) {
      if (!plane.enabled) continue;
      const { normal, constant } = toClipPlane(plane);
      this.clipPlanes.push(
        new THREE.Plane(new THREE.Vector3(...normal), constant),
      );
    }
    this.renderer.localClippingEnabled = this.clipPlanes.length > 0;
    this.globe?.setSectionPlanes(
      this.clipPlanes.map((plane) => ({
        normal: plane.normal.toArray() as Vec3,
        constant: plane.constant,
      })),
    );
    this.sectionPlaneState = new Map(
      planes.map((plane) => [plane.id, { ...plane }]),
    );
    this.sectionBounds = bounds;
    this.rebuildSectionGizmos(planes, bounds);
  }

  /** Draw the cut itself plus screen-sized translation and yaw handles. */
  private rebuildSectionGizmos(
    planes: SectionPlane[],
    bounds: { min: Vec3; max: Vec3 } | null,
  ) {
    disposeObject(this.sectionGizmoGroup);
    this.sectionGizmoTargets = [];

    const diagonal = bounds
      ? Math.hypot(
          bounds.max[0] - bounds.min[0],
          bounds.max[1] - bounds.min[1],
          bounds.max[2] - bounds.min[2],
        )
      : 10;
    const planeSize = Math.max(diagonal * 0.65, 1);

    for (const plane of planes) {
      if (!plane.enabled) continue;
      const centre = new THREE.Vector3(...sectionPlaneCentre(bounds, plane));
      const direction = new THREE.Vector3(...sectionDirection(plane));
      const root = new THREE.Group();
      root.position.copy(centre);
      root.userData.sectionPlaneId = plane.id;

      const surface = new THREE.Mesh(
        new THREE.PlaneGeometry(planeSize, planeSize),
        new THREE.MeshBasicMaterial({
          color: SECTION_MOVE_COLOUR,
          transparent: true,
          opacity: 0.055,
          depthTest: false,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      surface.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        direction,
      );
      surface.renderOrder = 995;
      root.add(surface);

      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(surface.geometry),
        new THREE.LineBasicMaterial({
          color: SECTION_MOVE_COLOUR,
          transparent: true,
          opacity: 0.55,
          depthTest: false,
        }),
      );
      outline.quaternion.copy(surface.quaternion);
      outline.renderOrder = 996;
      root.add(outline);

      const move = new THREE.Group();
      move.userData.sectionHandleScale = true;
      move.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
      const moveMaterial = new THREE.MeshBasicMaterial({
        color: SECTION_MOVE_COLOUR,
        depthTest: false,
        depthWrite: false,
      });
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.035, 0.8, 12),
        moveMaterial,
      );
      shaft.position.y = 0.4;
      const head = new THREE.Mesh(
        new THREE.ConeGeometry(0.12, 0.3, 16),
        moveMaterial,
      );
      head.position.y = 0.95;
      head.userData.sectionHandleAnchor = true;
      for (const part of [shaft, head]) {
        part.userData.sectionPlaneId = plane.id;
        part.userData.sectionHandleKind = "translate";
        part.renderOrder = 1001;
        this.sectionGizmoTargets.push(part);
        move.add(part);
      }
      root.add(move);

      if (plane.axis !== "y") {
        const rotate = new THREE.Group();
        rotate.userData.sectionHandleScale = true;
        rotate.rotation.x = Math.PI / 2;
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.78, 0.045, 10, 64),
          new THREE.MeshBasicMaterial({
            color: SECTION_ROTATE_COLOUR,
            depthTest: false,
            depthWrite: false,
          }),
        );
        ring.userData.sectionPlaneId = plane.id;
        ring.userData.sectionHandleKind = "rotate";
        ring.userData.sectionHandleAnchor = true;
        ring.renderOrder = 1000;
        rotate.add(ring);
        root.add(rotate);
        this.sectionGizmoTargets.push(ring);
      }

      this.sectionGizmoGroup.add(root);
    }
    this.updateSectionGizmoScales();
  }

  /** Keep the handles usable at every zoom without scaling the plane surface. */
  private updateSectionGizmoScales() {
    if (this.canvas.clientHeight === 0) return;
    const point = new THREE.Vector3();
    this.sectionGizmoGroup.traverse((child) => {
      if (!child.userData.sectionHandleScale) return;
      child.getWorldPosition(point);
      child.scale.setScalar(this.worldPerPixelAt(point) * 72);
    });
    this.publishSectionGizmoMarkers();
  }

  /**
   * Browser tests cannot inspect a WebGL scene. Publish the first gizmo's
   * projected handle points on the viewer container so a real pointer drag can
   * exercise the same raycast path a person uses.
   */
  private publishSectionGizmoMarkers() {
    const marker = this.canvas.parentElement;
    if (!marker) return;
    marker.dataset.sectionGizmoCount = String(this.sectionGizmoGroup.children.length);
    delete marker.dataset.sectionHandleCentre;
    delete marker.dataset.sectionMoveHandle;
    delete marker.dataset.sectionRotateHandle;
    delete marker.dataset.sectionRotateTarget;

    const root = this.sectionGizmoGroup.children[0];
    if (!root) return;
    this.sectionGizmoGroup.updateMatrixWorld(true);
    const encode = (point: THREE.Vector3) => {
      const screen = this.projectPoint(point.toArray() as Vec3);
      return `${screen.x.toFixed(2)},${screen.y.toFixed(2)}`;
    };
    marker.dataset.sectionHandleCentre = encode(
      root.getWorldPosition(new THREE.Vector3()),
    );

    const move = this.sectionGizmoTargets.find(
      (target) =>
        target.userData.sectionHandleKind === "translate" &&
        target.userData.sectionHandleAnchor,
    );
    if (move) {
      marker.dataset.sectionMoveHandle = encode(
        move.getWorldPosition(new THREE.Vector3()),
      );
    }

    const rotate = this.sectionGizmoTargets.find(
      (target) =>
        target.userData.sectionHandleKind === "rotate" &&
        target.userData.sectionHandleAnchor,
    );
    if (rotate) {
      marker.dataset.sectionRotateHandle = encode(
        rotate.localToWorld(new THREE.Vector3(0, 0.78, 0)),
      );
      marker.dataset.sectionRotateTarget = encode(
        rotate.localToWorld(new THREE.Vector3(-0.78, 0, 0)),
      );
    }
  }

  private worldPerPixelAt(point: THREE.Vector3): number {
    if (this.camera instanceof THREE.PerspectiveCamera) {
      return (
        (2 *
          this.camera.position.distanceTo(point) *
          Math.tan((this.camera.fov * Math.PI) / 360)) /
        Math.max(this.canvas.clientHeight, 1)
      );
    }
    return (
      (this.camera.top - this.camera.bottom) /
      this.camera.zoom /
      Math.max(this.canvas.clientHeight, 1)
    );
  }

  private rayFromCanvas(offsetX: number, offsetY: number) {
    const rect = this.canvas.getBoundingClientRect();
    this.raycaster.setFromCamera(
      new THREE.Vector2(
        (offsetX / rect.width) * 2 - 1,
        -(offsetY / rect.height) * 2 + 1,
      ),
      this.camera,
    );
  }

  private horizontalPointerAngle(
    offsetX: number,
    offsetY: number,
    centre: THREE.Vector3,
  ): number | null {
    this.rayFromCanvas(offsetX, offsetY);
    const hit = this.raycaster.ray.intersectPlane(
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -centre.y),
      new THREE.Vector3(),
    );
    return hit ? Math.atan2(hit.z - centre.z, hit.x - centre.x) : null;
  }

  /** Start dragging a section handle. Coordinates are canvas-relative CSS pixels. */
  beginSectionGizmoDrag(offsetX: number, offsetY: number): boolean {
    if (this.sectionGizmoTargets.length === 0) return false;
    this.sectionGizmoGroup.updateMatrixWorld(true);
    this.rayFromCanvas(offsetX, offsetY);
    const hit = this.raycaster.intersectObjects(this.sectionGizmoTargets, false)[0];
    if (!hit) return false;

    const id = hit.object.userData.sectionPlaneId as string | undefined;
    const kind = hit.object.userData.sectionHandleKind as
      | "translate"
      | "rotate"
      | undefined;
    const plane = id ? this.sectionPlaneState.get(id) : undefined;
    if (!id || !kind || !plane) return false;

    const centre = new THREE.Vector3(
      ...sectionPlaneCentre(this.sectionBounds, plane),
    );
    const direction = new THREE.Vector3(...sectionDirection(plane));
    const distance = this.worldPerPixelAt(centre) * 100;
    const start = this.projectPoint(centre.toArray() as Vec3);
    const along = this.projectPoint(
      centre.clone().addScaledVector(direction, distance).toArray() as Vec3,
    );
    const screenDirection = new THREE.Vector2(
      along.x - start.x,
      along.y - start.y,
    );
    if (screenDirection.lengthSq() < 1e-6) screenDirection.set(1, 0);
    else screenDirection.normalize();

    this.sectionGizmoDrag = {
      id,
      kind,
      plane: { ...plane },
      bounds: this.sectionBounds,
      centre,
      pointerStart: new THREE.Vector2(offsetX, offsetY),
      screenDirection,
      worldPerPixel: this.worldPerPixelAt(centre),
      ringAngleStart:
        kind === "rotate"
          ? this.horizontalPointerAngle(offsetX, offsetY, centre)
          : null,
    };
    this.controls.enabled = false;
    return true;
  }

  /** Update the active section drag and return the store patch to apply. */
  updateSectionGizmoDrag(
    offsetX: number,
    offsetY: number,
  ): SectionGizmoUpdate | null {
    const drag = this.sectionGizmoDrag;
    if (!drag) return null;

    if (drag.kind === "translate") {
      const delta = new THREE.Vector2(offsetX, offsetY)
        .sub(drag.pointerStart)
        .dot(drag.screenDirection);
      const range = sectionRange(
        drag.bounds,
        drag.plane.axis,
        drag.plane.rotation,
      );
      const position = THREE.MathUtils.clamp(
        drag.plane.position + delta * drag.worldPerPixel,
        range.min,
        range.max,
      );
      return { id: drag.id, patch: { position } };
    }

    const angle = this.horizontalPointerAngle(offsetX, offsetY, drag.centre);
    const deltaDegrees =
      angle !== null && drag.ringAngleStart !== null
        ? (-normaliseRadians(angle - drag.ringAngleStart) * 180) / Math.PI
        : (offsetX - drag.pointerStart.x) * 0.5;
    const rotation = normaliseDegrees(drag.plane.rotation + deltaDegrees);
    return {
      id: drag.id,
      patch: rotateSectionPlane(drag.plane, rotation, drag.bounds),
    };
  }

  endSectionGizmoDrag() {
    this.sectionGizmoDrag = null;
    this.controls.enabled = true;
  }

  // -------------------------------------------------------------------------
  // Measurement overlay
  // -------------------------------------------------------------------------

  /**
   * Draw the measurement lines and endpoints.
   *
   * Deliberately unclipped and depth-test-free: a measurement is annotation, not
   * geometry. It must stay readable when the thing it measures is behind another
   * element or has been sectioned away, which is exactly when you want to check it.
   */
  setMeasurements(measurements: Measurement[], pending: Vec3 | null = null) {
    this.scene.remove(this.measurementGroup);
    disposeGroup(this.measurementGroup);
    this.measurementGroup = new THREE.Group();
    this.measurementGroup.renderOrder = 999;

    const points: number[] = [];
    const lines: number[] = [];
    const guides: number[] = [];

    for (const measurement of measurements) {
      lines.push(...measurement.start, ...measurement.end);
      points.push(...measurement.start, ...measurement.end);

      const corner = measurementCorner(measurement);
      if (distance(measurement.start, corner) > NEGLIGIBLE_LEG) {
        guides.push(...measurement.start, ...corner);
      }
      if (distance(corner, measurement.end) > NEGLIGIBLE_LEG) {
        guides.push(...corner, ...measurement.end);
      }
    }
    if (pending) points.push(...pending);

    if (lines.length > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(lines, 3),
      );
      this.measurementGroup.add(
        new THREE.LineSegments(
          geometry,
          new THREE.LineBasicMaterial({
            color: MEASURE_COLOUR,
            depthTest: false,
            transparent: true,
          }),
        ),
      );
    }

    if (guides.length > 0) {
      // The horizontal/vertical decomposition, dashed and faint so it reads
      // as a construction line rather than competing with the measurement
      // itself — `start → corner → end`, i.e. the plan distance then the
      // height, traced as a right angle beside the diagonal it belongs to.
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(guides, 3),
      );
      const guideLines = new THREE.LineSegments(
        geometry,
        new THREE.LineDashedMaterial({
          color: MEASURE_COLOUR,
          depthTest: false,
          transparent: true,
          opacity: 0.55,
          dashSize: 0.08,
          gapSize: 0.05,
        }),
      );
      guideLines.computeLineDistances();
      this.measurementGroup.add(guideLines);
    }

    if (points.length > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(points, 3),
      );
      this.measurementGroup.add(
        new THREE.Points(
          geometry,
          new THREE.PointsMaterial({
            color: MEASURE_COLOUR,
            size: 9,
            sizeAttenuation: false,
            depthTest: false,
            transparent: true,
          }),
        ),
      );
    }

    this.scene.add(this.measurementGroup);
  }

  /** Draw angle measurements: the two rays, an arc between them, and the three clicked points. */
  setAngleMeasurements(measurements: AngleMeasurement[], pending: Vec3[] = []) {
    this.scene.remove(this.angleGroup);
    disposeGroup(this.angleGroup);
    this.angleGroup = new THREE.Group();
    this.angleGroup.renderOrder = 999;

    const rays: number[] = [];
    const arcs: number[] = [];
    const points: number[] = [];

    for (const measurement of measurements) {
      rays.push(...measurement.vertex, ...measurement.a);
      rays.push(...measurement.vertex, ...measurement.c);
      points.push(...measurement.a, ...measurement.vertex, ...measurement.c);
      arcs.push(...angleArcPositions(measurement));
    }

    // A half-finished angle: whatever rays are already fixed are worth
    // showing, the same way a half-finished distance measurement shows its
    // one placed point (`setMeasurements`'s `pending`).
    for (let i = 0; i < pending.length; i += 1) {
      points.push(...pending[i]);
      if (i > 0) rays.push(...pending[i - 1], ...pending[i]);
    }

    if (rays.length > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(rays, 3));
      this.angleGroup.add(
        new THREE.LineSegments(
          geometry,
          new THREE.LineBasicMaterial({ color: ANGLE_COLOUR, depthTest: false, transparent: true }),
        ),
      );
    }

    if (arcs.length > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(arcs, 3));
      this.angleGroup.add(
        new THREE.LineSegments(
          geometry,
          new THREE.LineBasicMaterial({
            color: ANGLE_COLOUR,
            depthTest: false,
            transparent: true,
            opacity: 0.7,
          }),
        ),
      );
    }

    if (points.length > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
      this.angleGroup.add(
        new THREE.Points(
          geometry,
          new THREE.PointsMaterial({
            color: ANGLE_COLOUR,
            size: 9,
            sizeAttenuation: false,
            depthTest: false,
            transparent: true,
          }),
        ),
      );
    }

    this.scene.add(this.angleGroup);
  }

  /**
   * Draw area measurements: an outline with a translucent fill, plus every
   * clicked point for the "points" kind.
   *
   * "Points" fills by fan triangulation from the polygon's first vertex —
   * correct for a convex, planar polygon, and a reasonable approximation
   * otherwise. It exists to answer "is this the region I meant", not to be a
   * precise render of a possibly non-planar click sequence; `polygonArea`
   * (the number that matters) needs no triangulation and is exact
   * regardless. "Face" fills with its own real triangles instead — an exact
   * render, not an approximation, since the flood fill already produced them
   * — and has no clicked points of its own to draw.
   */
  setAreaMeasurements(measurements: AreaMeasurement[], pending: Vec3[] = []) {
    this.scene.remove(this.areaGroup);
    disposeGroup(this.areaGroup);
    this.areaGroup = new THREE.Group();
    this.areaGroup.renderOrder = 999;

    const outline: number[] = [];
    const points: number[] = [];
    const fillMeshes: THREE.BufferGeometry[] = [];

    for (const measurement of measurements) {
      if (measurement.kind === "face") {
        for (const point of facePatchOutline(measurement.triangles)) outline.push(...point);

        const fillPositions: number[] = [];
        for (const [a, b, c] of measurement.triangles) fillPositions.push(...a, ...b, ...c);
        const fillGeometry = new THREE.BufferGeometry();
        fillGeometry.setAttribute("position", new THREE.Float32BufferAttribute(fillPositions, 3));
        fillMeshes.push(fillGeometry);
        continue;
      }

      const vertices = measurement.points;
      for (let i = 0; i < vertices.length; i += 1) {
        outline.push(...vertices[i], ...vertices[(i + 1) % vertices.length]);
        points.push(...vertices[i]);
      }

      const fillPositions: number[] = [];
      for (let i = 1; i < vertices.length - 1; i += 1) {
        fillPositions.push(...vertices[0], ...vertices[i], ...vertices[i + 1]);
      }
      if (fillPositions.length > 0) {
        const fillGeometry = new THREE.BufferGeometry();
        fillGeometry.setAttribute("position", new THREE.Float32BufferAttribute(fillPositions, 3));
        fillMeshes.push(fillGeometry);
      }
    }

    for (const fillGeometry of fillMeshes) {
      this.areaGroup.add(
        new THREE.Mesh(
          fillGeometry,
          new THREE.MeshBasicMaterial({
            color: AREA_COLOUR,
            transparent: true,
            opacity: 0.25,
            depthTest: false,
            side: THREE.DoubleSide,
          }),
        ),
      );
    }

    // A half-finished area: an open polyline, not yet closed into a polygon —
    // closing it, and filling it, is what `finishAreaMeasurement` means.
    for (let i = 0; i < pending.length; i += 1) {
      points.push(...pending[i]);
      if (i > 0) outline.push(...pending[i - 1], ...pending[i]);
    }

    if (outline.length > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(outline, 3));
      this.areaGroup.add(
        new THREE.LineSegments(
          geometry,
          new THREE.LineBasicMaterial({ color: AREA_COLOUR, depthTest: false, transparent: true }),
        ),
      );
    }

    if (points.length > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
      this.areaGroup.add(
        new THREE.Points(
          geometry,
          new THREE.PointsMaterial({
            color: AREA_COLOUR,
            size: 9,
            sizeAttenuation: false,
            depthTest: false,
            transparent: true,
          }),
        ),
      );
    }

    this.scene.add(this.areaGroup);
  }

  /**
   * Draw volume measurements. Only the `"box"` kind draws anything here — a
   * wireframe of its axis-aligned corners; an `"element"` kind is already
   * visible through the entity's own selection highlight (`setSelection`),
   * set alongside the measurement itself when it is taken.
   */
  setVolumeMeasurements(measurements: VolumeMeasurement[], pendingCorner: Vec3 | null = null) {
    this.scene.remove(this.volumeGroup);
    disposeGroup(this.volumeGroup);
    this.volumeGroup = new THREE.Group();
    this.volumeGroup.renderOrder = 999;

    const edges: number[] = [];
    const points: number[] = [];

    for (const measurement of measurements) {
      if (measurement.kind !== "box") continue;
      edges.push(...boxEdgePositions(measurement.corner1, measurement.corner2));
    }

    if (pendingCorner) points.push(...pendingCorner);

    if (edges.length > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(edges, 3));
      this.volumeGroup.add(
        new THREE.LineSegments(
          geometry,
          new THREE.LineBasicMaterial({
            color: VOLUME_BOX_COLOUR,
            depthTest: false,
            transparent: true,
          }),
        ),
      );
    }

    if (points.length > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
      this.volumeGroup.add(
        new THREE.Points(
          geometry,
          new THREE.PointsMaterial({
            color: VOLUME_BOX_COLOUR,
            size: 9,
            sizeAttenuation: false,
            depthTest: false,
            transparent: true,
          }),
        ),
      );
    }

    this.scene.add(this.volumeGroup);
  }

  /**
   * Show, move or hide the snap preview — where the measurement tool's next
   * click would land, and (via `type`) which shape marks it: a square for a
   * corner, a triangle for an edge midpoint, a circle for a point on an edge.
   * A null `type` hides every marker: called on every pointer move, including
   * the common case of hovering a face with nothing within snap distance, or
   * empty space, where there is nothing to show.
   *
   * Whether it is currently showing, and which type, is mirrored onto
   * `data-snap-preview`/`data-snap-preview-type` on the canvas's marker
   * element, the same way `setEntityVisibility` reports through
   * `data-rendered-models` — a per-pointer-move value has no business
   * becoming a React state write, but a test still needs a way to ask "is
   * the marker actually there, and which shape" instead of trusting the code
   * that decided to draw it.
   */
  setSnapPreview(point: Vec3 | null, type: SnapTargetType | null) {
    const marker = document.querySelector<HTMLElement>("[data-rendered-models]");

    if (!point || !type) {
      for (const preview of Object.values(this.snapPreviewMarkers)) preview.visible = false;
      if (marker) {
        marker.dataset.snapPreview = "false";
        delete marker.dataset.snapPreviewType;
      }
      return;
    }

    for (const [previewType, preview] of Object.entries(this.snapPreviewMarkers)) {
      preview.visible = previewType === type;
    }
    const positions = this.snapPreviewMarkers[type].geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    positions.setXYZ(0, point[0], point[1], point[2]);
    positions.needsUpdate = true;
    if (marker) {
      marker.dataset.snapPreview = "true";
      marker.dataset.snapPreviewType = type;
    }
  }

  /** Screen position for a measurement's label. */
  labelPosition(measurement: Measurement): ScreenPoint {
    return this.projectPoint(midpoint(measurement));
  }

  /** Screen position for the horizontal (plan) leg's label. */
  horizontalLabelPosition(measurement: Measurement): ScreenPoint {
    return this.projectPoint(horizontalMidpoint(measurement));
  }

  /** Screen position for the vertical leg's label. */
  verticalLabelPosition(measurement: Measurement): ScreenPoint {
    return this.projectPoint(verticalMidpoint(measurement));
  }

  /** Screen position for an angle measurement's label, out along the bisector. */
  angleLabelPosition(measurement: AngleMeasurement): ScreenPoint {
    return this.projectPoint(angleLabelPoint(measurement));
  }

  /** Screen position for an area measurement's label, at the polygon's vertex average. */
  areaLabelPosition(measurement: AreaMeasurement): ScreenPoint {
    const point =
      measurement.kind === "face"
        ? facePatchCentroid(measurement.triangles)
        : polygonCentroid(measurement.points);
    return this.projectPoint(point);
  }

  /** Screen position for a volume measurement's label. */
  volumeLabelPosition(measurement: VolumeMeasurement): ScreenPoint {
    const point =
      measurement.kind === "element"
        ? measurement.centroid
        : boxCentre(measurement.corner1, measurement.corner2);
    return this.projectPoint(point);
  }

  /** PNG data URL of the current view, for BCF snapshots. */
  snapshot(): string {
    this.renderer.render(this.scene, this.camera);

    /*
      Composite the globe under the model.

      The model's canvas is transparent so the globe can show through it on
      screen (see the `alpha` option above). That makes `toDataURL` on it alone
      a mostly-transparent PNG whenever the world context is on — measured at
      2083 of 2304 sampled pixels — which renders as blank wherever a BCF
      snapshot is shown. The two canvases are separate WebGL contexts and
      cannot share a buffer, so the only way to capture what the author is
      looking at is to draw one over the other.

      With no globe the model canvas is opaque already and this is a copy.
    */
    const model = this.renderer.domElement;
    const globe = getGlobeCanvas()?.querySelector("canvas") ?? null;

    if (!globe) return model.toDataURL("image/png");

    const composite = document.createElement("canvas");
    composite.width = model.width;
    composite.height = model.height;

    const context = composite.getContext("2d");
    if (!context) return model.toDataURL("image/png");

    // The two canvases can differ in backing size — Cesium sizes its own from
    // the container, and the device pixel ratios need not agree — so the globe
    // is scaled to the model's frame rather than blitted one to one.
    context.drawImage(globe, 0, 0, composite.width, composite.height);
    context.drawImage(model, 0, 0, composite.width, composite.height);

    return composite.toDataURL("image/png");
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.setGlobe(null, null);
    this.controls.removeEventListener("change", this.notifyCameraRotation);
    this.cameraRotationListeners.clear();
    this.projectionListeners.clear();
    this.controls.dispose();
    for (const modelId of [...this.models.keys()]) this.removeModel(modelId);
    disposeGroup(this.measurementGroup);
    disposeGroup(this.angleGroup);
    disposeGroup(this.areaGroup);
    disposeGroup(this.volumeGroup);
    disposeObject(this.sectionGizmoGroup);
    for (const preview of Object.values(this.snapPreviewMarkers)) {
      preview.geometry.dispose();
      const material = preview.material as THREE.PointsMaterial;
      material.map?.dispose();
      material.dispose();
    }
    this.renderer.dispose();
  }
}

function normaliseRadians(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function normaliseDegrees(value: number): number {
  const normalised = ((value + 180) % 360 + 360) % 360 - 180;
  return normalised === -180 ? 180 : normalised;
}

/** Release the geometries and materials of an overlay group. */
function disposeGroup(group: THREE.Group) {
  for (const child of group.children) {
    const drawable = child as THREE.Mesh | THREE.Line | THREE.Points;
    drawable.geometry?.dispose();
    const material = drawable.material as THREE.Material | THREE.Material[];
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
  }
  group.clear();
}

/** Dispose a nested helper, including sprite textures. */
function disposeObject(root: THREE.Object3D) {
  root.traverse((child) => {
    const drawable = child as THREE.Mesh | THREE.Line | THREE.Points | THREE.Sprite;
    drawable.geometry?.dispose();
    const material = drawable.material as
      | (THREE.Material & { map?: THREE.Texture | null })
      | Array<THREE.Material & { map?: THREE.Texture | null }>
      | undefined;
    const disposeMaterial = (item: THREE.Material & { map?: THREE.Texture | null }) => {
      item.map?.dispose();
      item.dispose();
    };
    if (Array.isArray(material)) material.forEach(disposeMaterial);
    else if (material) disposeMaterial(material);
  });
  root.clear();
}
