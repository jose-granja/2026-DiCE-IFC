import { defineConfig, devices } from "@playwright/test";

/**
 * Module flows. The engines are covered by Vitest (`npm test`); this is for the
 * things only a real browser has — OPFS, Web Workers, WebGPU/WebGL, the File
 * System Access API, and drag-and-drop.
 *
 * Chromium only for now: it is the only engine with both WebGPU and the File
 * System Access API, and those are the paths worth exercising. Add WebKit when
 * the WebGL fallback needs regression coverage.
 */
/**
 * Which port the test server uses.
 *
 * Configurable because :3000 is often already taken on a developer's machine —
 * by the Docker dev container, or merely by a browser tab still holding a
 * socket open to one. Neither is something a test run should demand be killed.
 */
const PORT = process.env.PLAYWRIGHT_PORT ?? "3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
    // Model files are read from disk in these tests; keep them out of traces.
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: [
            // The WASM workers want SharedArrayBuffer, which needs cross-origin
            // isolation. next.config.ts sends COOP/COEP, so this only has to
            // cover the headless default.
            "--enable-features=SharedArrayBuffer",
          ],
        },
      },
    },
  ],

  webServer: {
    // Against a production build, so the CSP and the security headers under
    // test are the ones that actually ship. `next dev` relaxes both.
    command: `npm run build && npm run start -- --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    // Never reuse. Reusing whatever happens to be on :3000 silently tests a
    // stale build — or the Docker dev container, which serves different code
    // with a different CSP. Both produce failures that look like app bugs and
    // are not. The rebuild costs a few seconds; the confusion cost more.
    reuseExistingServer: false,
    // A time-stamp authority for the signing tests to find: `e2e/timestamp.spec.ts`
    // starts a fake one on this port. Nothing calls it unless a test does.
    env: {
      TSA_URL: `http://127.0.0.1:${process.env.TSA_TEST_PORT ?? "3199"}/ts`,
      TSA_NAME: "Test time-stamp authority",
    },
    timeout: 240_000,
  },
});
