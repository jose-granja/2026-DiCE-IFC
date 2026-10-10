import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * The Structure tab's tree: elements grouped by IFC class, and spaces
 * grouped the same way one level up.
 *
 * `spaces-ifc4.ifc` exists for this — three `IfcSpace`s and a wall under one
 * storey, with a wall that carries no geometric representation at all (legal
 * IFC), which is what exercises the "class known from properties, not
 * geometry" backfill path.
 */

const FIXTURE = path.resolve(__dirname, "../fixtures/ifc/spaces-ifc4.ifc");

async function openStorey(page: Page) {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [FIXTURE]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({
    timeout: 60_000,
  });

  await page.getByRole("tab", { name: "Structure" }).click();
  const storey = page.getByRole("treeitem", { name: /Level 0/ }).first();
  await storey.getByRole("button", { name: "Expand" }).first().click();
}

test("groups a storey's IfcSpace children under one collapsible IfcSpace group", async ({
  page,
}) => {
  await openStorey(page);

  // The group's own clickable header — not the `treeitem` div, which also
  // wraps its (currently expanded) children and so is not what a click on
  // the header itself resolves to.
  const spaceGroupHeader = page.getByRole("button", { name: /^IfcSpace/ });
  await expect(spaceGroupHeader).toBeVisible();
  await expect(spaceGroupHeader).toContainText("3");

  // Each space is still its own real, independently expandable tree node —
  // only the listing is grouped, not the node — so it shows by name.
  await expect(page.getByRole("treeitem", { name: /Office 101/ })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: /Office 102/ })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: /Corridor/ })).toBeVisible();

  // Collapsing the group hides its spaces without touching the wall group.
  await spaceGroupHeader.click();
  await expect(page.getByRole("treeitem", { name: /Office 101/ })).toHaveCount(0);
  await expect(page.getByRole("treeitem", { name: /^IfcWall/ })).toBeVisible();
});

test("groups elements by class and shows a class badge, even for a representation-less entity", async ({
  page,
}) => {
  await openStorey(page);

  const wallGroup = page.getByRole("treeitem", { name: /^IfcWall/ }).first();
  await expect(wallGroup).toContainText("1");

  // "Wall A" has `Representation = $` — no mesh, so its class cannot come
  // from geometry. It still lands in the IfcWall group and carries the
  // IfcWall badge once the properties fetch backfills `entityTypeByRef`.
  const wallRow = page.getByRole("treeitem", { name: /^Wall A/ });
  await expect(wallRow).toBeVisible();
  await expect(wallRow.getByText("IfcWall", { exact: true })).toBeVisible();
});

test("carries a class badge for every spatial-structure node, not only elements", async ({
  page,
}) => {
  await openStorey(page);

  // Every level of the decomposition — project, site, building, storey — not
  // a hardcoded subset. The row's own select button (as opposed to its
  // Collapse/Expand or Hide/Isolate buttons) names itself "<label> <badge>",
  // so this checks the badge lands on the right row for each level.
  await expect(
    page.getByRole("button", { name: "DiCE-IFC Spaces Fixture IfcProject" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Site IfcSite" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Building IfcBuilding" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Level 0.*IfcBuildingStorey/ }),
  ).toBeVisible();
});

test("selecting a spatial node shows its own properties, not a descendant's", async ({
  page,
}) => {
  await openStorey(page);

  // Clicking the storey's own row selects the whole subtree (so Hide/Isolate
  // apply to everything inside), but the information panel must resolve to
  // the storey's *own* attributes — not an arbitrary descendant that
  // traversal happened to visit last.
  await page.getByRole("button", { name: /^Level 0/ }).click();

  await expect(page.getByRole("heading", { name: "Level 0" })).toBeVisible();
  await expect(page.getByText("IfcBuildingStorey", { exact: true }).first()).toBeVisible();

  // Its own GlobalId, unique to the storey — proof this is the storey's own
  // record and not, say, "Wall A"'s (the last element the subtree traversal
  // would otherwise have visited).
  await expect(page.getByText("3ZvctVUKr0kugbFTf53O9L")).toBeVisible();
});
