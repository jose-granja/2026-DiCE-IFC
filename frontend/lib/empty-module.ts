/**
 * An empty module, aliased in place of `laz-perf` in the browser bundle.
 *
 * `@ifc-lite/pointcloud` reaches `laz-perf` through a dynamic import, in the
 * LAZ reader it ships. Turbopack traces the target, and laz-perf's emscripten
 * loader imports the bare specifiers `env` and `wasi_snapshot_preview1`. Those
 * are the import objects a WASI host supplies at instantiation time, not
 * modules, so no bundler can resolve them and Next 16 fails the build rather
 * than emitting a broken chunk.
 *
 * Stubbing the package keeps the loader out of the module graph. The package's
 * own LAZ reader is therefore dead here and would fail loudly (no
 * `createLazPerf` export) if anything called it. `lib/pointcloud/laz.ts` is the
 * LAZ reader that is used: it loads a build of laz-perf that
 * `scripts/copy-cesium-assets.mts` bundles into `public/laz-perf/`, the same
 * way SQLite and Cesium are served.
 *
 * See next.config.ts `turbopack.resolveAlias`, and the Next 16 upgrade guide's
 * "Resolve alias fallback" section.
 */

const emptyModule = {};

export default emptyModule;
