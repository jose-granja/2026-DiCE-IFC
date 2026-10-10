"use client";

/**
 * A real globe under the model, drawn by CesiumJS.
 *
 * ## Why this replaced the textured ground plane
 *
 * The basemap used to be one MapLibre image stretched over the ground the
 * camera could see. Three complaints followed from that single decision, and
 * none of them were tunable:
 *
 * - **Resolution changed with the view.** One texture over a view that spans
 *   200 m or 300 km is hundreds of metres per pixel at the wide end.
 * - **It covered "a little part of the map".** A flat square sized from the
 *   camera runs out before the screen does, especially near the horizon.
 * - **The model looked a different size at different zooms**, because it was
 *   being read against a picture that rescaled underneath it.
 *
 * A globe has none of those properties: imagery and terrain are tiled at the
 * level the view needs, they extend to the horizon because they *are* the
 * planet, and a metre is always a metre. This is the same approach ifclite
 * takes, and the reason its map behaves the way you expect.
 *
 * ## How the two renderers share a screen
 *
 * Cesium draws to its own canvas, underneath the three.js canvas, and the two
 * cameras are kept in step every frame. The model canvas is transparent, so the
 * globe shows through wherever there is no geometry.
 *
 * They do **not** share a depth buffer — that would mean one WebGL context, and
 * neither library will give up its own. So the model always draws over the
 * globe rather than being occluded by terrain in front of it. For a building on
 * its site, which is what this view is for, that is the right compromise: the
 * alternative is depth-fighting between two independently-scaled projections.
 *
 * ## Frames
 *
 * three.js works in a local frame at the model — Y up, −Z north. Cesium works
 * in ECEF. The bridge is the east-north-up frame at the model's own
 * coordinates, the same one `tiles3d.ts` used and
 * `__tests__/tiles3d-frame.test.ts` pins:
 *
 *   render → (rotate +90° X) → ENU → (ENU frame at model) → ECEF
 *
 * Applied to the *camera* here rather than to the scene, because Cesium owns
 * the earth and cannot be moved to us; we go to it. The model stays at the
 * render origin where float32 has precision to spare.
 */

import * as THREE from "three";

import { ensureEgm96Grid, toEllipsoidalHeight, type Egm96Grid } from "@/lib/georef/geoid";
import type { WgsPoint } from "@/lib/georef/transform";

export const CESIUM_ION_API = "https://api.cesium.com";
export const CESIUM_ION_ASSETS = "https://assets.ion.cesium.com";
export const GOOGLE_TILES_ORIGIN = "https://tile.googleapis.com";

/** What the globe should show under the model. */
export type GlobeLayer =
  | { kind: "terrain" }
  | { kind: "osm-buildings" }
  | { kind: "google-photorealistic" }
  | { kind: "ion-asset"; assetId: string }
  | { kind: "tileset-url"; url: string };

export type DepthProxy = {
  /** Triangle vertices in render space. */
  positions: Float32Array;
  indices: Uint32Array;
};

/** A section plane in the viewer's render coordinate frame. */
export type GlobeSectionPlane = {
  normal: [number, number, number];
  constant: number;
};

export type Globe = {
  /**
   * A depth-only surface matching the terrain, for the model to test against.
   *
   * Returns null when the terrain is flat or unavailable, which is the
   * ellipsoid case and needs no proxy.
   */
  sampleDepthProxy: (
    origin: WgsPoint,
    metresAcross: number,
    northCorrection?: number,
  ) => Promise<DepthProxy | null>;
  /** Keep Cesium's camera on the three.js one. Called every frame. */
  sync: (
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    origin: WgsPoint,
    northCorrection?: number,
  ) => void;
  /** Apply the viewer's render-space section planes to terrain and 3D Tiles. */
  setSectionPlanes: (planes: GlobeSectionPlane[]) => void;
  /** Swap what is drawn. Rejects with a message fit to show the user. */
  setLayer: (layer: GlobeLayer) => Promise<void>;
  /** Required by ion's and Google's terms wherever their data is shown. */
  getAttribution: () => string;
  /** For e2e: whether the globe has drawn anything yet. */
  isReady: () => boolean;
  dispose: () => void;
};

export function ionConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN);
}

/** Whether the "terrain" layer will also carry MapTiler's OSM imagery. */
export function mapTilerConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_MAPTILER_KEY);
}

/**
 * ENU → render is a −90° turn about X, so render → ENU is +90°.
 * Kept as a constant because it is applied on every frame.
 */
const RENDER_TO_ENU = new THREE.Matrix4().makeRotationX(Math.PI / 2);

/**
 * Build the globe on `canvas`.
 *
 * Cesium is imported here rather than at module scope: it is several megabytes
 * for a feature that is off unless a token is configured, and a static import
 * puts all of it in the viewer's bundle for every deployment.
 */
/*
  KNOWN GAP — the globe does not draw yet.
  ======================================

  Everything up to the last step works and has been measured: the widget is
  constructed, its canvas is sized to the viewport, ion authenticates, the
  terrain and imagery asset endpoints answer 200, the terrain root tiles are
  fetched, the decode workers start, the camera lands on the model's real
  coordinates, and no error is raised — Cesium's own error panel is absent too.

  What does not happen is tile *selection*: `globe._surface._tilesToRender`
  stays empty, so nothing is drawn and the canvas holds one colour.

  Ruled out by measurement, so that the next attempt does not repeat them:

  - **Knockout and the CSP.** `CesiumWidget` lives in `@cesium/engine`, not
    `@cesium/widgets`, and there is no Knockout in the engine at all. The
    earlier hand-rolled `Scene` existed to avoid a problem that was not there.
  - **Canvas sizing.** Was a real bug — the widget stylesheet was not being
    shipped, so the canvas kept the HTML default of 300×150. Fixed in
    `app/globals.css`.
  - **The camera sync.** Disabling it entirely and leaving Cesium's own default
    camera — which looks at the whole earth from 28 000 km — still selects zero
    tiles. So the transform is not the cause.
  - **A swallowed render error.** No `.cesium-widget-errorPanel` is created.

  Since then, validated in the project's own Docker dev container rather than a
  sandbox, which narrowed it further:

  - **Cesium renders.** Its star field draws, so the widget, its canvas, its
    WebGL context and its render loop are all working. Only the *globe surface*
    is missing — the model floats in space.
  - **The camera sync is not the cause.** Disabling it and leaving Cesium's own
    default camera still selects zero tiles.
  - **The frustum is suspicious.** `near` reads 0.1 and `far` 1e10 where
    Cesium's own defaults are 1.0 and 5e8 — a range ratio of 1e11. Nothing here
    sets those on Cesium's camera, so working out what does is the next thread
    to pull: a degenerate frustum would explain a quadtree that selects nothing
    while everything else about the scene works.
*/
export async function createGlobe(container: HTMLElement): Promise<Globe> {
  const token = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN ?? "";

  // Kicked off now, awaited just before it is first needed: a 130 KB
  // same-origin fetch that should resolve well before Cesium itself
  // finishes loading, so it costs nothing on the critical path.
  const geoidGridPromise = ensureEgm96Grid();

  // Cesium fetches workers and imagery by URL at runtime; without this it
  // looks for them at the page root and fails with a missing-worker error that
  // names nothing useful. `scripts/copy-cesium-assets.mts` puts them here.
  (window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL =
    "/cesium/";

  /*
    Loaded by URL, not bundled.

    `import("cesium")` makes the bundler transform Cesium's ESM source, and the
    result is a script the browser will not parse: "Octal escape sequences are
    not allowed in template strings", thrown before any of our code runs. The
    source itself is fine — Node imports it without complaint — so this is the
    transform, not the library.

    `turbopackIgnore` leaves the specifier alone so the browser fetches Cesium's
    own prebuilt bundle, which is what `scripts/copy-cesium-assets.mts` puts in
    `public/cesium/`. It also keeps ~4.8 MB out of the app's own bundle.
  */
  // `turbopackIgnore` leaves the specifier alone so the browser fetches
  // Cesium's own prebuilt bundle. Types come from `types/cesium-runtime.d.ts`,
  // which maps this URL onto the package's surface — an untyped `any` here
  // would hide every real mistake in the code below.
  //
  // Deliberately not `new Function("import(...)")`: that dodges the bundler
  // too, and is refused by our own Content-Security-Policy, which does not
  // allow `unsafe-eval`. It should not, and the workaround was the bug.
  /*
    `@cesium/engine`, not `cesium`.

    The full package bundles Knockout for its widgets, and Knockout compiles its
    bindings with `new Function` **at import time**. That needs `unsafe-eval` in
    `script-src`, and this application signs documents with a smart card —
    granting the whole app the right to evaluate strings as code so a basemap
    can draw is not a trade worth making. Our own CSP refuses it, which is how
    this was found.

    The engine package is the same library without the widgets: `Scene`,
    `Globe`, `Cesium3DTileset`, `Ion` and the maths, with zero `new Function`
    calls. Nothing here wanted a widget anyway — the model viewer owns
    navigation.

    Imported dynamically so several megabytes stay out of the viewer's bundle
    for every deployment that has no ion token.
  */
  // A plain string literal with the magic comment is the only form the bundler
  // leaves alone — a cast or a variable makes it emit a runtime resolver that
  // our own CSP then blocks for using `eval`.
  //
  // @ts-expect-error — a served URL, not a module the compiler resolves. Its
  // shape is asserted on the next line.
  const loaded = await import(/* turbopackIgnore: true */ "/cesium/engine.js");
  const Cesium = loaded as typeof import("cesium-engine-runtime");

  if (token) Cesium.Ion.defaultAccessToken = token;

  /*
    `CesiumWidget`, from `@cesium/engine`.

    An earlier attempt drove a bare `Scene` by hand, on the belief that the
    widget lived in `@cesium/widgets` and dragged in Knockout — which compiles
    its bindings with `new Function` and is refused by this application's CSP.
    That belief was wrong: `CesiumWidget` ships **in the engine package**, and
    there is no Knockout anywhere in it.

    The cost of the wrong belief was a globe that authenticated, positioned its
    camera correctly, fetched its terrain root tiles and then rendered nothing,
    because a hand-rolled render loop does not do everything the widget does —
    `_tilesToRender` stayed empty, so the quadtree never refined.

    The widget owns its own render loop; `sync` only moves its camera.
  */
  // Cesium writes its attributions here; read back by `getAttribution`.
  const credits = document.createElement("div");
  credits.style.display = "none";

  const widget = new Cesium.CesiumWidget(container, {
    // No base imagery of its own: the layer is chosen in `setLayer` so that
    // "terrain only" and "imagery" are distinguishable.
    baseLayer: false,
    // Cesium writes its attributions into this element. Kept and read back:
    // ion's terms require the credits to be visible wherever its data is.
    creditContainer: credits,
    // The model viewer owns navigation, so Cesium's own controls are off and
    // its camera is driven from three.js every frame.
    scene3DOnly: true,
    contextOptions: {
      webgl: {
        // Without this the globe's drawing buffer is cleared before anything
        // can read it, and a BCF snapshot composited from it comes out blank
        // — the model's own canvas has the same option for the same reason.
        preserveDrawingBuffer: true,
      },
    },
  });

  const scene = widget.scene;
  scene.screenSpaceCameraController.enableInputs = false;
  scene.backgroundColor = Cesium.Color.TRANSPARENT;
  scene.globe.depthTestAgainstTerrain = true;
  const globeClippingPlanes = new Cesium.ClippingPlaneCollection({
    enabled: false,
    // Match three.js local clipping: a point outside any enabled plane is cut.
    unionClippingRegions: true,
  });
  scene.globe.clippingPlanes = globeClippingPlanes;

  /*
    Base imagery: MapTiler's OpenStreetMap raster style, opt-in.

    `Cesium.ImageryLayer.fromWorldImagery({})` — Bing Maps Aerial, fetched
    straight from `dev.virtualearth.net` — used to be here. That origin was
    never in the CSP and was never getting an ADR just to draw a base
    texture (see ADR 003). The obvious next thought, matching
    bedrock-engineer/ifc-georeferencer's approach, is OSM's own public tile
    server — but ADR 003's original context already rejected that
    specifically: "its usage policy forbids production application use."
    Reversing that would need its own ADR amendment, not a config tweak.

    `api.maptiler.com` is already a conditional CSP origin for exactly this
    key (`NEXT_PUBLIC_MAPTILER_KEY`, see `proxy.ts`), and MapTiler serves an
    "openstreetmap" raster style built for production use. With no key set,
    `api.maptiler.com` is absent from the CSP and this layer is skipped —
    the "terrain" layer stays terrain-shaded geometry only, same as without
    a key.
  */
  const mapTilerKey = process.env.NEXT_PUBLIC_MAPTILER_KEY ?? "";
  if (mapTilerKey) {
    try {
      const osmImagery = new Cesium.UrlTemplateImageryProvider({
        url: `https://api.maptiler.com/maps/openstreetmap/{z}/{x}/{y}.png?key=${mapTilerKey}`,
        credit: "© MapTiler © OpenStreetMap contributors",
        maximumLevel: 19,
      });
      scene.imageryLayers.add(new Cesium.ImageryLayer(osmImagery));
    } catch {
      // Imagery is the nicety; terrain and tilesets are the substance.
    }
  }

  type TilesetWithClipOrigin = InstanceType<typeof Cesium.Cesium3DTileset> & {
    /** Cesium's object frame used before a collection's additional matrix. */
    readonly clippingPlanesOriginMatrix: InstanceType<typeof Cesium.Matrix4>;
  };

  let current: { primitive: TilesetWithClipOrigin } | null = null;
  let ready = false;
  /** What is showing, for the attribution line. */
  let layerKind: GlobeLayer["kind"] = "terrain";
  let sectionPlanes: GlobeSectionPlane[] = [];
  let renderToEcefForClipping: InstanceType<typeof Cesium.Matrix4> | null = null;

  const removeCurrent = () => {
    if (current?.primitive) {
      scene.primitives.remove(current.primitive as object);
    }
    current = null;
  };

  const geoidGrid: Egm96Grid | null = await geoidGridPromise;

  /**
   * `origin.height` is orthometric (see `lib/georef/geoid.ts`); every Cesium
   * call in this module wants ellipsoidal. Converting at the one place both
   * `sync` and `sampleDepthProxy` anchor their ENU frame keeps that
   * distinction from leaking into the rest of the module.
   */
  const anchorHeight = (origin: WgsPoint): number =>
    toEllipsoidalHeight(geoidGrid, origin.latitude, origin.longitude, origin.height ?? 0);

  /**
   * `RENDER_TO_ENU` alone assumes the render frame's −Z is *true* north.
   * `lib/viewer/federation.ts` rotates a georeferenced model's own geometry
   * to align −Z with **grid** north instead (needed so several federated
   * models, each declaring a different grid rotation, land in one shared
   * frame). The two norths differ by the grid convergence at the anchor —
   * `northCorrection`, from `lib/georef/transform.ts#gridConvergence` — so an
   * extra yaw of `-northCorrection` closes the gap before the fixed ENU
   * rotation. Zero at a CRS's central meridian, a fraction of a degree at
   * most projected-CRS anchors, up to several degrees for an oblique one.
   */
  const renderToEnu = (northCorrection: number): THREE.Matrix4 =>
    RENDER_TO_ENU.clone().multiply(
      new THREE.Matrix4().makeRotationY(-northCorrection),
    );

  const fillClippingPlanes = (
    collection: InstanceType<typeof Cesium.ClippingPlaneCollection>,
  ) => {
    collection.removeAll();
    for (const plane of sectionPlanes) {
      collection.add(
        new Cesium.ClippingPlane(
          new Cesium.Cartesian3(...plane.normal),
          plane.constant,
        ),
      );
    }
    collection.enabled = sectionPlanes.length > 0;
  };

  const createTilesetClippingPlanes = () => {
    const collection = new Cesium.ClippingPlaneCollection({
      unionClippingRegions: true,
    });
    fillClippingPlanes(collection);
    return collection;
  };

  /**
   * Put render-space planes into the world frame used by each Cesium object.
   * The globe accepts ECEF directly. A tileset first applies its own clipping
   * origin matrix, so its collection receives the relative transform that
   * makes the combined result the same render→ECEF matrix.
   */
  const updateClippingTransforms = () => {
    if (!renderToEcefForClipping) return;
    Cesium.Matrix4.clone(
      renderToEcefForClipping,
      globeClippingPlanes.modelMatrix,
    );

    const tileset = current?.primitive;
    if (!tileset) return;
    const inverseOrigin = Cesium.Matrix4.inverse(
      tileset.clippingPlanesOriginMatrix,
      new Cesium.Matrix4(),
    );
    Cesium.Matrix4.multiply(
      inverseOrigin,
      renderToEcefForClipping,
      tileset.clippingPlanes.modelMatrix,
    );
  };

  const addTileset = (tileset: InstanceType<typeof Cesium.Cesium3DTileset>) => {
    const primitive = scene.primitives.add(tileset) as TilesetWithClipOrigin;
    primitive.clippingPlanes = createTilesetClippingPlanes();
    current = { primitive };
    updateClippingTransforms();
  };

  return {
    sync(camera, origin, northCorrection = 0) {
      // render → ECEF for this model's location.
      const enuToEcef = Cesium.Transforms.eastNorthUpToFixedFrame(
        Cesium.Cartesian3.fromDegrees(
          origin.longitude,
          origin.latitude,
          anchorHeight(origin),
        ),
      );

      const renderToEcefCesium = Cesium.Matrix4.multiply(
        enuToEcef,
        Cesium.Matrix4.fromArray(renderToEnu(northCorrection).toArray()),
        new Cesium.Matrix4(),
      );
      renderToEcefForClipping = renderToEcefCesium;
      updateClippingTransforms();

      const renderToEcef = new THREE.Matrix4().fromArray(
        Cesium.Matrix4.toArray(renderToEcefCesium) as number[],
      );

      const position = camera.position.clone().applyMatrix4(renderToEcef);

      // Directions take the rotation only — a translation would move a
      // direction, which is how a synced camera ends up pointing at the ground.
      const rotation = new THREE.Matrix3().setFromMatrix4(renderToEcef);
      const direction = new THREE.Vector3(0, 0, -1)
        .applyQuaternion(camera.quaternion)
        .applyMatrix3(rotation)
        .normalize();
      const up = new THREE.Vector3(0, 1, 0)
        .applyQuaternion(camera.quaternion)
        .applyMatrix3(rotation)
        .normalize();

      scene.camera.setView({
        destination: new Cesium.Cartesian3(position.x, position.y, position.z),
        orientation: {
          direction: new Cesium.Cartesian3(
            direction.x,
            direction.y,
            direction.z,
          ),
          up: new Cesium.Cartesian3(up.x, up.y, up.z),
        },
      });

      if (camera instanceof THREE.OrthographicCamera) {
        if (!(scene.camera.frustum instanceof Cesium.OrthographicFrustum)) {
          scene.camera.frustum = new Cesium.OrthographicFrustum();
        }
        const frustum = scene.camera.frustum as InstanceType<
          typeof Cesium.OrthographicFrustum
        >;
        frustum.width = (camera.right - camera.left) / camera.zoom;
        frustum.aspectRatio =
          (camera.right - camera.left) / (camera.top - camera.bottom);
        frustum.near = camera.near;
        frustum.far = camera.far;
      } else {
        if (!(scene.camera.frustum instanceof Cesium.PerspectiveFrustum)) {
          scene.camera.frustum = new Cesium.PerspectiveFrustum();
        }
        // three.js `fov` is vertical; Cesium's `fov` is horizontal whenever
        // the viewport is wider than it is tall. Passing one as the other is a
        // mismatch visible as the globe sliding against the model on resize.
        const frustum = scene.camera.frustum as InstanceType<
          typeof Cesium.PerspectiveFrustum
        >;
        const vertical = (camera.fov * Math.PI) / 180;
        frustum.aspectRatio = camera.aspect;
        frustum.fov =
          camera.aspect >= 1
            ? 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect)
            : vertical;
        frustum.near = camera.near;
        frustum.far = camera.far;
      }

      // No `scene.render()` here: the widget runs its own loop. Calling it
      // as well renders the frame twice and fights the widget's own timing.




      ready = true;
    },

    setSectionPlanes(planes) {
      sectionPlanes = planes.map((plane) => ({
        normal: [...plane.normal],
        constant: plane.constant,
      }));
      fillClippingPlanes(globeClippingPlanes);
      if (current) fillClippingPlanes(current.primitive.clippingPlanes);
      updateClippingTransforms();
    },

    async setLayer(layer) {
      removeCurrent();
      layerKind = layer.kind;

      /*
        Terrain goes on the globe, not through `scene.setTerrain`.

        `setTerrain` was tried first and wrapped in a `try`/`catch` so a terrain
        problem could not take the imagery with it. That was the wrong
        instinct: the catch swallowed the very failure that left the globe with
        no terrain provider and therefore no tiles to ask for, which looked
        like "Cesium fetches data and draws nothing". Assigning the provider
        directly is both simpler and loud when it fails.

        OSM Buildings carries footprints and heights but no ground, and ion
        positions each building on Cesium World Terrain. Over the bare
        ellipsoid they float or sink by the local relief, so that layer gets
        the same terrain as "terrain" does.
      */
      scene.globe.terrainProvider =
        (layer.kind === "terrain" || layer.kind === "osm-buildings") && token
          ? await Cesium.CesiumTerrainProvider.fromIonAssetId(1)
          : new Cesium.EllipsoidTerrainProvider();

      switch (layer.kind) {
        case "terrain":
          break;

        case "osm-buildings": {
          const tileset = await Cesium.createOsmBuildingsAsync();
          addTileset(tileset);
          break;
        }

        case "google-photorealistic": {
          // `onlyUsingWithGoogleGeocoder` is deliberately not passed. It is a
          // confirmation that the tiles will only ever be shown alongside
          // Google's geocoder, which is not what this does — asserting it would
          // be a false statement about our own usage.
          const tileset = await Cesium.createGooglePhotorealistic3DTileset();
          addTileset(tileset);
          break;
        }

        case "ion-asset": {
          const id = Number(layer.assetId);
          if (!Number.isFinite(id) || id <= 0) {
            throw new Error(
              `“${layer.assetId}” is not a Cesium ion asset ID. It is the number shown in your ion asset list.`,
            );
          }
          const tileset = await Cesium.Cesium3DTileset.fromIonAssetId(id);
          addTileset(tileset);
          break;
        }

        case "tileset-url": {
          const tileset = await Cesium.Cesium3DTileset.fromUrl(layer.url);
          addTileset(tileset);
          break;
        }
      }
    },

    async sampleDepthProxy(origin, metresAcross, northCorrection = 0) {
      /*
        Why this exists.

        The globe and the model are two WebGL canvases, composited by the
        browser. The browser blends by alpha and knows nothing about depth, so
        the model draws over the terrain even when a hillside is in front of
        it — the compromise recorded at the top of this file, and a wrong
        picture when a building sits in a slope.

        Sharing a depth buffer across two contexts is not possible, and reading
        one back per frame would stall the pipeline. So the visible surface is
        sampled once into a coarse mesh that lives in the *three.js* scene and
        writes depth without writing colour. The model then occludes and is
        occluded correctly, while Cesium still draws whatever is actually seen.

        Cesium has two different height paths and they are not interchangeable:

        - `sampleTerrainMostDetailed` reads the globe terrain provider;
        - `clampToHeightMostDetailed` ray-picks rendered 3D Tiles.

        The old implementation used only the second path. On the terrain and
        imagery layer every sample therefore came back undefined and this
        function returned null, leaving the IFC with no depth occluder at all.
        Select the source that corresponds to the active layer instead.

        Coarse on purpose: this is an occluder, not the picture. A 48×48 grid
        over the visible ground is a few thousand triangles and resolves the
        "behind that hill/building" question, which is the one being asked.
      */
      const steps = 48;
      const half = metresAcross / 2;

      // Degrees per metre at this latitude — good enough over a few kilometres,
      // and the samples are only used to build an occluder.
      const metresPerDegreeLat = 111_132;
      const metresPerDegreeLon =
        metresPerDegreeLat * Math.cos((origin.latitude * Math.PI) / 180);

      const locations: Array<{ longitude: number; latitude: number }> = [];
      for (let row = 0; row <= steps; row += 1) {
        for (let column = 0; column <= steps; column += 1) {
          const north = -half + (metresAcross * row) / steps;
          const east = -half + (metresAcross * column) / steps;
          locations.push({
            longitude: origin.longitude + east / metresPerDegreeLon,
            latitude: origin.latitude + north / metresPerDegreeLat,
          });
        }
      }

      let surface: Array<InstanceType<typeof Cesium.Cartesian3> | undefined>;

      if (layerKind === "terrain") {
        try {
          const sampled = await Cesium.sampleTerrainMostDetailed(
            scene.globe.terrainProvider,
            locations.map(({ longitude, latitude }) =>
              Cesium.Cartographic.fromDegrees(longitude, latitude),
            ),
          );
          surface = sampled.map((point) =>
            Number.isFinite(point.height)
              ? Cesium.Cartesian3.fromRadians(
                  point.longitude,
                  point.latitude,
                  point.height,
                )
              : undefined,
          );
        } catch {
          return null;
        }
      } else {
        if (!scene.clampToHeightSupported) return null;

        // Cast from comfortably above anything the scene could render here —
        // terrain relief and the tallest realistic building both fit inside
        // 5 km — down onto the active 3D Tiles surface.
        const startHeight = anchorHeight(origin) + 5000;
        const castStarts = locations.map(({ longitude, latitude }) =>
          Cesium.Cartesian3.fromDegrees(longitude, latitude, startHeight),
        );
        try {
          surface = await scene.clampToHeightMostDetailed(castStarts);
        } catch {
          return null;
        }
        if (surface.every((point) => point === undefined)) return null;
      }

      // Same frame as everything else: ECEF → east-north-up at the model →
      // render, which `__tests__/tiles3d-frame.test.ts` pins.
      const enuToEcef = Cesium.Transforms.eastNorthUpToFixedFrame(
        Cesium.Cartesian3.fromDegrees(
          origin.longitude,
          origin.latitude,
          anchorHeight(origin),
        ),
      );
      const ecefToEnu = Cesium.Matrix4.inverse(enuToEcef, new Cesium.Matrix4());
      // Inverse of the render→ENU rotation `sync` uses, so a rotated model
      // (`northCorrection !== 0`) gets an occluder mesh built in the same
      // frame it renders in, rather than one still assuming render −Z is
      // exactly true north.
      const enuToRender = renderToEnu(northCorrection).clone().invert();

      const positions = new Float32Array((steps + 1) * (steps + 1) * 3);
      const enuVector = new THREE.Vector3();

      surface.forEach((point, index) => {
        // A gap in the sampled layer (e.g. the street between two OSM
        // buildings) — hold it at the anchor's own height rather than
        // punching a hole or spiking the mesh into the point that started
        // the cast. Keep a separate fallback because Cesium mutates a failed
        // clamp input entry to `undefined`.
        const location = locations[index]!;
        const resolved =
          point ??
          Cesium.Cartesian3.fromDegrees(
            location.longitude,
            location.latitude,
            anchorHeight(origin),
          );
        const local = Cesium.Matrix4.multiplyByPoint(
          ecefToEnu,
          resolved,
          new Cesium.Cartesian3(),
        );
        const up = point ? local.z : 0;
        enuVector.set(local.x, local.y, up).applyMatrix4(enuToRender);
        positions[index * 3] = enuVector.x;
        positions[index * 3 + 1] = enuVector.y;
        positions[index * 3 + 2] = enuVector.z;
      });

      const indices = new Uint32Array(steps * steps * 6);
      let cursor = 0;
      for (let row = 0; row < steps; row += 1) {
        for (let column = 0; column < steps; column += 1) {
          const a = row * (steps + 1) + column;
          const b = a + 1;
          const c = a + steps + 1;
          const d = c + 1;
          indices[cursor++] = a;
          indices[cursor++] = c;
          indices[cursor++] = b;
          indices[cursor++] = b;
          indices[cursor++] = c;
          indices[cursor++] = d;
        }
      }

      return { positions, indices };
    },

    getAttribution() {
      /*
        Named from the layer rather than read out of Cesium.

        The first attempt reached into `frameState.creditDisplay` for the live
        credit list and threw `t.values is not a function` on every frame — the
        internal shape is not what it looked like, and guessing at a private
        structure to satisfy a licensing requirement is the wrong way round.

        These are the providers this code can actually select, so naming them
        is both accurate and stable. ion's and Google's terms require the
        attribution to be visible wherever their data is shown; the panel
        renders whatever this returns.
      */
      const parts = ["© Cesium ion"];
      if (layerKind === "osm-buildings") parts.push("© OpenStreetMap contributors");
      if (layerKind === "google-photorealistic") parts.push("© Google");
      if (layerKind === "terrain" || layerKind === "osm-buildings") {
        parts.push("terrain via Cesium ion");
        if (mapTilerKey) parts.push("© MapTiler © OpenStreetMap contributors");
      }
      return parts.join(" · ");
    },

    isReady: () => ready,

    dispose() {
      removeCurrent();
      widget.destroy();
    },
  };
}
