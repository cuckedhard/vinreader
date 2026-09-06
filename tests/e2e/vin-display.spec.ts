import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * [R3-F6] §6.1: "VIN display: monospace, ≥ 28 px on phone, grouped per §4.1, letter-spaced."
 *
 * A12 fixed the scanner's candidate under this rule. Three more displays were still 18 px,
 * and one of them was not letter-spaced at all: the History row, the Import preview, and the
 * QR overlay — which is exactly where a second person reads the number off the screen to key
 * it in, and which renders its own `<p>` instead of `VinDisplay`.
 *
 * Measured as computed style on a phone-sized viewport, which is what §6.1's floor is about.
 * The §6.6 table is deliberately not in this list: it exists only at ≥ 900 px, so it is never
 * the phone this rule is written for, and its VIN column is what has to fit eight columns in
 * one container (F9).
 */

const VIN = "1HGCM82633A004352";
const GROUPED = "1HG CM826 3 3 A 004352";

/** §4.9's URL carrier for the same VIN, so the Import preview has something to preview. */
const PAYLOAD = Buffer.from(JSON.stringify({ v: 1, vin: VIN, mk: "HONDA", md: "Accord" }), "utf8")
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

const VPIC = "**/api/vehicles/DecodeVinValues/**";

async function vinStyle(target: Locator) {
  return target.evaluate((el) => {
    const css = getComputedStyle(el);
    return {
      size: parseFloat(css.fontSize),
      spacing: css.letterSpacing,
      family: css.fontFamily.toLowerCase(),
    };
  });
}

/** §6.1, all three properties at once — the QR view failed two of them. */
function expectVinDisplay(style: { size: number; spacing: string; family: string }, where: string) {
  expect(style.size, `${where}: font size`).toBeGreaterThanOrEqual(28);
  expect(style.spacing, `${where}: letter-spacing`).not.toBe("normal");
  expect(style.family, `${where}: font family`).toContain("mono");
}

async function typeAndSave(page: Page) {
  await page.goto("/#/scan");
  await page.getByRole("button", { name: /type vin instead/i }).click();
  await page.getByRole("textbox", { name: /vin/i }).fill(VIN);
  await page.getByRole("button", { name: "Save VIN" }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); // §6.1's case: one hand, a phone.
  await page.route(VPIC, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ Results: [{ Make: "HONDA", Model: "Accord", ErrorCode: "0" }] }),
    }),
  );
});

test("[R3-F6] the QR overlay shows the VIN at reading size", async ({ page }) => {
  await typeAndSave(page);
  await page.getByRole("button", { name: /^QR code$/ }).click();

  // The overlay's own copy of the VIN, beside the code a second phone is pointed at.
  const overlay = page.getByRole("dialog");
  await expect(overlay).toBeVisible();
  expectVinDisplay(await vinStyle(overlay.getByText(GROUPED)), "QR overlay");
});

test("[R3-F6] a History row shows the VIN at reading size", async ({ page }) => {
  await typeAndSave(page);
  await page.getByRole("link", { name: "History" }).click();

  const row = page.getByRole("list").getByText(GROUPED);
  await expect(row).toBeVisible();
  expectVinDisplay(await vinStyle(row), "History row");
});

test("[R3-F6] the Import preview shows the VIN at reading size", async ({ page }) => {
  await page.goto(`/#/i?d=${PAYLOAD}`);

  const preview = page.getByText(GROUPED);
  await expect(preview).toBeVisible();
  expectVinDisplay(await vinStyle(preview), "Import preview");
});
