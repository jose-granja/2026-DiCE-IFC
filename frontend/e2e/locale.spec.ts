import { expect, test } from "@playwright/test";

/**
 * The language toggle.
 *
 * This exists because the toggle shipped doing nothing visible. Every piece of
 * plumbing was correct — the cookie was set, `<html lang>` changed, the request
 * config resolved the right messages — but no component ever called
 * `useTranslations`, so all 125 of them rendered hard-coded English. The whole
 * app was English while the default locale said Portuguese.
 *
 * So these tests assert on **rendered text**, never on the cookie or the `lang`
 * attribute. Those were green throughout and told us nothing.
 */

/**
 * The navigation, specifically.
 *
 * Module titles now render in two places — the header and the home page cards —
 * from the same message key, so an unscoped locator matches twice.
 */
function nav(page: import("@playwright/test").Page) {
  return page.getByRole("banner");
}

/** The toggle is icon-only; both labels are reachable from it. */
async function choose(page: import("@playwright/test").Page, label: string) {
  await nav(page).getByRole("button", { name: /Language|Idioma/ }).click();
  await page.getByRole("menuitem", { name: label }).click();
}

test("switching to Portuguese changes what is on screen", async ({ page }) => {
  await page.goto("/");
  await choose(page, "Português");

  await expect(
    page.getByRole("heading", { name: "Uma ferramenta BIM que nunca envia os seus modelos" }),
  ).toBeVisible();
  // Navigation too, not just the page body — the module titles come from the
  // same message catalogue and used to be constants in `config/`.
  await expect(nav(page).getByRole("link", { name: "Visualizador" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Processado localmente/ }).first()).toBeVisible();
});

test("switching back to English changes it back", async ({ page }) => {
  await page.goto("/");
  await choose(page, "Português");
  await expect(nav(page).getByRole("link", { name: "Visualizador" })).toBeVisible();

  await choose(page, "English");
  await expect(
    page.getByRole("heading", { name: "A BIM toolkit that never uploads your models" }),
  ).toBeVisible();
  await expect(nav(page).getByRole("link", { name: "Viewer" })).toBeVisible();
});

test("the choice survives a reload and applies to other pages", async ({ page }) => {
  await page.goto("/");
  await choose(page, "Português");
  // Wait for the switch to land before reloading: the choice is a Server Action
  // followed by a refresh, and reloading into the middle of it would test the
  // race rather than the persistence.
  await expect(nav(page).getByRole("link", { name: "Visualizador" })).toBeVisible();

  // The choice is a cookie, so it has to outlive the page it was made on.
  const cookie = (await page.context().cookies()).find((c) => c.name === "dice-locale");
  expect(cookie?.value).toBe("pt");

  await page.reload();
  await expect(nav(page).getByRole("link", { name: "Visualizador" })).toBeVisible();

  // The privacy page is what the badge on every module links to, so it is the
  // page a Portuguese user is most likely to be sent to.
  await page.goto("/privacy");
  await expect(
    page.getByRole("heading", { name: "O que sai do seu dispositivo" }),
  ).toBeVisible();
  await expect(page.getByText("Mosaicos de mapa")).toBeVisible();
});

test("the document language matches what is rendered", async ({ page }) => {
  // Not sufficient on its own — this attribute was correct the whole time the
  // toggle did nothing — but it has to agree with the text for screen readers
  // and hyphenation.
  await page.goto("/");
  await choose(page, "Português");

  await expect(page.locator("html")).toHaveAttribute("lang", "pt");
  await expect(nav(page).getByRole("link", { name: "Visualizador" })).toBeVisible();
});

test("every key used by the shell exists in both catalogues", async ({ page }) => {
  // A missing key renders as the key path itself, which looks like a bug the
  // user cannot explain. next-intl's fallback returns "namespace.key".
  for (const locale of ["pt", "en"]) {
    await page.context().addCookies([
      { name: "dice-locale", value: locale, url: "http://127.0.0.1:3000" },
    ]);
    for (const path of ["/", "/privacy", "/about", "/sign/setup"]) {
      await page.goto(path);
      const body = await page.locator("body").innerText();
      expect(body, `${locale} ${path}`).not.toMatch(
        /\b(app|nav|privacy|modules|auth)\.[a-zA-Z]+\.?[a-zA-Z]*\b/,
      );
    }
  }
});
