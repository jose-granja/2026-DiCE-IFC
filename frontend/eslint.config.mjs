import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

import noPayloadUploads from "./eslint-rules/no-payload-uploads.mjs";

/**
 * Next 16 removed `next lint`; `npm run lint` calls the ESLint CLI directly and
 * `next build` no longer lints. Run it in CI explicitly.
 */
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  {
    // The privacy line, mechanically. See AGENTS.md §1 and
    // eslint-rules/no-payload-uploads.mjs for what it can and cannot catch.
    plugins: {
      dice: {
        rules: {
          "no-payload-uploads": noPayloadUploads,
        },
      },
    },
    rules: {
      "dice/no-payload-uploads": "error",

      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@ifc-lite/*", "@thatopen/*", "web-ifc"],
              message:
                "Import from @/lib/ifc/adapter instead. Only lib/ifc/ifc-lite-adapter.ts may touch an engine directly — see docs/adr/001-ifc-engine.md.",
            },
          ],
        },
      ],
    },
  },

  {
    // The only files allowed to import the engine.
    //
    // `ifc-lite-adapter.ts` is the swap point (ADR 001). `ids-document.ts` is
    // the narrow exception: the engine's IDS parser needs `DOMParser`, which a
    // Worker does not have, so that one call has to happen on the main thread —
    // and it must not drag the geometry processor and its WebAssembly into the
    // main bundle to do it. It imports `@ifc-lite/ids` and nothing else, and
    // hands back an opaque document no other module reads.
    files: ["lib/ifc/ifc-lite-adapter.ts", "lib/ifc/ids-document.ts"],
    rules: { "no-restricted-imports": "off" },
  },

  {
    // `@ifc-lite/pointcloud` is a decoder for scans, not the IFC engine the
    // adapter exists to make swappable (ADR 001): it knows nothing of IFC.
    // Everything that reads point-cloud files goes through `lib/pointcloud/`, so
    // that is the one place allowed to import it.
    files: ["lib/pointcloud/**"],
    rules: { "no-restricted-imports": "off" },
  },

  {
    // The spike measures both engines by definition.
    files: ["scripts/**"],
    rules: { "no-restricted-imports": "off" },
  },

  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored by the copy scripts in `scripts/`, not ours to lint.
    "public/maplibre/**",
    "public/cesium/**",
    "public/sqlite/**",
    "public/laz-perf/**",
  ]),
]);

export default eslintConfig;
