/**
 * Put Cesium's runtime assets where the browser can fetch them.
 *
 * CesiumJS is not self-contained the way an ordinary npm package is. At runtime
 * it fetches Web Workers, imagery, glTF/Draco decoders and widget CSS from
 * whatever `window.CESIUM_BASE_URL` points at. A bundler cannot inline those —
 * they are fetched by URL, not imported — so they have to be served as static
 * files or Cesium fails at the moment a globe is first drawn, with errors that
 * name a missing worker rather than a missing configuration.
 *
 * Same shape as `copy-maplibre-worker.mts`, and for the same reason: a runtime
 * asset that a bundler cannot see has to be copied deliberately.
 *
 * Copied rather than committed — it is ~23 MB of generated vendor output, and
 * `public/cesium/` is gitignored.
 */

/*
  esbuild is a `dependency`, not a `devDependency`, despite being a build tool.

  This script runs from `prebuild`, and the environments that run it declare
  themselves production — `.env.dev` sets `NODE_ENV=production` and compose
  passes it in, which makes npm skip devDependencies altogether. A build-time
  tool that is absent at build time is not a tool. Verified: with
  `NODE_ENV=production`, `npm install` installs `@cesium/engine` and skips
  `esbuild`.
*/
import { build } from "esbuild";

import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * What Cesium actually asks for at runtime.
 *
 * `Workers` does tile decoding off the main thread; `Assets` holds the default
 * imagery and the star field;
 * `ThirdParty` holds the Draco and Basis decoders that compressed 3D Tiles
 * need. Dropping any of them produces a globe that half-works.
 */
const DIRECTORIES = [
  // Where the engine package keeps each of them differs: the decoders and
  // workers are prebuilt, the imagery and star field are shipped as source.
  { from: ["Build", "ThirdParty"], to: "ThirdParty" },
  { from: ["Build", "Workers"], to: "Workers" },
  { from: ["Source", "Assets"], to: "Assets" },
];

// The engine package, not `cesium`: the full one bundles Knockout, which
// evaluates strings as code and is refused by this app's CSP. See
// `lib/viewer/globe.ts`.
const packageJsonPath = require.resolve("@cesium/engine/package.json");
const root = dirname(packageJsonPath);
const target = join(process.cwd(), "public", "cesium");

// Removed first: a stale directory from an older Cesium is worse than none,
// because it half-matches and fails in a way that looks like a code bug.
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

for (const entry of DIRECTORIES) {
  await cp(join(root, ...entry.from), join(target, entry.to), {
    recursive: true,
  });
}

/*
  Bundle the engine ourselves, and serve it.

  Two separate problems rule out the obvious routes:

  - **Letting Turbopack bundle it** produces a script the browser refuses to
    parse — "Octal escape sequences are not allowed in template strings",
    thrown before any of our code runs. Cesium's source is valid (Node imports
    it happily); the transform of it is not.
  - **Using the published `cesium` bundle** works, but that package ships
    Knockout for its widgets, and Knockout compiles bindings with
    `new Function` at import time. That needs `unsafe-eval` in `script-src`,
    which an application that signs documents with a smart card should not
    grant so a basemap can draw.

  `@cesium/engine` is the library without the widgets, and esbuild is already
  present as one of Next's own dependencies. Bundling it here gives a plain
  ES module the browser loads directly: no Turbopack transform, no Knockout,
  no eval, and several megabytes kept out of the app's own bundle.
*/
await build({
  entryPoints: [join(root, "index.js")],
  outfile: join(target, "engine.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  legalComments: "external",
  logLevel: "silent",
});

const { version } = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
  version: string;
};

console.log(`cesium assets ${version} → public/cesium/`);

/*
  SQLite's WebAssembly, for reading GeoPackage files.

  `@sqlite.org/sqlite-wasm` locates its `.wasm` with
  `new URL("sqlite3.wasm", import.meta.url)`. Under a bundler `import.meta.url`
  is the chunk's URL, so the file is looked for beside the chunk and is not
  there — the same trap Cesium's worker and MapLibre's worker both fell into.
  Copying it to a known path and passing `locateFile` removes the guesswork.
*/
const sqlitePackage = require.resolve("@sqlite.org/sqlite-wasm/package.json");
const sqliteTarget = join(process.cwd(), "public", "sqlite");
await rm(sqliteTarget, { recursive: true, force: true });
await mkdir(sqliteTarget, { recursive: true });
/*
  The whole module, not only the `.wasm`.

  Bundling `@sqlite.org/sqlite-wasm` fails outright: its OPFS VFS contains
  `new Worker(new URL(proxyUri, import.meta.url))` with a URL computed at
  runtime, and no bundler can resolve that. Serving the module and importing it
  by URL sidesteps the question — and because `import.meta.url` is then the
  served path, SQLite finds its own `.wasm` beside it with no `locateFile`
  needed.

  The OPFS proxy is copied too. This app deserialises bytes into an in-memory
  database and never touches OPFS, but the module reaches for the proxy while
  probing what is available, and a 404 during start-up is noise in a console
  that is used to spot real failures.
*/
for (const name of ["index.mjs", "sqlite3.wasm", "sqlite3-opfs-async-proxy.js"]) {
  await cp(
    join(dirname(sqlitePackage), "dist", name),
    join(sqliteTarget, name),
  );
}

const sqliteVersion = JSON.parse(await readFile(sqlitePackage, "utf8")) as {
  version: string;
};
console.log(`sqlite wasm ${sqliteVersion.version} → public/sqlite/`);

/*
  laz-perf, for reading .laz point clouds.

  The package's emscripten loader cannot go through Turbopack: it resolves its
  `.wasm` by guessing a path beside the script, and the `.wasm` it ships is
  turned into a module with WASI imports (`env`, `wasi_snapshot_preview1`) that
  no bundler can resolve. `next.config.ts` therefore stubs `laz-perf` for
  `@ifc-lite/pointcloud`, whose own LAZ reader is what trips on it.

  `lib/pointcloud/laz.ts` does the LAZ reading instead, and loads the library
  the way SQLite and Cesium are loaded: bundled once here into a plain ES
  module, served from `public/`, imported by URL. The `.wasm` sits beside it and
  is fetched by the worker and handed over as `wasmBinary`, so emscripten never
  has to find it.
*/
const lazPackage = require.resolve("laz-perf/package.json");
const lazTarget = join(process.cwd(), "public", "laz-perf");
await rm(lazTarget, { recursive: true, force: true });
await mkdir(lazTarget, { recursive: true });
await build({
  stdin: {
    contents:
      'import createLazPerf from "laz-perf/lib/web/laz-perf.js"; export default createLazPerf;',
    resolveDir: dirname(lazPackage),
    loader: "js",
  },
  outfile: join(lazTarget, "laz-perf.mjs"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  logLevel: "silent",
});
await cp(
  join(dirname(lazPackage), "lib", "web", "laz-perf.wasm"),
  join(lazTarget, "laz-perf.wasm"),
);

const lazVersion = JSON.parse(await readFile(lazPackage, "utf8")) as {
  version: string;
};
console.log(`laz-perf ${lazVersion.version} → public/laz-perf/`);
