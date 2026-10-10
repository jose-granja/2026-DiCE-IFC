/**
 * Fail early, and in plain words, when node_modules is behind package.json.
 *
 *   node --experimental-strip-types scripts/check-installed.mts
 *
 * A declared dependency that is not on disk surfaces as
 * "Module not found: Can't resolve '<package>'" pointing at the line that
 * imports it. That reads like a broken import — the wrong thing to go and
 * investigate — when the real answer is "run npm install".
 *
 * Two ways this happens, both of which have now cost a debugging round:
 *
 * - **The dev container's anonymous `/app/node_modules` volume** survives
 *   `up --build` and holds whatever was installed when the container was first
 *   created, so new source meets old modules. `3d-tiles-renderer` failed this
 *   way.
 * - **`NODE_ENV=production` makes npm skip devDependencies**, on `install` as
 *   well as `ci`. `.env.dev` sets it and compose passes it in, so the *dev*
 *   container installs no dev packages at all. `esbuild` failed this way, and
 *   the check below missed it because it only looked at `dependencies`.
 *
 * Anything a build script needs therefore belongs in `dependencies`, whatever
 * its role — see the note in `copy-cesium-assets.mts`.
 *
 * Runs from `predev`, where it is cheap and where the confusion happens.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const manifest = JSON.parse(
  readFileSync(path.join(ROOT, "package.json"), "utf8"),
) as { dependencies?: Record<string, string> };

/** Runtime dependencies only: a missing devDependency is a different problem. */
const declared = Object.keys(manifest.dependencies ?? {});

const missing = declared.filter(
  (name) => !existsSync(path.join(ROOT, "node_modules", name, "package.json")),
);

if (missing.length > 0) {
  console.error(
    [
      "",
      `${missing.length} declared dependenc${missing.length === 1 ? "y is" : "ies are"} not installed:`,
      ...missing.map((name) => `  - ${name}`),
      "",
      "Run `npm install`.",
      "",
      "In the dev container, /app/node_modules is an anonymous volume that",
      "outlives `up --build`, so install inside it or recreate the volume:",
      "  docker compose -f docker-compose_dev.yml run --rm frontend npm install",
      "  docker compose -f docker-compose_dev.yml down -v && docker compose -f docker-compose_dev.yml up --build",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
