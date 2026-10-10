import path from "node:path";
import { expect, test } from "@playwright/test";

const IFC4 = path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc");

test("closing a model removes its geometry from the scene, not just the list", async ({
  page,
}) => {
  // The store and the renderer are separate. A model can vanish from the list
  // and still be drawn, which is what this checks.
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [IFC4]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({
    timeout: 60_000,
  });
  await expect(page.locator("[data-rendered-models='1']")).toBeAttached({
    timeout: 30_000,
  });

  await page.getByRole("tab", { name: "Models" }).click();
  await page.getByRole("button", { name: /Close georeferenced-wall/i }).click();

  await expect(page.locator("[data-rendered-models='0']")).toBeAttached({
    timeout: 30_000,
  });
});
