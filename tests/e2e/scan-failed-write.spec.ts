import { expect, test } from "@playwright/test";

/** A failed write must not record the §6.3 cooldown: "Scan again" has to work at once. */
test("a failed Use as-is leaves the VIN immediately re-scannable", async ({ page }) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    (window as unknown as { restorePut: () => void }).restorePut = () => {
      IDBObjectStore.prototype.put = put;
    };
    IDBObjectStore.prototype.put = function () {
      throw new Error("storage full");
    };
  });
  await page.goto("/#/scan");
  await page.getByRole("button", { name: /type vin instead/i }).click();
  await page.locator("input[type=text], input:not([type])").first().fill("1HGCM82633A004353");
  await page
    .getByRole("button", { name: /save|add|decode/i })
    .first()
    .click();
  await page.getByRole("button", { name: /use as-is/i }).click();

  // The write failed, so the user is still on Scan and told about it.
  await expect(page).not.toHaveURL(/#\/v\//);

  // Repair storage and immediately retry the SAME VIN. If a cooldown was recorded, the
  // scanner would ignore this label for ten seconds.
  await page.evaluate(() => (window as unknown as { restorePut: () => void }).restorePut());
  const started = Date.now();
  await page.locator("input[type=text], input:not([type])").first().fill("1HGCM82633A004353");
  await page
    .getByRole("button", { name: /save|add|decode/i })
    .first()
    .click();
  await page.getByRole("button", { name: /use as-is/i }).click();
  await expect(page).toHaveURL(/#\/v\/1HGCM82633A004353/, { timeout: 8_000 });
  expect(Date.now() - started).toBeLessThan(8_000);
});
