import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * buildingSMART's validation service, run in the browser (ADR 018): Pyodide in
 * a worker, under the app's CSP, loading only `/validator/` from this origin.
 * The expected results are the service code's own on this fixture
 * (`npm run validator:check -- fixtures/ifc/georeferenced-wall-ifc4.ifc`).
 */

const IFC = path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc");

test("validates a model on the device, stage by stage, with nothing sent elsewhere", async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  const build = await page.request.get("/validator/build.json");
  test.skip(!build.ok(), "public/validator/ was not built (npm run validator:assets)");

  const foreign: string[] = [];
  const origin = new URL(baseURL!).origin;
  page.context().on("request", (request) => {
    const url = new URL(request.url());
    if (/^https?:$/.test(url.protocol) && url.origin !== origin) foreign.push(request.url());
  });
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security Policy|Refused to/i.test(message.text())) errors.push(message.text());
  });

  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', IFC);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  await page.getByRole("tab", { name: /^(Validation|Validação)$/ }).click();
  const panel = page.locator("[data-ifc-validation]");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: /^(Validate|Validar)$/ }).click();

  const run = panel.locator("[data-ifc-validation-run]");
  await expect(run).toHaveAttribute("data-status", /done|error/, { timeout: 240_000 });
  await expect(run).toHaveAttribute("data-status", "done");

  const stage = (name: string) => panel.locator(`[data-ifc-validation-stage="${name}"]`);
  await expect(stage("header_syntax")).toHaveAttribute("data-status", "valid");
  await expect(stage("header")).toHaveAttribute("data-status", "invalid");
  await expect(stage("syntax")).toHaveAttribute("data-status", "valid");
  await expect(stage("prerequisites")).toHaveAttribute("data-status", "valid");
  await expect(stage("schema")).toHaveAttribute("data-status", "invalid");
  await expect(stage("schema")).toHaveAttribute("data-count", "12");
  await expect(stage("normative_ia")).toHaveAttribute("data-status", "invalid");
  await expect(stage("normative_ia")).toHaveAttribute("data-count", "13");
  await expect(stage("normative_ip")).toHaveAttribute("data-status", "valid");
  await expect(stage("industry_practices")).toHaveAttribute("data-status", "valid");

  // Each header field is its own finding, explained: what is required, and what the file has.
  await stage("header").locator("button").first().click();
  const originating = stage("header").locator('[data-ifc-validation-rule="originating_system"]');
  await originating.locator("button").first().click();
  await expect(originating.locator("[data-ifc-validation-explanation]")).toContainText(/Company - Application - Version|Empresa - Aplicação - Versão/);
  await expect(originating.locator("[data-ifc-validation-note]")).toContainText("DiCE-IFC");
  const company = stage("header").locator('[data-ifc-validation-rule="company_name"]');
  await company.locator("button").first().click();
  await expect(company.locator("[data-ifc-validation-note]")).toContainText(/originating system|sistema de origem/);

  // Rules are grouped and named, with their description; an instance is a click away.
  await stage("normative_ia").locator("button").first().click();
  const rule = stage("normative_ia").locator('[data-ifc-validation-rule="PJS003"]');
  await expect(rule).toContainText("PJS003");
  await rule.locator("button").first().click();
  await expect(rule.locator("[data-ifc-validation-explanation]")).toContainText("The rule verifies that the GUID");
  await rule.getByRole("button", { name: /^#\d+$/ }).first().click();

  // The deliverables. A PDF report…
  const exportSection = panel.locator("[data-ifc-validation-export]");
  const [pdf] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    exportSection.getByRole("button", { name: /^(PDF report|Relatório PDF)$/ }).click(),
  ]);
  expect(pdf.suggestedFilename()).toBe("georeferenced-wall-ifc4-validation.pdf");
  const pdfBytes = await (await import("node:fs/promises")).readFile((await pdf.path())!);
  expect(pdfBytes.subarray(0, 5).toString()).toBe("%PDF-");

  // …and an issue set, one topic per rule, with snapshots where the instance is drawn,
  // handed to the BCF manager as well.
  await exportSection.getByLabel(/Snapshots of the elements|Imagens dos elementos/).check();
  const [bcf] = await Promise.all([
    page.waitForEvent("download", { timeout: 120_000 }),
    exportSection.getByRole("button", { name: /^BCF$/ }).click(),
  ]);
  expect(bcf.suggestedFilename()).toMatch(/\.bcf$/);
  // The walls and the slab are drawn, so their rules' topics carry a viewpoint and a picture.
  const { unzipSync } = await import("fflate");
  const entries = Object.keys(unzipSync(new Uint8Array(await (await import("node:fs/promises")).readFile((await bcf.path())!))));
  expect(entries.filter((name) => name.endsWith(".bcfv")).length).toBeGreaterThanOrEqual(3);
  expect(entries.filter((name) => name.endsWith(".png")).length).toBeGreaterThanOrEqual(3);
  await page.getByRole("tab", { name: /^BCF$/ }).click();
  await expect(page.locator("[data-topic-list]").getByRole("listitem")).toHaveCount(7);

  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});
