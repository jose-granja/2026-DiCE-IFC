import path from "node:path";

import { expect, test, type Page, type Worker } from "@playwright/test";

/**
 * The Web Workers' CSP (ADR 015).
 *
 * A dedicated worker takes its policy from its own script's response, not from
 * the page, and `proxy.ts` never sees `/_next/static/`. Before `next.config.ts`
 * set one there, a worker — the code holding the parsed model — could fetch
 * any origin at all while the page's `connect-src` looked airtight.
 *
 * Each probe origin is answered by `page.route`, with CORS, so a request the
 * policy lets through *succeeds*: a failure can only be the policy's doing,
 * never DNS. The allowed-origin control proves that.
 */

const IFC4 = path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc");

const FOREIGN = "https://csp-probe.example/leak";
/** On the worker allow-list (a texture library, ADR 014). */
const ALLOWED = "https://360into.com/csp-probe";
/** The signing companion: on the page's list, deliberately not on a worker's. */
const COMPANION = "http://127.0.0.1:8765/csp-probe";

async function answerProbes(page: Page) {
  for (const url of [FOREIGN, ALLOWED, COMPANION]) {
    await page.route(url, (route) =>
      route.fulfill({ status: 200, body: "reached", headers: { "access-control-allow-origin": "*" } }),
    );
  }
}

/** Load a model so the viewer starts its IFC workers, and return one. */
async function startWorker(page: Page): Promise<Worker> {
  await page.goto("/viewer");
  const worker = page.waitForEvent("worker");
  await page.setInputFiles('input[type="file"]', [IFC4]);
  return worker;
}

type Probe = { body: string | null; violations: string[] };

/** Fetch `url` from inside `worker`, recording any CSP violation it raises. */
function probe(worker: Worker, url: string): Promise<Probe> {
  return worker.evaluate(async (target) => {
    const violations: string[] = [];
    const listener = (e: SecurityPolicyViolationEvent) => violations.push(e.effectiveDirective);
    self.addEventListener("securitypolicyviolation", listener);
    let body: string | null = null;
    try {
      body = await (await fetch(target)).text();
    } catch {
      body = null;
    }
    // The event is queued as a task; let it land before reading the list.
    await new Promise((resolve) => setTimeout(resolve, 100));
    self.removeEventListener("securitypolicyviolation", listener);
    return { body, violations };
  }, url);
}

test.beforeEach(async ({ page }) => {
  await answerProbes(page);
});

test("the worker bootstrap carries the worker policy, not the page's", async ({ page }) => {
  const worker = await startWorker(page);
  expect(worker.url()).toContain("/_next/static/");

  const response = await page.request.get(worker.url());
  const csp = response.headers()["content-security-policy"];
  expect(csp).toContain("default-src 'none'");
  expect(csp).toMatch(/connect-src 'self' [^;]*https:\/\/360into\.com/);
  expect(csp).not.toContain("127.0.0.1");
  expect(csp).not.toContain("nonce-");
});

test("a worker can reach an allowed origin", async ({ page }) => {
  const worker = await startWorker(page);
  expect(await probe(worker, ALLOWED)).toEqual({ body: "reached", violations: [] });
});

test("a worker cannot fetch an origin outside the allow-list", async ({ page }) => {
  const worker = await startWorker(page);
  expect(await probe(worker, FOREIGN)).toEqual({ body: null, violations: ["connect-src"] });
});

test("a worker cannot reach the signing companion, which only the page may", async ({ page }) => {
  const worker = await startWorker(page);
  expect(await probe(worker, COMPANION)).toEqual({ body: null, violations: ["connect-src"] });
});

test("a blob: worker started by a worker inherits its policy", async ({ page }) => {
  // fflate's async unzip does exactly this.
  const worker = await startWorker(page);
  const outcome = await worker.evaluate((target) => {
    const source = `fetch(${JSON.stringify(target)}).then(
      (r) => r.text().then((t) => postMessage(t)),
      () => postMessage("blocked"),
    );`;
    const nested = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
    return new Promise<string>((resolve) => {
      nested.onmessage = (e) => {
        nested.terminate();
        resolve(String(e.data));
      };
    });
  }, FOREIGN);
  expect(outcome).toBe("blocked");
});
