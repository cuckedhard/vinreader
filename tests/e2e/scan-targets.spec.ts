import { expect, test } from "@playwright/test";

/**
 * [R6-SA-3] §6.1 names Scan in the ≥ 56 px list, and the app labels two controls "Scan".
 *
 * Round 3 checked the floor — "nothing under 48 px in any probed state" — which is why this
 * survived: both controls cleared 48 and neither cleared the 56 the spec names them for. The
 * bottom-nav tab carried `min-h-[var(--tap)]`, and "Scan with the camera", the way back from
 * the typed screen to the camera, is a `secondary` Button, which is 48 by variant.
 *
 * Same class as A14, which was filed and fixed for Copy. Measured as rendered boxes at the
 * §6.1 case — one hand, a phone — because a class list cannot answer what a box computes to.
 */

/** §6.1's targets, read from the tokens that define them (§7 item 5), never retyped here. */
async function taps(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    return {
      tap: parseFloat(css.getPropertyValue("--tap")),
      tapLg: parseFloat(css.getPropertyValue("--tap-lg")),
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/scan");
});

test("[R6-SA-3] the bottom-nav Scan tab is a 56 px target, and the other tabs clear 48", async ({
  page,
}) => {
  const { tap, tapLg } = await taps(page);
  expect(tapLg).toBeGreaterThan(tap); // the two tokens are distinct, or this proves nothing

  const nav = page.getByRole("navigation", { name: "Main" });
  const scan = await nav.getByRole("link", { name: "Scan" }).boundingBox();
  expect(scan?.height ?? 0).toBeGreaterThanOrEqual(tapLg);

  // §6.1 names Scan and not History or Settings, so those two are held to the 48 px floor
  // only — and a nav that stretches its tabs to the same line box will pass this anyway.
  for (const label of ["History", "Settings"]) {
    const box = await nav.getByRole("link", { name: label }).boundingBox();
    expect(box?.height ?? 0, label).toBeGreaterThanOrEqual(tap);
  }
});

test("[R6-SA-3] the way back to the camera is a 56 px target", async ({ page }) => {
  const { tapLg } = await taps(page);
  await page.getByRole("button", { name: /type vin instead/i }).click();

  const back = page.getByRole("button", { name: "Scan with the camera" });
  await expect(back).toBeVisible();
  expect((await back.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(tapLg);

  // The box is the target; the computed `min-height` is what makes it one on a screen
  // where nothing else on the line props it up (F4).
  const minHeight = await back.evaluate((el) => getComputedStyle(el).minHeight);
  expect(minHeight).toBe(`${tapLg}px`);
});
