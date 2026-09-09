import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { encodePayload } from "../../src/lib/payload/codec";

/**
 * [R3-C] §5.3: "keep existing `unit`/`notes` unless the incoming payload has non-empty
 * values **and the user confirms overwrite**."
 *
 * The import replaced both with the sender's values, with nothing on the preview reading
 * `db.vehicles` — so the value about to disappear was never shown and no confirmation could
 * be given. For `notes` that is destruction of text a person typed with a glove on, and
 * §4.12's LWW then carried the loss to every other device on the account.
 *
 * A screen claim, so it is measured on a real screen: the confirmation, the pressed state
 * that says what a plain Import will do (N2), and the record after the write.
 */

const VIN = "1HGCM82633A004352"; // §4.11 fixture.

/** What a person typed on this phone. */
const UNIT = "TRK-204";
const NOTES = "front tyre worn";

/** What the sender put in the §4.9 payload. */
const OTHER_UNIT = "TRK-999";
const OTHER_NOTES = "ready for pickup";

/** Built with the real §4.9 codec, so the specs cannot drift from the implementation. */
const PLAIN = encodePayload({ v: 1, vin: VIN, y: "2003", mk: "HONDA", md: "Accord" });
const WITH_META = encodePayload({
  v: 1,
  vin: VIN,
  y: "2003",
  mk: "HONDA",
  md: "Accord",
  u: OTHER_UNIT,
  n: OTHER_NOTES,
});

async function stubVpic(page: Page) {
  await page.route("**/api/vehicles/DecodeVinValues/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        Count: 1,
        Message: "synthetic",
        SearchCriteria: null,
        Results: [{ ErrorCode: "0", Make: "HONDA", Model: "Accord", ModelYear: "2003" }],
      }),
    }),
  );
}

test.beforeEach(async ({ page }) => stubVpic(page));

/** A record on this phone whose unit and notes a person typed into the sheet's own fields. */
async function seedTyped(page: Page) {
  await page.goto(`/#/i?d=${PLAIN}`);
  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));

  // Both fields save on blur, so by the time a click could land on Save it is already
  // disabled — the chip is what says the record took them (§6.4's "Not saved yet" pair).
  // One field at a time, because a save in flight writes what storage kept back into all
  // three boxes, and text typed into the next box while it is in flight is overwritten.
  await page.locator("#sheet-unit").fill(UNIT);
  await page.locator("#sheet-unit").blur();
  await expect(page.getByText("Saved")).toBeVisible();
  await page.locator("#sheet-notes").fill(NOTES);
  await page.locator("#sheet-notes").blur();

  // Read back from Dexie, so the collision below starts from a record and not from state.
  await page.reload();
  await expect(page.locator("#sheet-unit")).toHaveValue(UNIT);
  await expect(page.locator("#sheet-notes")).toHaveValue(NOTES);
}

test("[R3-C] a colliding import shows both values and keeps this phone's", async ({ page }) => {
  await seedTyped(page);
  await page.goto(`/#/i?d=${WITH_META}`);

  for (const [held, incoming] of [
    [UNIT, OTHER_UNIT],
    [NOTES, OTHER_NOTES],
  ]) {
    const keep = page.getByRole("button", { name: `On this phone ${held}` });
    const use = page.getByRole("button", { name: `From the sender ${incoming}` });
    // Both values are on screen before anything is written, and the one that survives a
    // plain Import is the pressed one: the screen states the outcome (N2).
    await expect(keep).toHaveAttribute("aria-pressed", "true");
    await expect(use).toHaveAttribute("aria-pressed", "false");
  }

  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));

  await expect(page.locator("#sheet-unit")).toHaveValue(UNIT);
  await expect(page.locator("#sheet-notes")).toHaveValue(NOTES);

  // The record, not the boxes: nothing was written over.
  await page.reload();
  await expect(page.locator("#sheet-unit")).toHaveValue(UNIT);
  await expect(page.locator("#sheet-notes")).toHaveValue(NOTES);
});

test("[R3-C] the overwrite happens for the field the user picks, and only that one", async ({
  page,
}) => {
  await seedTyped(page);
  await page.goto(`/#/i?d=${WITH_META}`);

  await page.getByRole("button", { name: `From the sender ${OTHER_UNIT}` }).click();
  await expect(page.getByRole("button", { name: `From the sender ${OTHER_UNIT}` })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));

  await page.reload();
  await expect(page.locator("#sheet-unit")).toHaveValue(OTHER_UNIT);
  // Untouched: the tap said "use the sender's unit", and it said nothing about the notes.
  await expect(page.locator("#sheet-notes")).toHaveValue(NOTES);
});

test("[R3-C] an import with nothing to lose asks nothing", async ({ page }) => {
  // §5.3's first arm, which this fix must not break: an empty field takes the incoming
  // value, and a preview with no collision on it shows no chooser at all.
  await page.goto(`/#/i?d=${PLAIN}`);
  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));

  await page.goto(`/#/i?d=${WITH_META}`);
  await expect(page.getByRole("button", { name: /^on this phone/i })).toHaveCount(0);
  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));

  await expect(page.locator("#sheet-unit")).toHaveValue(OTHER_UNIT);
  await expect(page.locator("#sheet-notes")).toHaveValue(OTHER_NOTES);
});

test("§6.1: both values are ≥ 48 px targets on a phone, and neither is hidden", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 }); // one hand, a phone.
  await seedTyped(page);
  await page.goto(`/#/i?d=${WITH_META}`);

  // The token, read from the stylesheet that defines it — never retyped here (§7 item 5).
  const tap = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tap")),
  );
  expect(tap).toBeGreaterThan(0);

  for (const name of [
    `On this phone ${UNIT}`,
    `From the sender ${OTHER_UNIT}`,
    `On this phone ${NOTES}`,
    `From the sender ${OTHER_NOTES}`,
  ]) {
    const box = await page.getByRole("button", { name }).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(tap);
    // No long-press, no swipe: both are visible buttons with the value in the label (N5).
    expect(box?.width ?? 0).toBeGreaterThan(0);
  }
});
