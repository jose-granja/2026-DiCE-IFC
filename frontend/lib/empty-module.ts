/**
 * An empty module, aliased in place of `laz-perf` in the browser bundle.
 *
 * `@ifc-lite/pointcloud` reaches `laz-perf` through a dynamic import, guarded so
 * it only runs when a LAS/LAZ point cloud is decoded — which this app never
 * does: it handles IFC, BCF and IDS. Turbopack still traces the target, and
 * laz-perf's emscripten loader imports the bare specifiers `env` and
 * `wasi_snapshot_preview1`. Those are the import objects a WASI host supplies at
 * instantiation time, not modules, so no bundler can resolve them and Next 16
 * fails the build rather than emitting a broken chunk.
 *
 * Stubbing the package keeps the loader out of the module graph. This is safe
 * only while nothing decodes point clouds, and it fails loudly rather than
 * silently if that changes: the guarded call site would find no
 * `createLazPerf` export and throw. If point-cloud support is ever wanted,
 * remove this alias and give the loader a real WASI shim.
 *
 * See next.config.ts `turbopack.resolveAlias`, and the Next 16 upgrade guide's
 * "Resolve alias fallback" section.
 */

const emptyModule = {};

export default emptyModule;
