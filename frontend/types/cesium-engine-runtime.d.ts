/**
 * The Cesium engine, as served rather than as bundled.
 *
 * `scripts/copy-cesium-assets.mts` bundles `@cesium/engine` with esbuild into
 * `public/cesium/engine.js`, and `lib/viewer/globe.ts` loads that by URL. Two
 * problems force it: Turbopack's transform of Cesium's source produces a script
 * the browser will not parse, and the published `cesium` bundle carries
 * Knockout, which needs `unsafe-eval`.
 *
 * TypeScript still needs the shape, and it is exactly the package's own
 * surface — without this the import is `any` and every mistake in the globe
 * code goes unchecked.
 */
declare module "cesium-engine-runtime" {
  export * from "@cesium/engine";
}
