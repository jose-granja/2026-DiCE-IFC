import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { unzipSync, strFromU8 } from "fflate";

/**
 * Clash detection, end to end: a matrix saved in the browser, two models'
 * worth of filters run against real geometry, the results walked in the
 * viewer, and an issue set exported with an image per clash.
 */

const FIXTURE = path.resolve(__dirname, "../fixtures/ifc/clash-ifc4.ifc");

const empty = {
  classes: [],
  names: [],
  predefinedTypes: [],
  objectTypes: [],
  materials: [],
  materialCategories: [],
  properties: [],
};

/** Walls × ducts (hard) and walls × pipes (clearance), as the panel would store them. */
const MATRIX = {
  groups: [
    { id: "g-walls", name: "Walls", discipline: "Architectural", filter: { ...empty, classes: ["IfcWall*"] } },
    { id: "g-ducts", name: "Ducts", discipline: "MEP", filter: { ...empty, classes: ["IfcDuctSegment"] } },
    { id: "g-pipes", name: "Pipes", discipline: "MEP", filter: { ...empty, names: ["Pipe*"] } },
    { id: "g-slab", name: "Slabs", filter: { ...empty, classes: ["IfcSlab"] } },
  ],
  tolerances: [
    { id: "t-hard", name: "Hard", mode: "hard", horizontal: 0.01, vertical: 0.01, clearance: 0 },
    { id: "t-gap", name: "Gap 200 mm", mode: "clearance", horizontal: 0, vertical: 0, clearance: 0.2 },
  ],
  rules: [
    { a: "g-walls", b: "g-ducts", toleranceId: "t-hard" },
    { a: "g-walls", b: "g-pipes", toleranceId: "t-gap" },
    { a: "g-walls", b: "g-slab", toleranceId: "t-hard" },
  ],
  settings: { checkOverlap: true, checkInside: true, checkDuplicate: true, ignoreSameModel: false, maxClashes: 100 },
};

async function open(page: import("@playwright/test").Page) {
  await page.addInitScript((matrix) => {
    window.localStorage.setItem("dice-ifc.clash-matrix.v1", JSON.stringify(matrix));
  }, MATRIX);
  await page.goto("/viewer?panel=clash");
  await page.setInputFiles('input[type="file"]', [FIXTURE]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
}

test("finds the duct through the wall and the pipe too close to it", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByText(/2 clashes in/)).toBeVisible({ timeout: 60_000 });

  const items = page.locator("[data-clash-item]");
  await expect(items).toHaveCount(2);
  await expect(page.locator("[data-clash-list]").first()).toContainText("Hard");
  // The wall and the far-away slab never meet.
  await expect(page.getByText("Walls × Slabs")).toHaveCount(0);
  await expect(page.getByText(/100 mm gap/)).toBeVisible();

  // Clicking a clash selects both elements.
  await items.first().getByRole("button").first().click();
  expect(errors).toEqual([]);
});

test("exports the clashes to BCF with an image each", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByText(/2 clashes in/)).toBeVisible({ timeout: 60_000 });

  const download = page.waitForEvent("download", { timeout: 120_000 });
  await page.getByRole("button", { name: /^Export BCF/ }).click();
  const file = await download;

  const zip = unzipSync(new Uint8Array(fs.readFileSync(await file.path())));
  const names = Object.keys(zip);
  const markups = names.filter((name) => name.endsWith("markup.bcf"));
  expect(markups).toHaveLength(2);
  expect(names.filter((name) => name.endsWith(".png"))).toHaveLength(2);
  const text = markups.map((name) => strFromU8(zip[name])).join("\n");
  expect(text).toContain("Duct crossing the wall");
  expect(text).toContain("Pipe near the wall");
  expect(text).toMatch(/TopicType="Clash"/);

  // And it lands in the BCF manager.
  await page.getByRole("tab", { name: "BCF" }).click();
  await expect(page.getByText(/Duct crossing the wall|Pipe near the wall/).first()).toBeVisible();
});

test("an empty group is refused instead of selecting the whole model", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "dice-ifc.clash-matrix.v1",
      JSON.stringify({
        groups: [
          { id: "a", name: "A", filter: { classes: [], names: [], predefinedTypes: [], objectTypes: [], materials: [], materialCategories: [], properties: [] } },
          { id: "b", name: "B", filter: { classes: ["IfcWall"], names: [], predefinedTypes: [], objectTypes: [], materials: [], materialCategories: [], properties: [] } },
        ],
        tolerances: [{ id: "t", name: "T", mode: "hard", horizontal: 0, vertical: 0, clearance: 0 }],
        rules: [{ a: "a", b: "b", toleranceId: "t" }],
      }),
    );
  });
  await page.goto("/viewer?panel=clash");
  await page.setInputFiles('input[type="file"]', [FIXTURE]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.locator("p[role=alert]")).toContainText("has no filter");
});

test("the residential template fills an empty matrix and finds the duct through the wall", async ({ page }) => {
  // No stored matrix: this is what someone sees the first time.
  await page.goto("/viewer?panel=clash");
  await page.setInputFiles('input[type="file"]', [FIXTURE]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });

  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
  const offer = page.locator("[data-clash-template-offer]");
  await expect(offer).toBeVisible();
  await offer.getByRole("button", { name: "Use residential template" }).click();

  await expect(page.getByText(/Residential template loaded/)).toBeVisible();
  // The groups tab now lists the template's groups…
  await expect(page.locator('input[value="HVAC ducts"]')).toBeVisible();
  // Groups that share IFC classes say what the project still has to filter.
  await expect(page.locator("[data-clash-group-note]").first()).toContainText(/model|system|CLZ_/i);
  // …the matrix tab shows them as a grid with cells filled in…
  await page.getByRole("tab", { name: /^Matrix/ }).click();
  const grid = page.locator("[data-clash-matrix]");
  await expect(grid).toBeVisible();
  expect(await grid.locator("select").count()).toBeGreaterThan(150);
  // …and the model can be checked against it straight away.
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByText(/\d+ clash(es)? in/)).toBeVisible({ timeout: 60_000 });
});

test("loading the template over an existing matrix can be undone", async ({ page }) => {
  await open(page);
  await expect(page.locator('input[value="Slabs"]')).toBeVisible();

  await page.getByRole("button", { name: "Use residential template" }).click();
  await expect(page.locator('input[value="HVAC ducts"]')).toBeVisible();
  await expect(page.locator('input[value="Slabs"]')).toHaveCount(0);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator('input[value="HVAC ducts"]')).toHaveCount(0);
  await expect(page.locator('input[value="Slabs"]')).toBeVisible();
});

test("the template can be taken as an Excel workbook", async ({ page }) => {
  await page.goto("/viewer?panel=clash");
  await page.setInputFiles('input[type="file"]', [FIXTURE]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });

  const download = page.waitForEvent("download");
  await page.locator("[data-clash-template-offer]").getByRole("button", { name: "Download as Excel" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("clash-matrix-residential-template.xlsx");
});

/**
 * A clash group defined by classification rather than by IFC class — how a
 * coordinator working to Uniclass actually names a discipline. The fixture
 * classifies the wall and the duct in Uniclass and the pipe only in a national
 * system, so the run must find the duct-through-wall clash and not the pipe.
 */
test("runs a matrix whose groups are defined by classification code", async ({ page }) => {
  const byCode = {
    groups: [
      {
        id: "g-walls",
        name: "Walls",
        filter: {
          ...empty,
          classificationSystem: "Uniclass 2015",
          classificationCodes: ["Ss_25_10_30"],
        },
      },
      {
        id: "g-ducts",
        name: "Ducts",
        filter: { ...empty, classificationSystem: "Uniclass 2015", classificationCodes: ["Ss_65*"] },
      },
      // Classified, but in the other system — so "Uniclass Ss_55*" must not reach it.
      {
        id: "g-pipes",
        name: "Pipes",
        filter: { ...empty, classificationSystem: "Uniclass 2015", classificationCodes: ["EF_55_30"] },
      },
    ],
    tolerances: [
      { id: "t-hard", name: "Hard", mode: "hard", horizontal: 0.01, vertical: 0.01, clearance: 0 },
      // Wide enough to catch the pipe 100 mm from the wall — so if the
      // classification were ignored and the group selected everything, this
      // rule would report a clash. Its silence is the assertion.
      { id: "t-gap", name: "Gap 200 mm", mode: "clearance", horizontal: 0, vertical: 0, clearance: 0.2 },
    ],
    rules: [
      { a: "g-walls", b: "g-ducts", toleranceId: "t-hard" },
      { a: "g-walls", b: "g-pipes", toleranceId: "t-gap" },
    ],
    settings: { checkOverlap: true, checkInside: true, checkDuplicate: true, ignoreSameModel: false, maxClashes: 100 },
  };

  await page.addInitScript((matrix) => {
    window.localStorage.setItem("dice-ifc.clash-matrix.v1", JSON.stringify(matrix));
  }, byCode);
  await page.goto("/viewer?panel=clash");
  await page.setInputFiles('input[type="file"]', [
    path.resolve(__dirname, "../fixtures/ifc/classified-clash-ifc4.ifc"),
  ]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });

  // The groups say how many elements each code selected.
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByText(/1 clash in/)).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("[data-clash-item]")).toHaveCount(1);
  const list = page.locator("[data-clash-list]").first();
  await expect(list).toContainText("Wall A");
  await expect(list).toContainText("Duct crossing the wall");
  // The pipe is EF_55_30 in the national system, not in Uniclass, so the
  // "Uniclass EF_55_30" group selects nothing and the pipe is never tested.
  await expect(list).not.toContainText("Pipe near the wall");

  // And the group itself reports that it selected nothing, rather than silently
  // matching every element in the model.
  await page.getByRole("tab", { name: "Groups" }).click();
  // In matrix order: Walls, Ducts, Pipes. (The name lives in an input, so the
  // cards are addressed by position rather than by text.)
  const groups = page.locator("[data-clash-group]");
  await expect(groups.nth(0)).toContainText("1 element");
  await expect(groups.nth(1)).toContainText("1 element");
  await expect(groups.nth(2)).toContainText("0 elements");
});

test("edits a group's classification filter in the panel", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.removeItem("dice-ifc.clash-matrix.v1");
  });
  await page.goto("/viewer?panel=clash");
  await page.setInputFiles('input[type="file"]', [
    path.resolve(__dirname, "../fixtures/ifc/classified-clash-ifc4.ifc"),
  ]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });

  await page.getByRole("button", { name: "Add group" }).click();
  const group = page.locator("[data-clash-group]").first();

  // A group with nothing but a classification is a real group, not an empty one.
  await expect(group).toContainText("No filter yet");
  await group.getByLabel("Classification system").fill("Uniclass 2015");
  await group.getByLabel("Classification code").fill("Ss_25_10_30");
  await group.getByLabel("Classification code").press("Enter");
  await expect(group).not.toContainText("No filter yet");

  // The system's own codes are offered once it is named.
  const options = await group
    .getByLabel("Classification code")
    .evaluate((input: HTMLInputElement) =>
      [...(document.getElementById(input.getAttribute("list")!) as HTMLDataListElement).options].map(
        (option) => option.value,
      ),
    );
  expect(options).toEqual(["Ss_25_10_30", "Ss_65_40_33"]);
});
