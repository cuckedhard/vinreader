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

/** Built with the real §4.9 codec, so the test cannot drift from the implementation. */
const PLAIN = encodePayload({ v: 1, vin: VIN, y: "2003", mk: "HONDA", md: "Accord" });

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

test("the sheet says who typed the paint code, and does not file it under the VIN", async ({
  page,
}) => {
  await seed(page, PLAIN);

  // §6.4's third provenance: not derived from the 17 characters, not fetched from NHTSA.
  await expect(
    page.getByText(/Typed in from the paint sticker\..*NHTSA doesn't publish it\./),
  ).toBeVisible();

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
