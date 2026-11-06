import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Realistic materials (ADR 014): the switch in Display, both texture
 * libraries (Poly Haven and 360into), and the textures on the model.
 *
 * Both libraries are stubbed at the network, so this checks what the app asks
 * for and does with the answers, not the libraries' uptime. Requests made from
 * the page still pass its own CSP: one the policy forbade would never reach the
 * stub.
 */

const FIXTURE = path.resolve(__dirname, "../fixtures/ifc/facets-ifc4.ifc");

// 1×1 PNGs of one colour, and a 64×64 of black and white bands.
const GREY = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOYNm3afwAGSgLCLKdvUwAAAABJRU5ErkJggg==";
const RED = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGM4oSH3HwAE2AIONevgXwAAAABJRU5ErkJggg==";
const STRIPES =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAo0lEQVR4nO3WMREAMAwDsSIpf2Sh0cLQkB+0+37yufe+zY4eoBVAD9AKoAdoBdADtDMzb7MC6AFaAfQArQB6gFYAfUS0AugBWgH0AK0AeoBWAH1EtALoAVoB9ACtAHqAVgB9RLQC6AFaAfQArQB6gFYAfUS0AugBWgH0AK0AeoBWAH1EtALoAVoB9ACtAHqAVgB9RLQC6AFaAfQArQB6gLY+wAcD9VJZ1F2zMgAAAABJRU5ErkJggg==";

const thumb = (id: string) => `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256&height=256&format=webp`;

const CATALOGUE = {
  // Two concretes: the grey one is the colour the fixture's walls are drawn in.
  concrete_grey: { name: "Grey Concrete", category: "Concrete/Cast Walls & Floors/Bare Cast", categories: ["concrete"], attributes: { surface_use: "wall", condition: ["clean"] }, dimensions: [2000, 2000], thumbnail_url: thumb("concrete_grey") },
  concrete_red: { name: "Red Concrete", category: "Concrete/Cast Walls & Floors/Bare Cast", categories: ["concrete"], attributes: { surface_use: "wall", condition: ["clean"] }, dimensions: [2000, 2000], thumbnail_url: thumb("concrete_red") },
  // Red in its preview: 360into's grey planks are nearer the fixture's colour.
  oak_planks: { name: "Oak Planks", category: "Wood/Boards & Planks/Oak", categories: ["wood"], attributes: { surface_use: "floor", condition: ["clean"] }, dimensions: [1000, 1000], thumbnail_url: thumb("oak_planks") },
  // Not a building material at all: never a candidate.
  aerial_rocks: { name: "Aerial Rocks", category: "Ground & Terrain/Rocky Ground", categories: ["aerial"], attributes: { aerial: true }, thumbnail_url: thumb("aerial_rocks") },
};

/** 360into, by category: a red concrete (Poly Haven's grey one is nearer) and grey planks (nearer than Poly Haven's). */
const INTO360: Record<string, unknown[]> = {
  "concrete-rough": [{ slug: "red-concrete", title: "Red Concrete", category: { slug: "concrete-rough" }, tags: [{ slug: "wall", name: "wall" }], resolution: "1024x1024", file_size: 1000, mime_type: "image/jpeg", direct_url: "https://360into.com/red-concrete.jpg", thumb_url: "https://360into.com/thumbs/red-concrete.webp", world_size: { width_mm: 2000, height_mm: 2000 } }],
  "wood-planks": [{ slug: "grey-oak-planks", title: "Grey Oak Planks", category: { slug: "wood-planks" }, tags: [{ slug: "flooring", name: "flooring" }], resolution: "1024x1024", file_size: 1000, mime_type: "image/jpeg", direct_url: "https://360into.com/grey-oak-planks.jpg", thumb_url: "https://360into.com/thumbs/grey-oak-planks.webp", world_size: { width_mm: 1200, height_mm: 1200 } }],
};

async function stubPolyHaven(page: Page) {
  const asked: string[] = [];
  const png = (base64: string) => (route: Route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(base64, "base64"), headers: { "access-control-allow-origin": "*" } });
  await page.route("https://api.polyhaven.com/**", async (route) => {
    const url = new URL(route.request().url());
    asked.push(url.href);
    const headers = { "access-control-allow-origin": "*" };
    if (url.pathname === "/assets") return route.fulfill({ status: 200, json: CATALOGUE, headers });
    const id = url.pathname.replace("/files/", "");
    const map = (suffix: string) => ({ "1k": { jpg: { url: `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/${id}/${id}_${suffix}_1k.jpg` } } });
    return route.fulfill({ status: 200, headers, json: { Diffuse: map("diff"), nor_gl: map("nor_gl"), nor_dx: map("nor_dx"), arm: map("arm"), Rough: map("rough") } });
  });
  await page.route("https://cdn.polyhaven.com/**", (route) => {
    asked.push(route.request().url());
    return png(/concrete_red|oak_planks/.test(route.request().url()) ? RED : GREY)(route);
  });
  await page.route("https://dl.polyhaven.org/**", (route) => {
    asked.push(route.request().url());
    return png(STRIPES)(route);
  });
  return asked;
}

async function stubInto360(page: Page) {
  const asked: string[] = [];
  await page.route("https://360into.com/**", (route) => {
    const url = new URL(route.request().url());
    asked.push(url.href);
    const headers = { "access-control-allow-origin": "*" };
    if (url.pathname === "/api/v1/textures") {
      const data = INTO360[url.searchParams.get("category") ?? ""] ?? [];
      return route.fulfill({ status: 200, headers, json: { data, meta: { page: 1, per_page: 100, total: data.length, total_pages: 1 } } });
    }
    const body = url.pathname.startsWith("/thumbs/") && url.pathname.includes("red-") ? RED : url.pathname.startsWith("/thumbs/") ? GREY : STRIPES;
    return route.fulfill({ status: 200, contentType: "image/png", headers, body: Buffer.from(body, "base64") });
  });
  return asked;
}

test("textures the model from both libraries by material and colour, and takes them away again", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const violations: string[] = [];
  page.on("console", (message) => {
    // A shader that does not compile is only ever a console message.
    if (/Content Security Policy|Refused to|Shader Error|WebGLProgram/i.test(message.text())) violations.push(message.text());
  });
  const asked = await stubPolyHaven(page);
  const askedInto = await stubInto360(page);

  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [FIXTURE]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 90_000 });
  // Off until asked: nothing goes to either library just for opening a model.
  expect(asked).toEqual([]);
  expect(askedInto).toEqual([]);

  await page.getByRole("button", { name: "Open display settings" }).click();
  await page.getByRole("switch", { name: "Realistic materials" }).click();
  const summary = page.locator("[data-realistic-summary]");
  await expect(summary).toHaveText("2 textures on 3 elements", { timeout: 30_000 });

  // The nearest colour wins, whichever library it is in: Poly Haven's grey
  // concrete over 360into's red one, 360into's grey planks over Poly Haven's red.
  const applied = page.locator("[data-realistic-applied]");
  await expect(applied.getByRole("listitem").filter({ hasText: "Concrete C30/37" })).toContainText("Grey Concrete");
  await expect(applied.getByRole("listitem").filter({ hasText: "Timber CLT" })).toContainText("Grey Oak Planks");
  await expect(applied.getByRole("link", { name: "Grey Concrete" })).toHaveAttribute("href", "https://polyhaven.com/a/concrete_grey");
  await expect(applied.getByRole("link", { name: "Grey Oak Planks" })).toHaveAttribute("href", "https://360into.com/t/grey-oak-planks");

  // Poly Haven's colours come from its flat previews, not the sphere thumbnails.
  expect(asked.filter((url) => url.includes("/asset_img/primary/")).length).toBeGreaterThan(0);
  expect(asked.some((url) => url.includes("/asset_img/thumbs/"))).toBe(false);
  // Only the chosen texture was downloaded, with its relief (OpenGL normals and
  // arm), and never the aerial one's preview.
  expect(asked.filter((url) => url.startsWith("https://dl.polyhaven.org/")).sort()).toEqual([
    expect.stringContaining("/concrete_grey_arm_1k.jpg"),
    expect.stringContaining("/concrete_grey_diff_1k.jpg"),
    expect.stringContaining("/concrete_grey_nor_gl_1k.jpg"),
  ]);
  // Poly Haven's relief is its own; 360into's photograph has its relief estimated.
  await expect(applied.locator('[data-relief="maps"]')).toContainText("Grey Concrete");
  await expect(applied.locator('[data-relief="estimated"]')).toContainText("Grey Oak Planks");
  expect(asked.some((url) => url.includes("aerial_rocks"))).toBe(false);
  expect(askedInto.filter((url) => /\/[a-z-]+\.jpg$/.test(new URL(url).pathname))).toEqual(["https://360into.com/grey-oak-planks.jpg"]);
  // 360into is asked only for the categories the model's families need.
  expect(new Set(askedInto.filter((url) => url.includes("/api/")).map((url) => new URL(url).searchParams.get("category")))).toEqual(
    new Set(["concrete-rough", "concrete-precast", "concrete", "concrete-plates", "wood-planks", "wood-fine", "wood-panels", "wood-raw", "flooring"]),
  );
  expect(violations).toEqual([]);

  await page.keyboard.press("Escape");
  const credit = page.locator("[data-realistic-credit]");
  await expect(credit).toHaveText("Textures: Poly Haven · 360into");
  expect(Number(await credit.getAttribute("data-surface-textured"))).toBeGreaterThan(0);
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: testInfo.outputPath("realistic.png") });

  // Off: the IFC colours come back, and the credit goes with the textures.
  await page.getByRole("button", { name: "Open display settings" }).click();
  await page.getByRole("switch", { name: "Realistic materials" }).click();
  await expect(summary).toBeEmpty();
  await expect(credit).toHaveCount(0);
  await expect(page.locator('[data-realistic-status="off"]')).toBeAttached();
});

test("uses the other library when one is down, and says so", async ({ page }) => {
  test.setTimeout(120_000);
  await page.route("https://api.polyhaven.com/**", (route) => route.fulfill({ status: 503, headers: { "access-control-allow-origin": "*" }, body: "" }));
  await stubInto360(page);
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [FIXTURE]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 90_000 });

  await page.getByRole("button", { name: "Open display settings" }).click();
  await page.getByRole("switch", { name: "Realistic materials" }).click();
  await expect(page.locator("[data-realistic-summary]")).toContainText("2 textures on 3 elements", { timeout: 30_000 });
  await expect(page.locator("[data-realistic-unreachable]")).toHaveText("Poly Haven could not be reached; textures from the other library only.");
  await expect(page.locator("[data-realistic-credit]")).toHaveText("Textures: 360into");
});

test("keeps the model's colours when neither library can be reached", async ({ page }) => {
  test.setTimeout(120_000);
  const down = (route: Route) => route.fulfill({ status: 503, headers: { "access-control-allow-origin": "*" }, body: "" });
  await page.route("https://api.polyhaven.com/**", down);
  await page.route("https://360into.com/**", down);
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [FIXTURE]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 90_000 });

  await page.getByRole("button", { name: "Open display settings" }).click();
  await page.getByRole("switch", { name: "Realistic materials" }).click();
  await expect(page.locator("[data-realistic-summary]")).toHaveText(/Neither Poly Haven nor 360into could be reached/, { timeout: 30_000 });
  await expect(page.locator("[data-realistic-credit]")).toHaveCount(0);
});
