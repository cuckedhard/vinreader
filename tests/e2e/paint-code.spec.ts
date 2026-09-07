import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { encodePayload } from "../../src/lib/payload/codec";

/**
 * S5 layer 1 — the typed paint code (`S5_PAINT_CODE_ADDENDUM` §1, §4.9 `pc`).
 *
 * A paint code is captured, never decoded: nothing downstream can detect a wrong one, so
 * the only two facts worth proving on a real screen are that a human can put one there and
 * that nothing else can take it away.
 */

const VIN = "1HGCM82633A004352";
const PAINT = "NH-731P";

const OTHER_PAINT = "WA8555";

/**
 * §6.4's paint line, in its two truthful shapes. Written out rather than imported: a test
 * that reads the string the screen renders cannot notice the screen rendering the wrong
 * one.
 */
const NOT_DECODED = "The VIN doesn't carry it and NHTSA doesn't publish it.";
const HINT_TYPED = `Entered by hand on this phone. ${NOT_DECODED}`;

/** Built with the real §4.9 codec, so the tests cannot drift from the implementation. */
const PLAIN = encodePayload({ v: 1, vin: VIN, y: "2003", mk: "HONDA", md: "Accord" });
const WITH_PAINT = encodePayload({
  v: 1,
  vin: VIN,
  y: "2003",
  mk: "HONDA",
  md: "Accord",
  pc: PAINT,
});
const WITH_OTHER_PAINT = encodePayload({
  v: 1,
  vin: VIN,
  y: "2003",
  mk: "HONDA",
  md: "Accord",
  pc: OTHER_PAINT,
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

/** Import a payload and land on its sheet — the shortest route to a stored record. */
async function seed(page: Page, payload: string) {
  await page.goto(`/#/i?d=${payload}`);
  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));
}

test.beforeEach(async ({ page }) => stubVpic(page));

test("a paint code typed on the sheet is still there after a reload", async ({ page }) => {
  await seed(page, PLAIN);

  const field = page.getByLabel("Paint code");
  // N2: nothing invents one. An unvisited field is empty, not a dash and not a guess.
  await expect(field).toHaveValue("");

  await field.fill(PAINT);
  await page.getByRole("button", { name: /^save$/i }).click();
  await expect(page.getByText("Saved")).toBeVisible();

  // Reloaded from Dexie, not from the component's own state.
  await page.reload();
  await expect(page.getByLabel("Paint code")).toHaveValue(PAINT);
});

test("the sheet says how the code got here, and never more than it knows", async ({ page }) => {
  await seed(page, PLAIN);

  // No code stored: the paragraph is the field's own explanation, and there is nothing for
  // it to claim a provenance about. It used to say a person typed this off a paint sticker
  // on a vehicle that has no paint code at all (N2).
  const hint = page.locator("#sheet-paint-hint");
  await expect(hint).toHaveText(NOT_DECODED);

  // Typed here, watched by the app: this is the one state it can name.
  await page.getByLabel("Paint code").fill(PAINT);
  await page.getByRole("button", { name: /^save$/i }).click();
  await expect(hint).toHaveText(HINT_TYPED);

  // The structural block is "From the VIN", and a paint code is not in the VIN (N2).
  const structural = page.locator("section", { has: page.getByText("From the VIN") }).first();
  await expect(structural.getByText(/paint/i)).toHaveCount(0);
});

/**
 * Watched red before it was kept, and the way it goes red is worth recording: dropping
 * `min-h-[var(--tap)]` alone is *not* enough, because the shared field class still carries
 * `py-3` and the box stays at 50 px. It fails at 30 px when the padding and the type size
 * shrink with it — which is the regression this guards, and the reason it measures the box
 * the browser laid out instead of asserting that a class is present (F1-a).
 */
test("§6.1: the paint field is a 48 px target on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); // one hand, a phone.
  await seed(page, PLAIN);

  // The token, read from the stylesheet that defines it — never retyped here (§7 item 5).
  const tap = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tap")),
  );
  expect(tap).toBeGreaterThan(0);

  // The rendered box, not the class list: a class cannot say which declaration won (F1-a).
  const box = await page.getByLabel("Paint code").boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(tap);
});

test("§4.9: an imported paint code lands on the record", async ({ page }) => {
  await page.goto(`/#/i?d=${WITH_PAINT}`);
  // The preview says what will be written, before anything is (§6.4).
  await expect(page.getByText(PAINT)).toBeVisible();

  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));
  await expect(page.getByLabel("Paint code")).toHaveValue(PAINT);

  // §4.9 has no slot for provenance, so "another device had this string" is the whole of
  // what this phone knows about these characters. Nobody here typed them and no camera
  // here read them, and the sheet says neither (N2).
  await expect(page.locator("#sheet-paint-hint")).toHaveText(NOT_DECODED);
});

test("§5.3: a second code asks before it replaces the one on this phone", async ({ page }) => {
  await seed(page, WITH_PAINT);

  await page.goto(`/#/i?d=${WITH_OTHER_PAINT}`);
  const keep = page.getByRole("button", { name: `On this phone ${PAINT}` });
  const use = page.getByRole("button", { name: `From the sender ${OTHER_PAINT}` });

  // Both codes are on screen, and the one that will survive a plain Import is pressed:
  // the screen states the outcome rather than leaving it to be discovered (N2).
  await expect(keep).toHaveAttribute("aria-pressed", "true");
  await expect(use).toHaveAttribute("aria-pressed", "false");

  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));
  await expect(page.getByLabel("Paint code")).toHaveValue(PAINT);
});

test("§5.3: the replacement happens when the user picks it", async ({ page }) => {
  await seed(page, WITH_PAINT);

  await page.goto(`/#/i?d=${WITH_OTHER_PAINT}`);
  await page.getByRole("button", { name: `From the sender ${OTHER_PAINT}` }).click();
  await expect(page.getByRole("button", { name: `From the sender ${OTHER_PAINT}` })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));
  await expect(page.getByLabel("Paint code")).toHaveValue(OTHER_PAINT);

  // And it is the record that changed, not the box on screen.
  await page.reload();
  await expect(page.getByLabel("Paint code")).toHaveValue(OTHER_PAINT);

  // The tap said *use the sender's code*, not *I read these characters off a sticker*.
  // The edit path's default is "typed", which would have made the sheet say a person on
  // this phone entered a string that arrived in a payload (N2).
  await expect(page.locator("#sheet-paint-hint")).toHaveText(NOT_DECODED);
});

test("§6.1: both codes are ≥ 48 px targets on a phone, and neither is hidden behind one", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, WITH_PAINT);
  await page.goto(`/#/i?d=${WITH_OTHER_PAINT}`);

  const tap = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tap")),
  );
  for (const name of [`On this phone ${PAINT}`, `From the sender ${OTHER_PAINT}`]) {
    const box = await page.getByRole("button", { name }).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(tap);
    // No long-press, no swipe: both are visible buttons with the code in the label (N5).
    expect(box?.width ?? 0).toBeGreaterThan(0);
  }
});
