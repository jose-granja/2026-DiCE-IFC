import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Vite resolves the `@/*` alias from tsconfig.json natively.
    tsconfigPaths: true,
    alias: {
      // `xmllint-wasm`'s browser build runs libxml2 in a Web Worker, which
      // jsdom does not provide. Its Node build does the same work in-process,
      // so tests exercise the same API without needing a Worker.
      "xmllint-wasm": "xmllint-wasm/index-node.js",
    },
  },
  test: {
    // Routes schema validation past the Web Worker; see the file for why.
    setupFiles: ["./vitest.setup.ts"],
    // The engines are the thing worth testing here: lib/ifc, lib/ids, lib/bcf,
    // lib/georef and lib/signing. Component and route flows are Playwright's job.
    include: [
      "lib/**/*.test.{ts,tsx}",
      "scripts/**/*.test.ts",
      "eslint-rules/**/*.test.ts",
    ],
    environment: "node",
    // IFC parsing on a cold WASM init is slower than the 5 s default.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
