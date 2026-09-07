import { expect, test, type Locator } from "@playwright/test";

/**
 * [FR-2] A refused read says what was read and why it is not a VIN — the two surfaces with
 * no frame loop on them.
 *
 * The report: a DYNACRAFT component label on a 2013 Kenworth, three Code 128 symbols, one
 * field each. The app refused every one of them, correctly, and said nothing at all, so the
 * mechanic photographed the sticker and asked a person. The part number is eighteen
 * characters — sixteen of them §4.1 — and the hyphens are separators (§4.2 step 2), so what
 * the app actually holds is a longest run of nine. That number is what it now quotes.
 *
 * What is *not* said is the point of the guards at the bottom: nothing here names what the
 * string is. "That looks like a part number" is a guess (N2) and it is wrong the moment
 * someone scans a pallet tag.
 */

const PART_NUMBER = "R25-1251-200622120";
const WHY = "No 17 characters in a row here — the longest run is 9.";
/** §6.4, the typed path's rule and remedy, which keeps its place under the new lines. */
const RULE =
  "A VIN is 17 characters and never uses I, O or Q. Keep typing, or check for a mistyped character.";
const VIN = "1HGCM82633A004352";

/** §6.1: the read is set the way a VIN is, because it is read off a phone the same way. */
async function readStyle(target: Locator) {
  return target.evaluate((el) => {
    const css = getComputedStyle(el);
    return { size: parseFloat(css.fontSize), family: css.fontFamily.toLowerCase() };
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

test("[FR-2] the typed screen shows the pasted text and why it is not a VIN", async ({ page }) => {
  await page.goto("/#/scan");
  await page.getByRole("button", { name: /type vin instead/i }).click();
  await page.getByRole("textbox", { name: /vin/i }).fill(PART_NUMBER);

  const panel = page.locator("[aria-live='polite']");
  await expect(panel).toContainText("Not a VIN yet");
  // The string the app had in hand and would not show. Upper-cased at the source, which
  // is what the field itself displays (§5.2).
  await expect(panel).toContainText(PART_NUMBER);
  await expect(panel).toContainText(WHY);
  // §6.4's own line for this state is still here, under the two facts and not replaced.
  await expect(panel).toContainText(RULE);

  // Nothing was accepted: this is a refusal that now explains itself, not a read.
  await expect(page.getByRole("button", { name: "Save VIN" })).toBeDisabled();
  await expect(page).toHaveURL(/#\/scan$/);

  const style = await readStyle(panel.getByText(PART_NUMBER));
  expect(style.size).toBeGreaterThanOrEqual(28);
  expect(style.family).toContain("mono");
});

test("[FR-2] the typed screen still says nothing while a VIN is being typed", async ({ page }) => {
  await page.goto("/#/scan");
  await page.getByRole("button", { name: /type vin instead/i }).click();
  const field = page.getByRole("textbox", { name: /vin/i });
  const panel = page.locator("[aria-live='polite']");

  // Half a VIN is not a refusal worth stating — §6.4 waits until enough has been typed,
  // and a message on every keystroke is the noise this finding is not allowed to add.
  await field.fill("1HGCM8263");
  await expect(panel).toBeEmpty();

  // The whole VIN reads as one, and the refusal panel is gone rather than merely outranked.
  await field.fill(VIN);
  await expect(panel).toContainText("Check digit OK");
  await expect(panel).not.toContainText("Not a VIN yet");
});

test("[FR-2] the Import screen explains a paste it cannot read", async ({ page }) => {
  await page.goto("/#/i");
  await page.locator("#import-paste").fill(PART_NUMBER);
  await page.getByRole("button", { name: "Preview import" }).click();

  const notice = page.getByRole("alert");
  // The title this screen already had, which is the accurate one here: what was pasted is
  // none of the three shapes this box takes.
  await expect(notice).toContainText(
    "That text isn't a VIN Relay link, a VINRELAY1 code, or a VIN.",
  );
  await expect(notice).toContainText(PART_NUMBER);
  await expect(notice).toContainText(WHY);
  // §6.4's hint about the shapes keeps its place at the bottom.
  await expect(notice).toContainText("a code starts with VINRELAY1:, and a VIN is 17 characters.");
  // §6.4 already answers a *payload* whose VIN is unusable. Text that is not a carrier
  // never produced a payload, so that sentence is not borrowed for this (N2).
  await expect(notice).not.toContainText("That payload's VIN");

  const style = await readStyle(notice.getByText(PART_NUMBER));
  expect(style.size).toBeGreaterThanOrEqual(28);
  expect(style.family).toContain("mono");
});

test("[FR-2] neither screen says what the string is", async ({ page }) => {
  // The one thing the app must not do. It cannot see a part number, a pallet tag or the
  // wrong sticker, and a sentence naming one of them is a guess shown as a fact (N2).
  const guesses = [/part number/i, /looks like a/i, /wrong sticker/i, /probably/i];

  await page.goto("/#/i");
  await page.locator("#import-paste").fill(PART_NUMBER);
  await page.getByRole("button", { name: "Preview import" }).click();
  const notice = page.getByRole("alert");
  await expect(notice).toContainText(WHY);
  for (const guess of guesses) await expect(notice).not.toContainText(guess);

  await page.goto("/#/scan");
  await page.getByRole("button", { name: /type vin instead/i }).click();
  await page.getByRole("textbox", { name: /vin/i }).fill(PART_NUMBER);
  const panel = page.locator("[aria-live='polite']");
  await expect(panel).toContainText(WHY);
  for (const guess of guesses) await expect(panel).not.toContainText(guess);
});
