import { expect, test } from "@playwright/test";

/**
 * §13.2 adversary, round 1 of `harden S1`: double taps on the write path.
 *
 * `useVinCommit.useAsIs` is the shared D03 gate — the §6.3 confirmed-with-mismatch
 * branch and the keyboard both go through it. Its re-entrancy guard is the `saving`
 * state value captured when the handler closed over it, so the question is whether a
 * second activation before the first write commits can log a second §5.2 scan event
 * for one physical read. No camera is attached here on purpose: the keyboard reaches
 * the same hook without a barcode that fails §4.3.
 */

/** Fixture VIN with position 9 moved off its §4.3 value: grammar-valid, check-digit wrong. */
const BAD_CHECK_VIN = "1HGCM82643A004352";

async function scanEventCount(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(async () => {
    const open = indexedDB.open("vinrelay");
    const dbh: IDBDatabase = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
    const req = dbh.transaction("scanEvents", "readonly").objectStore("scanEvents").getAll();
    const rows: unknown[] = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result as unknown[]);
      req.onerror = () => rej(req.error);
    });
    return rows.length;
  });
}

test("[A-05] two activations of Use as-is write one scan event", async ({ page }) => {
  await page.goto("/#/scan");
  await page.getByRole("button", { name: "Type VIN instead" }).click();
  await page.getByLabel("VIN").fill(BAD_CHECK_VIN);
  await page.getByRole("button", { name: "Save VIN" }).click();

  // D03 / §6.4: nothing is written until the user chooses.
  // Scoped to the banner: since the §6.4 apostrophes were normalised to ASCII, the
  // live-feedback chip carries the same words.
  await expect(page.getByRole("alert").getByText("Check digit doesn't match")).toBeVisible();
  expect(await scanEventCount(page)).toBe(0);

  // A double tap: two activations before the first write can commit.
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Use as-is",
    );
    if (button === undefined) throw new Error("Use as-is button not found");
    button.click();
    button.click();
  });

  await expect(page).toHaveURL(new RegExp(`#/v/${BAD_CHECK_VIN}`), { timeout: 10_000 });
  // §5.2 is append-only, so a duplicate here is a scan the user never took.
  expect(await scanEventCount(page)).toBe(1);
});

test("[A-05] a real 90 ms double tap on Use as-is writes one scan event", async ({ page }) => {
  await page.goto("/#/scan");
  await page.getByRole("button", { name: "Type VIN instead" }).click();
  await page.getByLabel("VIN").fill(BAD_CHECK_VIN);
  await page.getByRole("button", { name: "Save VIN" }).click();
  // Scoped to the banner: since the §6.4 apostrophes were normalised to ASCII, the
  // live-feedback chip carries the same words.
  await expect(page.getByRole("alert").getByText("Check digit doesn't match")).toBeVisible();

  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Use as-is",
    ) as HTMLButtonElement;
    button.click();
    // A gloved second tap on a button that has not visibly responded yet.
    setTimeout(() => button.click(), 90);
  });

  await expect(page).toHaveURL(new RegExp(`#/v/${BAD_CHECK_VIN}`), { timeout: 10_000 });
  await page.waitForTimeout(500);
  expect(await scanEventCount(page)).toBe(1);
});
