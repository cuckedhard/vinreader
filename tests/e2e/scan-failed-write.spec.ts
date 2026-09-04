import { expect, test } from "@playwright/test";

/** A failed write must not record the §6.3 cooldown: "Scan again" has to work at once. */
test("a failed Use as-is leaves the VIN immediately re-scannable", async ({ page }) => {
  // Open the database BEFORE injecting the fault. Dexie retries a transaction that fails
  // while the connection is still opening, so a fault installed in an init script can
  // land on the retry instead of the first attempt — and the retry may run after the
  // fault is lifted, at which point the write succeeds and the rest of this test measures
  // the Sheet rather than the Scan screen. Waiting for a completed read pins the
  // connection open, which makes the injected failure the only possible outcome.
  await page.goto("/#/history");
  await expect(page.getByText("Nothing scanned yet")).toBeVisible();

  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    (window as unknown as { restorePut: () => void }).restorePut = () => {
      IDBObjectStore.prototype.put = put;
    };
    IDBObjectStore.prototype.put = function () {
      throw new Error("storage full");
    };
  });

  // In-app navigation, not `goto`: a reload would drop the override with the window.
  await page.getByRole("link", { name: "Scan" }).click();
  await page.getByRole("button", { name: /type vin instead/i }).click();
  await page.getByRole("textbox", { name: /vin/i }).fill("1HGCM82633A004353");
  await page.getByRole("button", { name: "Save VIN" }).click();
  await page.getByRole("button", { name: /use as-is/i }).click();

  // Assert the failure positively. `not.toHaveURL` alone passes on a navigation that has
  // merely not happened yet, which is how the late-retry write above went unnoticed.
  await expect(page.getByText("Couldn't save this VIN")).toBeVisible();
  await expect(page).not.toHaveURL(/#\/v\//);

  // Repair storage and immediately retry the SAME VIN. If a cooldown was recorded, the
  // scanner would ignore this label for ten seconds.
  await page.evaluate(() => (window as unknown as { restorePut: () => void }).restorePut());
  const started = Date.now();
  await page.getByRole("textbox", { name: /vin/i }).fill("1HGCM82633A004353");
  await page.getByRole("button", { name: "Save VIN" }).click();
  await page.getByRole("button", { name: /use as-is/i }).click();
  await expect(page).toHaveURL(/#\/v\/1HGCM82633A004353/, { timeout: 8_000 });
  expect(Date.now() - started).toBeLessThan(8_000);
});
