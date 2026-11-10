import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Realistic materials (ADRs 014, 016): the switch in Display, this server's
 * texture library, and the textures on the model.
 *
 * The library's backend is stubbed at the network, so this checks what the app
 * asks for and does with the answers. Requests made from the page still pass
 * its own CSP: one the policy forbade would never reach the stub.
 */

const FIXTURE = path.resolve(__dirname, "../fixtures/ifc/facets-ifc4.ifc");

// A 1×1 grey PNG, and a 64×64 of black and white bands.
const GREY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOYNm3afwAGSgLCLKdvUwAAAABJRU5ErkJggg==";
const STRIPES =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAo0lEQVR4nO3WMREAMAwDsSIpf2Sh0cLQkB+0+37yufe+zY4eoBVAD9AKoAdoBdADtDMzb7MC6AFaAfQArQB6gFYAfUS0AugBWgH0AK0AeoBWAH1EtALoAVoB9ACtAHqAVgB9RLQC6AFaAfQArQB6gFYAfUS0AugBWgH0AK0AeoBWAH1EtALoAVoB9ACtAHqAVgB9RLQC6AFaAfQArQB6gLY+wAcD9VJZ1F2zMgAAAABJRU5ErkJggg==";

/** A texture in the library's manifest, as the backend lists it (ADR 016). */
function texture(id: string, name: string, family: string, source: "polyhaven" | "ambientcg", lab: [number, number, number], surface = "wall") {
  const maps = (size: number) => ({ color: `${id}/h/color-${size}.webp`, normal: `${id}/h/normal-${size}.webp`, arm: `${id}/h/arm-${size}.webp` });
  return {
    id,
    name,
    family,
    surface,
    source,
    sourceUrl: source === "polyhaven" ? `https://polyhaven.com/a/${id}` : `https://ambientcg.com/view?id=${id}`,
    licence: "CC0-1.0",
    tile: [2, 2],
    mean: [0.2, 0.2, 0.2],
    lab,
    sizes: { "1024": maps(1024), "2048": maps(2048) },
    thumb: `${id}/h/thumb.webp`,
  };
}

const GREY: [number, number, number] = [53.4, 0, 0];
const RED: [number, number, number] = [53.2, 80, 67];

/** Grey concrete from Poly Haven and grey planks from ambientCG are the fixture's nearest; the red ones are not. */
const MANIFEST = {
  version: 1,
  files: "/texture-library/files/",
  textures: [
    texture("polyhaven-concrete_grey", "Grey Concrete", "concrete", "polyhaven", GREY),
    texture("ambientcg-Concrete099", "Red Concrete", "concrete", "ambientcg", RED),
    texture("ambientcg-WoodFloor070", "Grey Oak Planks", "wood", "ambientcg", GREY, "floor"),
    texture("polyhaven-oak_planks", "Red Oak Planks", "wood", "polyhaven", RED, "floor"),
  ],
};

/**
 * Answer the texture library as the backend would, recording what is asked
 * for. Any request to another origin for a texture would also be recorded.
 */
async function stubLibrary(page: Page, manifest: { status: number; body?: unknown } = { status: 200, body: MANIFEST }) {
  const asked: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/texture-library/") || /polyhaven|360into|ambientcg/.test(new URL(url).hostname)) asked.push(url);
  });
  await page.route("**/texture-library/api/manifest", (route) =>
    route.fulfill({ status: manifest.status, json: manifest.body ?? { detail: "Not Found" } }),
  );
  await page.route("**/texture-library/files/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(route.request().url().includes("color") ? STRIPES : GREY_PNG, "base64") }),
  );
  return asked;
}

async function openFixture(page: Page) {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [FIXTURE]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 90_000 });
}

test("textures the model from this server's library by material and colour, and takes them away again", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const violations: string[] = [];
  page.on("console", (message) => {
    // A shader that does not compile is only ever a console message.
    if (/Content Security Policy|Refused to|Shader Error|WebGLProgram/i.test(message.text())) violations.push(message.text());
  });
  const asked = await stubLibrary(page);

  await openFixture(page);
  // Off until asked: nothing is fetched just for opening a model.
  expect(asked).toEqual([]);

  await page.getByRole("button", { name: "Open display settings" }).click();
  await page.getByRole("switch", { name: "Realistic materials" }).click();
  const summary = page.locator("[data-realistic-summary]");
  await expect(summary).toHaveText("2 textures on 3 elements", { timeout: 30_000 });

  // The nearest colour wins, whichever library the texture came from.
  const applied = page.locator("[data-realistic-applied]");
  await expect(applied.getByRole("listitem").filter({ hasText: "Concrete C30/37" })).toContainText("Grey Concrete");
  await expect(applied.getByRole("listitem").filter({ hasText: "Timber CLT" })).toContainText("Grey Oak Planks");
  await expect(applied.getByRole("link", { name: "Grey Concrete" })).toHaveAttribute("href", "https://polyhaven.com/a/polyhaven-concrete_grey");
  await expect(applied.locator('[data-relief="maps"]')).toHaveCount(2);

  // Everything from this origin: the manifest once, then only the chosen
  // textures' maps — at 2K, two textures being few enough.
  const origins = new Set(asked.map((url) => new URL(url).origin));
  expect([...origins]).toEqual([new URL(page.url()).origin]);
  const paths = asked.map((url) => new URL(url).pathname);
  expect(paths.filter((path) => path.endsWith("/manifest"))).toHaveLength(1);
  expect(paths.filter((path) => path.startsWith("/texture-library/files/")).sort()).toEqual(
    ["ambientcg-WoodFloor070", "polyhaven-concrete_grey"].flatMap((id) =>
      ["arm", "color", "normal"].map((map) => `/texture-library/files/${id}/h/${map}-2048.webp`),
    ),
  );
  expect(violations).toEqual([]);

  await page.keyboard.press("Escape");
  const credit = page.locator("[data-realistic-credit]");
  await expect(credit).toHaveText("Textures: Poly Haven · ambientCG");
  expect(Number(await credit.getAttribute("data-surface-textured"))).toBeGreaterThan(0);
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: testInfo.outputPath("realistic.png") });

  // Off: the IFC colours come back and the credit goes.
  await page.getByRole("button", { name: "Open display settings" }).click();
  await page.getByRole("switch", { name: "Realistic materials" }).click();
  await expect(summary).toBeEmpty();
  await expect(credit).toHaveCount(0);
  await expect(page.locator('[data-realistic-status="off"]')).toBeAttached();
});

test("starts every visit without textures, even when left on, and forgets what an earlier version remembered", async ({ page }) => {
  test.setTimeout(120_000);
  await stubLibrary(page);
  await openFixture(page);
  // What an earlier version left in this browser when the switch was on.
  await page.evaluate(() => localStorage.setItem("dice-realistic-on", "1"));

  await page.getByRole("button", { name: "Open display settings" }).click();
  await page.getByRole("switch", { name: "Realistic materials" }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-realistic-credit]")).toBeVisible({ timeout: 30_000 });

  await page.reload();
  await page.setInputFiles('input[type="file"]', [FIXTURE]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 90_000 });
  await page.waitForTimeout(1_000);
  await expect(page.locator('[data-realistic-status="off"]')).toBeAttached();
  await expect(page.locator("[data-realistic-credit]")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("dice-realistic-on"))).toBeNull();
});

test("keeps the model's colours, and says why, when this server has no texture library", async ({ page }) => {
  test.setTimeout(120_000);
  await stubLibrary(page, { status: 404 });
  await openFixture(page);

  await page.getByRole("button", { name: "Open display settings" }).click();
  await page.getByRole("switch", { name: "Realistic materials" }).click();
  await expect(page.locator("[data-realistic-unavailable]")).toHaveText(
    "This server has no texture library installed, so the model keeps its own colours.",
    { timeout: 30_000 },
  );
  await expect(page.locator("[data-realistic-credit]")).toHaveCount(0);
});
