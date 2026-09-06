import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * [F13] Every state is a page, and a page is entered by its heading.
 *
 * §13.2 puts axe-core on every screen; three states had no level-1 heading at all and
 * axe flagged each with `page-has-heading-one` — the Sheet's "no record" branch, the same
 * screen's deleted tombstone, and the boundary's "Storage isn't available". Each of the
 * three is a whole screen, reached by a route or by a fault, with nothing above it: for a
 * screen-reader user arriving by heading navigation there was nothing to arrive at.
 *
 * The instrument is axe rather than a DOM count, because §13.2 names axe and because the
 * rule is the one that failed. The count is asserted too — one `<h1>`, not two — since
 * "add an h1" has an obvious wrong way to do it.
 */

const VIN = "1HGCM82633A004352";

/** §5.4 kicks on save and vPIC is unreachable from here; stubbed as decode.spec.ts does. */
const VPIC = "**/api/vehicles/DecodeVinValues/**";

/** Reads that throw once the database is open: the fault that reaches the boundary. */
const BREAK_LIST_READS = () => {
  const proto = IDBIndex.prototype as unknown as Record<string, unknown>;
  for (const name of ["getAll", "openCursor"]) {
    proto[name] = function () {
      const error = new Error("Connection to Indexed Database server lost");
      error.name = "UnknownError";
      throw error;
    };
  }
};

async function headings(page: import("@playwright/test").Page) {
  const found = await new AxeBuilder({ page }).analyze();
  return {
    h1s: await page.locator("h1").count(),
    missingH1: found.violations.filter((v) => v.id === "page-has-heading-one").length,
    // Nothing here is allowed to trade one violation for a worse one.
    bad: found.violations
      .filter((v) => v.impact === "critical" || v.impact === "serious")
      .map((v) => v.id),
  };
}

test.beforeEach(async ({ page }) => {
  await page.route(VPIC, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ Results: [{ Make: "HONDA", Model: "Accord", ErrorCode: "0" }] }),
    }),
  );
});

test("[F13] the Sheet's no-record state has a level-1 heading", async ({ page }) => {
  await page.goto(`/#/v/${VIN}`);
  await expect(page.getByText("No record for this VIN.")).toBeVisible();

  expect(await headings(page)).toEqual({ h1s: 1, missingH1: 0, bad: [] });
});

test("[F13] the deleted-vehicle state has a level-1 heading", async ({ page }) => {
  await page.goto("/#/scan");
  await page.getByRole("button", { name: /type vin instead/i }).click();
  await page.getByRole("textbox", { name: /vin/i }).fill(VIN);
  await page.getByRole("button", { name: "Save VIN" }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));

  // §9-S4's soft delete: arm, then confirm. The tombstone is the state under test.
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Vehicle deleted")).toBeVisible();

  expect(await headings(page)).toEqual({ h1s: 1, missingH1: 0, bad: [] });
});

test("[F13] the storage-failure notice has a level-1 heading", async ({ page }) => {
  await page.addInitScript(BREAK_LIST_READS);
  await page.goto("/#/history");
  await expect(page.getByText("Storage isn't available")).toBeVisible({ timeout: 10_000 });

  expect(await headings(page)).toEqual({ h1s: 1, missingH1: 0, bad: [] });
});

/**
 * The other half: a notice that sits *inside* a screen does not become a second heading.
 * Settings renders the same component under its own "Settings" h1 when storage refuses.
 */
test("[F13] the same notice inside a screen leaves that screen one heading", async ({ page }) => {
  await page.addInitScript(() => {
    indexedDB.open = function () {
      throw new DOMException("The user denied permission to access the database.", "SecurityError");
    };
  });
  await page.goto("/#/settings");
  await expect(page.getByText("Storage isn't available")).toBeVisible({ timeout: 10_000 });

  expect(await headings(page)).toEqual({ h1s: 1, missingH1: 0, bad: [] });
});
