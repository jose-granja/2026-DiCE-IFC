import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Section planes and measurement, exercised through the real renderer.
 *
 * Vitest covers the arithmetic. What only a browser can show is whether the
 * clip planes reach the materials, whether picking returns a point on the
 * surface, and whether the labels land where the geometry is.
 */

const IFC4 = path.resolve(
  __dirname,
  "../fixtures/ifc/georeferenced-wall-ifc4.ifc",
);
const NEIGHBOUR = path.resolve(
  __dirname,
  "../fixtures/cityjson/neighbour.city.json",
);

async function loadModel(page: Page) {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [IFC4]);
  // Wait for geometry to reach the renderer, not just for metadata: clicking
  // the canvas before then hits nothing and the test fails intermittently.
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({
    timeout: 60_000,
  });
}

/** The model plus a context building standing right next to it. */
async function loadModelWithContext(page: Page) {
  await loadModel(page);
  await page.getByRole("tab", { name: "GIS" }).click();
  await page.locator('input[accept*=".city.json"]').setInputFiles([NEIGHBOUR]);
  await expect(page.locator("[data-context-model='true']")).toBeAttached({
    timeout: 30_000,
  });
  await page.getByRole("tab", { name: "Measure" }).click();
}

/** Canvas centre, which the fixture's geometry sits at after "Fit view". */
async function canvasCentre(page: Page) {
  const box = (await page.locator("[data-model-canvas]").boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A WebGL gizmo point projected into page coordinates by the renderer. */
async function sectionHandlePoint(page: Page, attribute: string) {
  const viewer = page.locator("[data-rendered-models]");
  await expect(viewer).toHaveAttribute(attribute, /-?\d+(?:\.\d+)?,-?\d/);
  const encoded = await viewer.getAttribute(attribute);
  const [x, y] = encoded!.split(",").map(Number);
  const canvas = (await page.locator("[data-model-canvas]").boundingBox())!;
  return { x: canvas.x + x, y: canvas.y + y };
}

/**
 * Whether the snap preview marker is currently showing.
 *
 * Read from `data-snap-preview` on the same marker element `data-rendered-
 * models`/`data-visible-entities` already use for scene state a test needs
 * to ask about directly, rather than trust the code that decided to draw
 * it — it updates on every pointer move, too often to be React state.
 */
async function snapPreviewVisible(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      document.querySelector("[data-rendered-models]")?.getAttribute("data-snap-preview") ===
      "true",
  );
}

/** Which shape the visible snap preview marker is — "corner", "edgeMidpoint", "edge" or null. */
async function snapPreviewType(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      document
        .querySelector("[data-rendered-models]")
        ?.getAttribute("data-snap-preview-type") ?? null,
  );
}

test.describe("section planes", () => {
  test("adds a plan cut positioned on the model, not at the origin", async ({
    page,
  }) => {
    await loadModel(page);
    await page.getByRole("tab", { name: "Section" }).click();

    await expect(page.getByText(/No section planes/)).toBeVisible();
    await page.getByRole("button", { name: /Plan/ }).click();

    // The fixture spans y 0–3, so a centred plane lands at 1.50 m. A plane
    // defaulted to 0 would sit on the model's underside and appear to do nothing.
    await expect(page.getByText("1.50 m")).toBeVisible();
    await expect(page.getByRole("slider", { name: /Plan position/i })).toBeVisible();
  });

  test("can be disabled, flipped and removed", async ({ page }) => {
    await loadModel(page);
    await page.getByRole("tab", { name: "Section" }).click();
    await page.getByRole("button", { name: /Plan/ }).click();

    const slider = page.getByRole("slider", { name: /Plan position/i });
    const flip = page.getByRole("button", { name: /Flip which side/i });

    await expect(flip).toHaveAttribute("aria-pressed", "false");
    await flip.click();
    await expect(flip).toHaveAttribute("aria-pressed", "true");

    // Disabling greys the slider rather than removing the plane, so the
    // position is not lost. Named explicitly: the panel also has its own
    // "Show cut fill" checkbox above the plane list, so `.first()` is not
    // reliably this plane's own enabled checkbox.
    await page.getByRole("checkbox", { name: "Plan" }).click();
    await expect(slider).toHaveAttribute("aria-disabled", "true");

    await page.getByRole("button", { name: "Remove section plane" }).click();
    await expect(page.getByText(/No section planes/)).toBeVisible();
  });

  test("several planes intersect", async ({ page }) => {
    await loadModel(page);
    await page.getByRole("tab", { name: "Section" }).click();

    await page.getByRole("button", { name: /Plan/ }).click();
    await page.getByRole("button", { name: /Section X/ }).click();

    await expect(
      page.getByRole("button", { name: "Remove section plane" }),
    ).toHaveCount(2);
  });

  test("rotates and moves a vertical plane with viewer handles", async ({ page }) => {
    await loadModel(page);
    await page.getByRole("tab", { name: "Section" }).click();
    await page.getByRole("button", { name: /Section X/ }).click();

    const viewer = page.locator("[data-rendered-models]");
    const position = page.getByRole("slider", { name: /Section X position/i });
    const rotation = page.getByRole("slider", {
      name: /Section X rotation around the vertical axis/i,
    });
    await expect(viewer).toHaveAttribute("data-section-gizmo-count", "1");
    await expect(rotation).toHaveAttribute("aria-valuenow", "0");

    const positionBefore = await position.getAttribute("aria-valuenow");
    const centre = await sectionHandlePoint(page, "data-section-handle-centre");
    const move = await sectionHandlePoint(page, "data-section-move-handle");
    const length = Math.hypot(move.x - centre.x, move.y - centre.y);
    const dx = (move.x - centre.x) / length;
    const dy = (move.y - centre.y) / length;
    await page.mouse.move(move.x, move.y);
    await page.mouse.down();
    await page.mouse.move(move.x + dx * 28, move.y + dy * 28, { steps: 5 });
    await page.mouse.up();
    await expect(position).not.toHaveAttribute("aria-valuenow", positionBefore!);

    const rotateFrom = await sectionHandlePoint(
      page,
      "data-section-rotate-handle",
    );
    const rotateTo = await sectionHandlePoint(
      page,
      "data-section-rotate-target",
    );
    await page.mouse.move(rotateFrom.x, rotateFrom.y);
    await page.mouse.down();
    await page.mouse.move(rotateTo.x, rotateTo.y, { steps: 8 });
    await page.mouse.up();
    await expect(rotation).not.toHaveAttribute("aria-valuenow", "0");
  });

  test("renders without errors while sectioning", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await loadModel(page);
    await page.getByRole("tab", { name: "Section" }).click();
    await page.getByRole("button", { name: /Plan/ }).click();

    // Sweep the plane across the model: clipping is applied per frame, so a
    // broken plane array shows up here rather than on the first render.
    const slider = page.getByRole("slider", { name: /Plan position/i });
    await slider.press("ArrowRight");
    await slider.press("ArrowRight");
    await slider.press("ArrowLeft");
    await page.waitForTimeout(800);

    expect(errors).toEqual([]);
  });
});

test.describe("measurement", () => {
  test("measures between two points on the model", async ({ page }) => {
    await loadModel(page);
    await page.getByRole("tab", { name: "Measure" }).click();

    await expect(page.getByText("No measurements yet.")).toBeVisible();
    await page.getByRole("button", { name: "Distance" }).click();
    await expect(page.getByText(/Click two points/)).toBeVisible();

    const centre = await canvasCentre(page);
    await page.mouse.click(centre.x - 60, centre.y);
    await expect(page.getByText(/Click a second point/)).toBeVisible();
    await page.mouse.click(centre.x + 60, centre.y);

    // A completed measurement reports the distance plus its plan and vertical
    // components, and draws a label over the canvas.
    await expect(page.getByText(/^Plan .* · Vertical/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Remove distance 1/ })).toBeVisible();
  });

  test("Esc cancels a half-finished measurement", async ({ page }) => {
    await loadModel(page);
    await page.getByRole("tab", { name: "Measure" }).click();
    await page.getByRole("button", { name: "Distance" }).click();

    const centre = await canvasCentre(page);
    await page.mouse.click(centre.x - 60, centre.y);
    await expect(page.getByText(/Click a second point/)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByText(/Click two points/)).toBeVisible();
    await expect(page.getByText("No measurements yet.")).toBeVisible();
  });

  test("clicking empty space does not place a point", async ({ page }) => {
    await loadModel(page);
    await page.getByRole("tab", { name: "Measure" }).click();
    await page.getByRole("button", { name: "Distance" }).click();

    // Dropping a point onto nothing would put it on the far clip plane and
    // produce a confidently wrong number.
    //
    // Top-centre: above the fitted model, so nothing is there to be hit.
    // The side panels are docked in their own layout space now (`page.tsx`),
    // not floating over the canvas, so `data-model-canvas`'s bounding box is
    // already just the visible area — any point in it would do.
    const box = (await page.locator("[data-model-canvas]").boundingBox())!;
    const target = { x: box.x + box.width / 2, y: box.y + 16 };

    // Prove the click reaches the canvas rather than, say, a mispositioned
    // overlay swallowing it — which would make this pass having tested
    // nothing.
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? "none",
      target,
    );
    expect(hit).toBe("CANVAS");

    await page.mouse.click(target.x, target.y);

    await expect(page.getByText(/Click two points/)).toBeVisible();
    await expect(page.getByText("No measurements yet.")).toBeVisible();
  });

  test("leaving measure mode drops the pending point", async ({ page }) => {
    await loadModel(page);
    await page.getByRole("tab", { name: "Measure" }).click();
    await page.getByRole("button", { name: "Distance" }).click();

    const centre = await canvasCentre(page);
    await page.mouse.click(centre.x - 60, centre.y);

    // Clicking the active tool's own button toggles it off, back to select.
    await page.getByRole("button", { name: "Distance" }).click();
    await page.getByRole("button", { name: "Distance" }).click();

    // A stray point would otherwise complete on the next unrelated click.
    await expect(page.getByText(/Click two points/)).toBeVisible();
  });

  test("measuring does not select, and selecting does not measure", async ({
    page,
  }) => {
    await loadModel(page);
    const centre = await canvasCentre(page);

    // Select mode is the default: a click selects.
    await page.mouse.click(centre.x, centre.y);
    await expect(page.getByRole("heading", { name: /Wall A|Slab A/ })).toBeVisible();

    await page.getByRole("tab", { name: "Measure" }).click();
    await page.getByRole("button", { name: "Distance" }).click();

    // In measure mode the same click must not change the selection.
    await page.mouse.click(centre.x - 40, centre.y);
    await page.mouse.click(centre.x + 40, centre.y);
    await expect(page.getByRole("heading", { name: /Wall A|Slab A/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Remove distance 1/ })).toBeVisible();
  });

  test("dragging to orbit the camera does not place a measurement point", async ({
    page,
  }) => {
    // OrbitControls and the measurement tool both start from the same
    // pointerdown on the same canvas — a drag to rotate the camera must not
    // also drop a point at wherever the drag happened to begin.
    await loadModel(page);
    await page.getByRole("tab", { name: "Measure" }).click();
    await page.getByRole("button", { name: "Distance" }).click();

    const centre = await canvasCentre(page);
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    // Far enough, over enough steps, to be unmistakably a drag rather than a
    // click that merely wobbled a pixel or two.
    await page.mouse.move(centre.x + 150, centre.y + 80, { steps: 10 });
    await page.mouse.up();

    await expect(page.getByText(/Click two points/)).toBeVisible();
    await expect(page.getByText("No measurements yet.")).toBeVisible();

    // A genuine click right after still works — the fix only suppresses drags.
    await page.mouse.click(centre.x - 60, centre.y);
    await expect(page.getByText(/Click a second point/)).toBeVisible();
  });

  test("dragging to orbit the camera does not change the selection", async ({
    page,
  }) => {
    await loadModel(page);
    const centre = await canvasCentre(page);

    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x + 150, centre.y + 80, { steps: 10 });
    await page.mouse.up();

    await expect(
      page.getByText("Select an element in the viewport or the tree."),
    ).toBeVisible();
  });

  test("draws horizontal and vertical guide labels over the canvas", async ({
    page,
  }) => {
    // The panel already reported plan/vertical as text; this is the same
    // breakdown drawn on the model, at the leg it belongs to — scoped to the
    // labels overlay so it cannot pass on the panel row's own "Plan … ·
    // Vertical …" text instead.
    await loadModel(page);
    await page.getByRole("tab", { name: "Measure" }).click();
    await page.getByRole("button", { name: "Distance" }).click();

    // Offset in both screen axes, not just x: the camera sits at an oblique
    // angle (`fitToBounds`), so a diagonal drag reliably lands two points
    // that differ in world Y as well as the plan axes — a same-height click
    // could land a near-zero vertical leg, which is deliberately not drawn
    // (see `NEGLIGIBLE_LEG`), and flake this test.
    const centre = await canvasCentre(page);
    await page.mouse.click(centre.x - 60, centre.y - 40);
    await page.mouse.click(centre.x + 60, centre.y + 40);

    const overlay = page.locator("[data-measurement-labels]");
    await expect(overlay.getByText(/^Plan /)).toBeVisible();
    await expect(overlay.getByText(/^Vertical /)).toBeVisible();
  });

  test("snap can be turned off, and the hint says so", async ({ page }) => {
    await loadModel(page);
    await page.getByRole("tab", { name: "Measure" }).click();
    await expect(page.getByLabel("Corners")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Edge midpoints")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByLabel("Edges")).toHaveAttribute("aria-pressed", "false");

    await page.getByRole("button", { name: "Distance" }).click();
    await expect(page.getByText(/snap to nearby corners/i)).toBeVisible();

    await page.getByLabel("Corners").click();
    await expect(page.getByLabel("Corners")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByText(/snapping is off/i)).toBeVisible();
  });

  test("each snap target can be enabled independently, and the hint lists them", async ({
    page,
  }) => {
    await loadModel(page);
    await page.getByRole("tab", { name: "Measure" }).click();
    await page.getByRole("button", { name: "Distance" }).click();

    await page.getByLabel("Edge midpoints").click();
    await expect(page.getByText(/snap to nearby corners and edge midpoints/i)).toBeVisible();

    await page.getByLabel("Edges").click();
    await expect(
      page.getByText(/snap to nearby corners, edge midpoints and edges/i),
    ).toBeVisible();
  });

  test("previews where the next click would snap, before it happens", async ({
    page,
  }) => {
    await loadModel(page);
    await page.getByRole("tab", { name: "Measure" }).click();
    await page.getByRole("button", { name: "Distance" }).click();

    const box = (await page.locator("[data-model-canvas]").boundingBox())!;

    // Wall A's near top corner after "Fit view" — found empirically and
    // pinned here, the same way `canvasCentre` pins the fixture's own
    // landing spot. A grid built from the canvas centre is tempting but was
    // the wrong tool: a coarse step easily overshoots a snap radius that is
    // only a few percent of the canvas, and a fixed corner is exactly
    // reproducible run to run — the fixture and the "Fit view" framing are
    // both deterministic.
    const corner = { x: box.x + box.width * 0.37, y: box.y + box.height * 0.27 };
    await page.mouse.move(corner.x, corner.y);
    expect(await snapPreviewVisible(page)).toBe(true);
    // Corners are the only enabled target here, so the marker showing at all
    // must be the square, not one of the other two shapes.
    expect(await snapPreviewType(page)).toBe("corner");

    // Moving off the model drops it again — nothing there to snap to.
    await page.mouse.move(box.x + box.width - 10, box.y + 10);
    expect(await snapPreviewVisible(page)).toBe(false);
  });

  test("the snap preview never shows while every target is off", async ({ page }) => {
    await loadModel(page);
    await page.getByRole("tab", { name: "Measure" }).click();
    await page.getByRole("button", { name: "Distance" }).click();
    await page.getByLabel("Corners").click();

    const box = (await page.locator("[data-model-canvas]").boundingBox())!;
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(centre.x, centre.y);

    expect(await snapPreviewVisible(page)).toBe(false);
  });

  test("measures from the model to the context", async ({ page }) => {
    // The context mesh is deliberately excluded from element selection and
    // picking (`pick()`) — it is not an element — but the measurement tool's
    // own pick (`pickPoint()`) must still reach it, or "how far is my
    // building from its neighbour" has no answer.
    await loadModelWithContext(page);
    await page.getByRole("button", { name: "Distance" }).click();

    const centre = await canvasCentre(page);
    // On the model (the wall).
    await page.mouse.click(centre.x + 80, centre.y - 15);
    await expect(page.getByText(/Click a second point/)).toBeVisible();
    // On the context building, standing beside it.
    await page.mouse.click(centre.x - 80, centre.y - 65);

    await expect(page.getByRole("button", { name: /Remove distance 1/ })).toBeVisible();
    // Real endpoints on real surfaces a couple of metres apart, not the
    // zero-length or wildly-off-scale result a mis-picked point would give.
    // Two matches are expected — the panel row and the on-canvas label — so
    // this only checks that a real distance rendered somewhere, not which.
    await expect(page.getByText(/^\d+\.\d+ m$/).first()).toBeVisible();
    await expect(page.getByText(/^Plan .* · Vertical/)).toBeVisible();
  });
});

test.describe("angle measurement", () => {
  test("measures the angle at three clicked points", async ({ page }) => {
    await loadModel(page);
    await page.getByRole("tab", { name: "Measure" }).click();
    await page.getByRole("button", { name: "Angle" }).click();

    const centre = await canvasCentre(page);
    await page.mouse.click(centre.x - 60, centre.y - 40);
    await expect(page.getByText(/Click the corner/)).toBeVisible();
    await page.mouse.click(centre.x, centre.y);
    await expect(page.getByText(/Click the second point/)).toBeVisible();
    await page.mouse.click(centre.x + 60, centre.y + 40);

    // A completed angle reports degrees, in the panel and on the canvas.
    await expect(page.getByText(/^\d+\.\d°$/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Remove angle 1/ })).toBeVisible();
  });

  test("Esc cancels a half-finished angle", async ({ page }) => {
    await loadModel(page);
    await page.getByRole("tab", { name: "Measure" }).click();
    await page.getByRole("button", { name: "Angle" }).click();

    const centre = await canvasCentre(page);
    await page.mouse.click(centre.x - 60, centre.y);
    await expect(page.getByText(/Click the corner/)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByText(/Click the first point/)).toBeVisible();
    await expect(page.getByText("No measurements yet.")).toBeVisible();
  });

  test("leaving angle mode for a different tool drops the pending points", async ({
    page,
  }) => {
    await loadModel(page);
    await page.getByRole("tab", { name: "Measure" }).click();
    await page.getByRole("button", { name: "Angle" }).click();

    const centre = await canvasCentre(page);
    await page.mouse.click(centre.x - 60, centre.y);
    await page.mouse.click(centre.x, centre.y);
    await expect(page.getByText(/Click the second point/)).toBeVisible();

    await page.getByRole("button", { name: "Distance" }).click();
    await page.getByRole("button", { name: "Angle" }).click();

    await expect(page.getByText(/Click the first point/)).toBeVisible();
  });
});

test.describe("area measurement", () => {
  test("measures the area of a clicked polygon", async ({ page }) => {
    await loadModel(page);
    await page.getByRole("tab", { name: "Measure" }).click();
    await page.getByRole("button", { name: "Area" }).click();

    const centre = await canvasCentre(page);
    await page.mouse.click(centre.x - 60, centre.y - 40);
    await page.mouse.click(centre.x + 60, centre.y - 40);
    await page.mouse.click(centre.x + 60, centre.y + 40);

    const finish = page.getByRole("button", { name: /Finish/ });
    await expect(finish).toBeVisible();
    await finish.click();

    await expect(page.getByText(/m²/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Remove area 1/ })).toBeVisible();
  });

  test("Enter finishes an area once there are enough points", async ({ page }) => {
    await loadModel(page);
    await page.getByRole("tab", { name: "Measure" }).click();
    await page.getByRole("button", { name: "Area" }).click();

    const centre = await canvasCentre(page);
    await page.mouse.click(centre.x - 60, centre.y - 40);
    await page.mouse.click(centre.x + 60, centre.y - 40);
    await page.mouse.click(centre.x + 60, centre.y + 40);
    await page.keyboard.press("Enter");

    await expect(page.getByRole("button", { name: /Remove area 1/ })).toBeVisible();
  });

  test("Esc cancels a half-finished area", async ({ page }) => {
    await loadModel(page);
    await page.getByRole("tab", { name: "Measure" }).click();
    await page.getByRole("button", { name: "Area" }).click();

    const centre = await canvasCentre(page);
    await page.mouse.click(centre.x - 60, centre.y - 40);
    await page.mouse.click(centre.x + 60, centre.y - 40);
    await page.keyboard.press("Escape");

    await expect(page.getByText("No measurements yet.")).toBeVisible();
  });

  test("measures a clicked face's own area", async ({ page }) => {
    await loadModel(page);
    await page.getByRole("tab", { name: "Measure" }).click();
    await page.getByRole("button", { name: "Area" }).click();
    await page.getByRole("button", { name: "Clicked face" }).click();
    await expect(page.getByText(/Click any flat face/)).toBeVisible();
    // Face mode picks a whole entity, not a point, so there is nothing to
    // snap — the checkboxes describing that behaviour should not be shown.
    await expect(page.getByText("Snap to", { exact: true })).toBeHidden();

    const centre = await canvasCentre(page);
    await page.mouse.click(centre.x, centre.y);

    await expect(page.getByText(/m²/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Remove area 1/ })).toBeVisible();
    // Clicking a face to measure it also selects its element, reusing the
    // ordinary highlight rather than building a second one from scratch.
    await expect(page.getByRole("heading", { name: /Wall A|Slab A/ })).toBeVisible();
  });

  test("switching from face mode back to points mode shows the points workflow again", async ({
    page,
  }) => {
    await loadModel(page);
    await page.getByRole("tab", { name: "Measure" }).click();
    await page.getByRole("button", { name: "Area" }).click();
    await page.getByRole("button", { name: "Clicked face" }).click();
    await page.getByRole("button", { name: "Points I click" }).click();

    await expect(page.getByText(/Click points around the area/)).toBeVisible();
    await expect(page.getByText("Snap to", { exact: true })).toBeVisible();
  });
});

test.describe("volume measurement", () => {
  test("measures a clicked element's own volume", async ({ page }) => {
    await loadModel(page);
    await page.getByRole("tab", { name: "Measure" }).click();
    await page.getByRole("button", { name: "Volume" }).click();
    await expect(page.getByText(/Click any element/)).toBeVisible();

    const centre = await canvasCentre(page);
    await page.mouse.click(centre.x, centre.y);

    await expect(page.getByText(/m³/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Remove volume 1/ })).toBeVisible();
    // Clicking an element to measure it also selects it, reusing the
    // ordinary highlight rather than building a second one from scratch.
    await expect(page.getByRole("heading", { name: /Wall A|Slab A/ })).toBeVisible();
  });

  test("measures the volume of a box between two clicked corners", async ({ page }) => {
    await loadModel(page);
    await page.getByRole("tab", { name: "Measure" }).click();
    await page.getByRole("button", { name: "Volume" }).click();
    await page.getByRole("button", { name: "Box between two points" }).click();

    const centre = await canvasCentre(page);
    await page.mouse.click(centre.x - 60, centre.y - 40);
    await expect(page.getByText(/Click the opposite corner/)).toBeVisible();
    await page.mouse.click(centre.x + 60, centre.y + 40);

    await expect(page.getByText(/m³/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Remove volume 1/ })).toBeVisible();
  });

  test("Esc cancels a half-placed box", async ({ page }) => {
    await loadModel(page);
    await page.getByRole("tab", { name: "Measure" }).click();
    await page.getByRole("button", { name: "Volume" }).click();
    await page.getByRole("button", { name: "Box between two points" }).click();

    const centre = await canvasCentre(page);
    await page.mouse.click(centre.x - 60, centre.y);
    await page.keyboard.press("Escape");

    await expect(page.getByText("No measurements yet.")).toBeVisible();
  });
});

test.describe("display settings", () => {
  test("edges default on and can be toggled off", async ({ page }) => {
    await loadModel(page);
    await page.getByRole("button", { name: "Display" }).click();

    const edges = page.getByRole("switch", { name: "Show edges" });
    await expect(edges).toBeChecked();

    await edges.click();
    await expect(edges).not.toBeChecked();

    await edges.click();
    await expect(edges).toBeChecked();
  });

  test("lighting sliders update the displayed value live", async ({ page }) => {
    await loadModel(page);
    await page.getByRole("button", { name: "Display" }).click();

    await expect(page.getByText("1.00×")).toBeVisible();
    await expect(page.getByText("0.75", { exact: true })).toBeVisible();

    const brightness = page.getByRole("slider", { name: "Brightness" });
    await brightness.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByText("0.70", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Reset" }).click();
    await expect(page.getByText("0.75", { exact: true })).toBeVisible();
  });

  test("renders with no console errors while adjusting display settings", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));

    await loadModel(page);
    await page.getByRole("button", { name: "Display" }).click();
    await page.getByRole("switch", { name: "Show edges" }).click();
    const intensity = page.getByRole("slider", { name: "Light intensity" });
    await intensity.focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(500);

    expect(errors).toEqual([]);
  });
});
