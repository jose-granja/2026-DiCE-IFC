import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * CityJSON loaded as surrounding context.
 *
 * The point of the feature is the question a basemap cannot answer: is this
 * building the right height next to its neighbours. So the tests care that the
 * geometry actually reaches the scene, and that it stays *out* of everything
 * that describes the user's own models.
 */

const IFC4 = path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc");
const IFC_WITHOUT_GEOREF = path.resolve(__dirname, "../fixtures/ifc/facets-ifc4.ifc");
const CITY = path.resolve(__dirname, "../fixtures/cityjson/two-blocks.city.json");
const GEOJSON = path.resolve(__dirname, "../fixtures/geojson/context.geojson");
const CITYGML = path.resolve(__dirname, "../fixtures/citygml/two-blocks.gml");
const GEOPACKAGE = path.resolve(__dirname, "../fixtures/geopackage/context.gpkg");

async function openGeoref(page: import("@playwright/test").Page) {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [IFC4]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({
    timeout: 60_000,
  });
  await page.getByRole("tab", { name: "Geo" }).click();

  // These fixtures are placed for what each test is actually about — a CRS
  // match, a format quirk — not for being within a realistic distance of
  // IFC4's site, so the default 100 m clip (on by default, see cityjson.ts's
  // own describe block for that behaviour) would read every one of them as
  // "nothing nearby" and fail the load. Off here; on again wherever a test
  // is about the clip itself.
  const clip = page.getByRole("switch", { name: "Clip context to the model" });
  if (await clip.isVisible()) await clip.click();
}

/** The panel's own picker, not the viewer's model picker. */
function cityInput(page: import("@playwright/test").Page) {
  return page.locator('input[accept*=".city.json"]');
}

/** Triangles the renderer received, or null when nothing loaded. */
async function triangles(page: import("@playwright/test").Page) {
  const marker = page.locator("[data-context-model='true']");
  await expect(marker).toBeAttached({ timeout: 45_000 });
  return Number(await marker.getAttribute("data-context-triangles"));
}

for (const fixture of [CITY, GEOPACKAGE]) {
  test(`shows measured file progress while reading ${path.basename(fixture)}`, async ({ page }, testInfo) => {
    // Hold the native read so a fast local fixture still exercises the visible
    // loading state. Only the selected context file is delayed; IFC loading
    // and the eventual context parsing/rendering use the real browser APIs.
    await page.addInitScript((name) => {
      const text = FileReader.prototype.readAsText;
      const buffer = FileReader.prototype.readAsArrayBuffer;
      const hold = (reader: FileReader, file: Blob, read: () => void) => {
        if (!(file instanceof File) || file.name !== name) return read();
        window.addEventListener("release-context-read", read, { once: true });
        reader.dispatchEvent(new ProgressEvent("progress", {
          lengthComputable: true, loaded: 50, total: 100,
        }));
      };
      FileReader.prototype.readAsText = function (file, encoding) {
        hold(this, file, () => text.call(this, file, encoding));
      };
      FileReader.prototype.readAsArrayBuffer = function (file) {
        hold(this, file, () => buffer.call(this, file));
      };
    }, path.basename(fixture));

    await openGeoref(page);
    await cityInput(page).setInputFiles(fixture);
    const progress = page.getByRole("progressbar", { name: "Reading context file…" });
    await expect(progress).toBeVisible();
    await expect(progress).toHaveAttribute("aria-valuenow", "50");
    await expect(page.getByText(path.basename(fixture), { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Load context" })).toBeDisabled();
    await expect(cityInput(page)).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("context-loading.png") });

    await page.evaluate(() => window.dispatchEvent(new Event("release-context-read")));
    expect(await triangles(page)).toBeGreaterThan(0);
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    await expect(cityInput(page)).toBeEnabled();
    await expect(page.getByRole("button", { name: "Remove the context model" })).toBeEnabled();
  });
}

test("loads CityGML, which is already three-dimensional", async ({ page }) => {
  // Two LoD1 blocks, six faces each, two triangles a face.
  await openGeoref(page);
  await cityInput(page).setInputFiles([CITYGML]);

  expect(await triangles(page)).toBe(24);
  await expect(page.getByText(/EPSG:3763/).first()).toBeVisible();
});

test("loads a plain .gml context with legacy coordinates", async ({ page }) => {
  // Generic GML rather than CityGML: no CityModel or Building vocabulary, and
  // the coordinate encoding is the GML 2 form used by cadastral exports.
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [IFC_WITHOUT_GEOREF]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({
    timeout: 60_000,
  });
  await page.getByRole("tab", { name: "Geo" }).click();
  await cityInput(page).setInputFiles({
    name: "parcel-context.gml",
    mimeType: "application/gml+xml",
    buffer: Buffer.from(`<?xml version="1.0"?>
      <FeatureCollection xmlns:gml="http://www.opengis.net/gml" srsName="EPSG:3763">
        <featureMember><Parcel><geometry>
          <gml:Polygon><gml:outerBoundaryIs><gml:LinearRing>
            <gml:coordinates cs="," ts=" ">
              -10,-10,0 10,-10,0 10,10,0 -10,10,0 -10,-10,0
            </gml:coordinates>
          </gml:LinearRing></gml:outerBoundaryIs></gml:Polygon>
        </geometry></Parcel></featureMember>
      </FeatureCollection>`),
  });

  expect(await triangles(page)).toBe(2);
  await expect(page.getByText(/placed at the origin rather than aligned/i)).toBeVisible();
});

test("loads a GeoPackage, which is a SQLite database", async ({ page }) => {
  // The heaviest reader: it starts a real SQL engine in the browser, reads the
  // OGC schema to find where the geometry is, and unwraps GeoPackage blobs to
  // the WKB inside.
  await openGeoref(page);
  await cityInput(page).setInputFiles([GEOPACKAGE]);

  // Two building polygons and a road: two triangles each.
  expect(await triangles(page)).toBe(6);
});

test("SQLite is not loaded unless a GeoPackage is opened", async ({ page }) => {
  // ~870 kB of WebAssembly for a format most sessions never touch.
  const wasm: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("sqlite")) wasm.push(request.url());
  });

  await openGeoref(page);
  await cityInput(page).setInputFiles([GEOJSON]);
  await triangles(page);

  expect(wasm).toEqual([]);
});

test("loads GeoJSON, extruding the footprints that carry a height", async ({
  page,
}) => {
  // The reason to read a flat format into a 3D scene: a cadastral layer becomes
  // the massing around the model rather than a picture of it.
  await openGeoref(page);
  await cityInput(page).setInputFiles([GEOJSON]);

  // The panel's own summary, not the toast — both say "4 objects".
  await expect(page.getByText(/4 objects, \d+ m across/)).toBeVisible({
    timeout: 30_000,
  });
  const marker = page.locator("[data-context-model='true']");
  await expect(marker).toBeAttached();
  expect(Number(await marker.getAttribute("data-context-triangles"))).toBeGreaterThan(
    0,
  );
});

test("picks the reader from the file's contents, not its name", async ({ page }) => {
  // Both formats are `.json` as often as not, so the extension decides nothing.
  // The `type` member does.
  await openGeoref(page);
  await cityInput(page).setInputFiles([
    {
      name: "ambiguous.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: { building: "yes", height: 9 },
              geometry: {
                type: "Polygon",
                coordinates: [
                  [
                    [-8.6106, 41.2882],
                    [-8.6104, 41.2882],
                    [-8.6104, 41.2884],
                    [-8.6106, 41.2882],
                  ],
                ],
              },
            },
          ],
        }),
      ),
    },
  ]);

  await expect(page.locator("[data-context-model='true']")).toBeAttached({
    timeout: 30_000,
  });
});

test("loads a CityJSON file into the scene", async ({ page }) => {
  await openGeoref(page);
  await cityInput(page).setInputFiles([CITY]);

  // The panel's own summary, not the toast — both say "2 objects".
  await expect(page.getByText(/2 objects, \d+ m across/)).toBeVisible({
    timeout: 30_000,
  });
  // The IFC's own CRS row also says EPSG:3763 — which is the point, they match.
  await expect(
    page.getByText(/2 objects, \d+ m across, EPSG:3763/),
  ).toBeVisible();

  // In the scene, not merely parsed.
  const marker = page.locator("[data-context-model='true']");
  await expect(marker).toBeAttached();
  expect(Number(await marker.getAttribute("data-context-triangles"))).toBeGreaterThan(
    0,
  );
});

test("hides and removes the context without touching the model", async ({ page }) => {
  await openGeoref(page);
  await cityInput(page).setInputFiles([CITY]);
  await expect(page.locator("[data-context-model='true']")).toBeAttached({
    timeout: 30_000,
  });

  await page.getByRole("switch", { name: "Context model" }).click();
  await expect(page.locator("[data-context-model='true']")).toHaveCount(0);

  await page.getByRole("switch", { name: "Context model" }).click();
  await expect(page.locator("[data-context-model='true']")).toBeAttached();

  await page.getByRole("button", { name: "Remove the context model" }).click();
  await expect(page.locator("[data-context-model='true']")).toHaveCount(0);

  // The user's own model is untouched throughout — the context is scenery.
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached();
});

test("the context is not treated as one of the user's models", async ({ page }) => {
  // This is the guarantee that matters. A city model that leaked into the model
  // list would be validated against the user's IDS and reported as their
  // failures.
  await openGeoref(page);
  await cityInput(page).setInputFiles([CITY]);
  await expect(page.locator("[data-context-model='true']")).toBeAttached({
    timeout: 30_000,
  });

  await page.getByRole("tab", { name: "Models" }).click();
  await expect(page.getByText("two-blocks.city.json")).toHaveCount(0);
  await expect(page.locator("[data-rendered-models]")).not.toContainText("city");
});

test("the context stays mounted while section planes are edited", async ({ page }) => {
  await openGeoref(page);
  await cityInput(page).setInputFiles([CITY]);
  const context = page.locator("[data-context-model='true']");
  await expect(context).toBeAttached({ timeout: 30_000 });

  await page.getByRole("tab", { name: "Section" }).click();
  await expect(context).toBeAttached();

  await page.getByRole("button", { name: "Plan" }).click();
  await expect(context).toBeAttached();
});

test("says what is wrong with a file it cannot draw", async ({ page }) => {
  // A bare `FeatureCollection` used to be rejected as "not CityJSON". It is now
  // a format this reads, so the honest complaint is the one that is actually
  // true of the file: it has no features in it.
  await openGeoref(page);
  await cityInput(page).setInputFiles([
    {
      name: "empty.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"type":"FeatureCollection","features":[]}'),
    },
  ]);

  await expect(page.getByText(/no features/i)).toBeVisible();
  await expect(page.locator("[data-context-model='true']")).toHaveCount(0);
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Load context" })).toBeEnabled();

  // A failed load clears its busy state so another context can be opened.
  await cityInput(page).setInputFiles(CITY);
  expect(await triangles(page)).toBeGreaterThan(0);
});

test("rejects a file that is neither format", async ({ page }) => {
  await openGeoref(page);
  await cityInput(page).setInputFiles([
    {
      name: "nonsense.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"type":"Spreadsheet","rows":[]}'),
    },
  ]);

  await expect(page.locator("[data-context-model='true']")).toHaveCount(0);
});

test("sends nothing to the network while reading a city model", async ({
  page,
  baseURL,
}) => {
  const ownOrigin = new URL(baseURL!).origin;
  const foreign: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).origin !== ownOrigin) foreign.push(r.url());
  });

  await openGeoref(page);
  await cityInput(page).setInputFiles([CITY]);
  await expect(page.locator("[data-context-model='true']")).toBeAttached({
    timeout: 30_000,
  });

  expect(foreign).toEqual([]);
});
