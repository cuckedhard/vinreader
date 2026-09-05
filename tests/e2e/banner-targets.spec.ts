import { expect, test } from "@playwright/test";

/**
 * [F4] `Banner`'s action row and `Button`'s variants are one contract, and the row is not
 * allowed to lower a target the button has already promised.
 *
 * `Banner` floors every child of its action row so that an action which brings no target of
 * its own still clears §6.1's 48 px. That floor used to be written `[&>*]:min-h-[var(--tap)]`,
 * which is a *fixed* value rather than a floor: it lands on the child at the same specificity
 * as the child's own `min-h`, later in the sheet, so `<Button variant="primary">` — documented
 * as the 56 px target — computed 48 inside a Banner. Six call sites had learned to pin
 * `className="h-14"` on top of it and a seventh (AccountScreen's "Add N local records") had
 * already shipped without the pin at 48.
 *
 * The row now asks each child for the target it declares (`--tap-target`) and only supplies
 * 48 where the child declares none, so both halves hold at once. Both are measured here as
 * rendered boxes: a class list cannot answer which declaration won (F1-a).
 */

/** §4.3: grammar-valid, check digit deliberately wrong — the typed path's mismatch banner. */
const MISREAD = "1HGCM82633A004353";

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

async function mismatchBanner(page: import("@playwright/test").Page) {
  await page.setViewportSize({ width: 390, height: 844 }); // §6.1's case: one hand, a phone.
  await page.goto("/#/scan");
  await page.getByRole("button", { name: /type vin instead/i }).click();
  await page.locator("input[type=text], input:not([type])").first().fill(MISREAD);
  await page.getByRole("button", { name: /^save vin$/i }).click();
  const banner = page.getByRole("alert").filter({ hasText: "Check digit doesn't match." });
  await expect(banner).toBeVisible();
  return banner;
}

test("[F4] a primary action inside a Banner keeps the 56 px target its variant promises", async ({
  page,
}) => {
  const banner = await mismatchBanner(page);
  const { tap, tapLg } = await taps(page);
  expect(tapLg).toBeGreaterThan(tap); // the two tokens are distinct, or this proves nothing

  // Edit is the typed path's primary (§6.4, Z7). No `h-14` pin anywhere near it.
  const edit = banner.getByRole("button", { name: /^edit$/i });
  expect((await edit.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(tapLg);

  // The box alone would not catch a regression here: the action row stretches its children
  // to the tallest one on the line, so the pinned "Use as-is" beside it props Edit up to 56
  // whatever Edit's own cascade says. `min-height` off the computed style is the browser's
  // answer to "which declaration won", resolved against the live sheet — not a class token.
  const minHeight = await edit.evaluate((el) => getComputedStyle(el).minHeight);
  expect(minHeight).toBe(`${tapLg}px`);

  // §6.1 names Use as-is in the ≥ 56 px list, and its variant is `secondary`, so this one
  // carries a pin on purpose: the contract gives it 48, the spec asks for 56.
  const useAsIs = await banner.getByRole("button", { name: /^use as-is$/i }).boundingBox();
  expect(useAsIs?.height ?? 0).toBeGreaterThanOrEqual(tapLg);
});

test("[F4] the Banner action row still floors a child that declares no target", async ({
  page,
}) => {
  const banner = await mismatchBanner(page);
  const { tap } = await taps(page);

  // The other half of the contract, measured on the live row rather than a copy of its
  // classes: a bare anchor — no Button, no declared target — dropped into the real action
  // row still comes out at ≥ 48 px.
  const bare = await banner.evaluate((node) => {
    const row = node.querySelector("button")?.parentElement;
    if (!row) throw new Error("no action row");
    const probe = document.createElement("a");
    probe.href = "#/scan";
    probe.textContent = "probe";
    row.append(probe);
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    return height;
  });
  expect(bare).toBeGreaterThanOrEqual(tap);
});
