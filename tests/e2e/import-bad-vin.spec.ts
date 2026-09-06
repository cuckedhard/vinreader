import { expect, test } from "@playwright/test";

/**
 * [F10] §6.4's line for "a payload that parses but carries no usable VIN".
 *
 * It could not render. `ImportScreen` held the sentence and guarded it with
 * `isVinGrammarValid(payload.vin)` *after* `decodePayload` / `parseCarrier` had already
 * validated the same field with the same regex (schema.ts's `vin`, `VIN_RE` from
 * grammar.ts), so the guard was dead: a payload with a bad VIN throws `PayloadError`
 * ("schema") first, and what a field user read was zod's own wording quoting a spec
 * section — "This payload is not a VIN Relay record: vin not a VIN (§4.1: 17 characters,
 * no I, O or Q)". Same class as R3-F4: an internal string in front of a field user.
 *
 * The screen now names the case from the rejection itself (`PayloadError.fields`), so the
 * §6.4 sentence is what renders, on both carriers.
 */

/** §6.4, verbatim. Split from the hint, which was already correct. */
const NO_VIN = "That payload's VIN isn't 17 valid characters, so there is nothing to save.";
const HINT = "Ask the sender to share it again, or paste the VIN below.";

/** A payload that decodes and parses as JSON, carrying something that is not a VIN. */
const BAD = Buffer.from(JSON.stringify({ v: 1, vin: "123" })).toString("base64url");

test("[F10] a shared link whose payload has no usable VIN says so in §6.4's words", async ({
  page,
}) => {
  await page.goto(`/#/i?d=${BAD}`);

  const notice = page.getByRole("alert");
  await expect(notice).toContainText(NO_VIN);
  await expect(notice).toContainText(HINT);
  // The internal wording is gone, not merely outranked.
  await expect(notice).not.toContainText("§4.1");
  await expect(notice).not.toContainText("not a VIN Relay record");
});

test("[F10] a pasted VINRELAY1 code with no usable VIN says the same thing", async ({ page }) => {
  await page.goto("/#/i");
  await page.locator("#import-paste").fill(`VINRELAY1:${BAD}`);
  await page.getByRole("button", { name: "Preview import" }).click();

  const notice = page.getByRole("alert");
  await expect(notice).toContainText(NO_VIN);
  await expect(notice).toContainText(HINT);
  await expect(notice).not.toContainText("§4.1");
});

/**
 * The neighbouring rejections keep their own §6.4 lines — the fix names one case, and a
 * fix that swallowed the others into it would be the same defect pointed the other way.
 */
test("[F10] the other payload rejections still say what they say", async ({ page }) => {
  await page.goto("/#/i");

  const notice = page.getByRole("alert");
  await page.locator("#import-paste").fill("hello world");
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(notice).toContainText("That text isn't a VIN Relay link, a VINRELAY1 code, or a VIN.");

  const v2 = Buffer.from(JSON.stringify({ v: 2, vin: "1HGCM82633A004352" })).toString("base64url");
  await page.locator("#import-paste").fill(`VINRELAY1:${v2}`);
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(notice).toContainText("This payload is version 2; this app reads version 1.");

  // A payload whose VIN is fine and whose *other* field is not still names that field.
  const badAt = Buffer.from(
    JSON.stringify({ v: 1, vin: "1HGCM82633A004352", at: "yesterday" }),
  ).toString("base64url");
  await page.locator("#import-paste").fill(`VINRELAY1:${badAt}`);
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(notice).toContainText("This payload is not a VIN Relay record: at");
});
