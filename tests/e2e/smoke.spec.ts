import { expect, test } from "@playwright/test";

const VIN = "1HGCM82633A004352";

/**
 * Scan now opens on the camera (§6.2), so the typed path is one tap away.
 * Without the fake-camera flags getUserMedia fails here, and the type-instead
 * control has to be reachable from the error state too (P7).
 */
async function typeInstead(page: import("@playwright/test").Page) {
  await page.goto("/#/scan");
  await page.getByRole("button", { name: /type vin instead/i }).click();
  return page.locator("input[type=text], input:not([type])").first();
}

/**
 * §5.4's queue. A save kicks a decode, and this suite must not depend on whether the
 * machine running it can reach vpic.nhtsa.dot.gov — here it cannot (the egress policy
 * refuses that host), and the browser logs the refusal as a console error that has
 * nothing to do with the app. Stubbed the way decode.spec.ts stubs it.
 */
const VPIC = "**/api/vehicles/DecodeVinValues/**";
// No `ModelYear`, deliberately. §4.4 drops the structural year row whenever vPIC supplies
// one (SheetScreen.tsx:30), and the assertion below is about §4.4 reading 2003 out of
// position 10 with no network — the offline-first guarantee this smoke test exists for. A
// stub that resolved the year would move that row into the decode block and quietly turn
// this into a test of the stub.
const VPIC_NO_YEAR = {
  Results: [{ Make: "HONDA", Model: "Accord", ModelYear: "", ErrorCode: "0", ErrorText: "" }],
};

/** S0 smoke: the manual path end to end, with no console errors (§7 item 1). */
test("types a VIN, saves it, and finds it again in history", async ({ page }) => {
  // Round 3: this is the "undiagnosed flake" rounds 1 and 2 both recorded. The assertion
  // below is absolute, and a save kicks §5.4, so the run passed or failed on whether the
  // decode request had reached the blocked host before the last assertion ran. Nothing
  // about the app was ever wrong, and nothing about the app was being tested by it.
  await page.route(VPIC, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(VPIC_NO_YEAR),
    }),
  );
  const errors: string[] = [];
  // Chromium refuses to register a service worker behind the self-signed dev
  // certificate regardless of ignoreHTTPSErrors, which is why installing to a
  // home screen needs a trusted origin (README, HTTPS on device). Not an app fault.
  const fromDevCert = (text: string) => text.includes("SSL certificate error");
  const record = (text: string) => !fromDevCert(text) && errors.push(text);
  page.on("console", (m) => m.type() === "error" && record(m.text()));
  page.on("pageerror", (e) => record(String(e)));

  const field = await typeInstead(page);
  await expect(page.locator("#root")).not.toBeEmpty();
  await field.fill(VIN);
  await page
    .getByRole("button", { name: /save|add|decode|use/i })
    .first()
    .click();

  await expect(page).toHaveURL(/#\/v\/1HGCM82633A004352/);
  await expect(page.getByText("1HG CM826 3 3 A 004352")).toBeVisible();
  // Scoped to §6.2's "From the VIN" block: this asserts §4.4 read the year out of position
  // 10, and an unscoped match also finds the same number in the decode's raw field list.
  await expect(page.getByRole("region", { name: "From the VIN" }).getByText("2003")).toBeVisible();

  await page.getByRole("link", { name: "History" }).click();
  await expect(page.getByText("1HG CM826 3 3 A 004352")).toBeVisible();

  await page.getByRole("link", { name: "Settings" }).click();
  // The destructive action stays disabled until the confirmation word is typed.
  await expect(page.getByRole("heading", { name: /clear all data/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /clear all data/i })).toBeDisabled();

  expect(errors).toEqual([]);
});

/** The grouped display form and the I-prefixed label form must both paste in. */
test("accepts the I-prefixed and grouped forms", async ({ page }) => {
  const field = await typeInstead(page);
  await field.fill("I" + VIN);
  await expect(page.getByText("1HG CM826 3 3 A 004352")).toBeVisible();
  await field.fill("1HG CM826 3 3 A 004352");
  await expect(page.getByText("1HG CM826 3 3 A 004352")).toBeVisible();
});

/**
 * A rejected misread must leave no trace: no vehicle row, no scan event.
 * The banner gates the write rather than following it (§4.3, §6.3).
 */
test("a check-digit mismatch saves nothing until Use as-is", async ({ page }) => {
  const field = await typeInstead(page);
  await field.fill("1HGCM82633A004353");
  await page
    .getByRole("button", { name: /save|add|decode/i })
    .first()
    .click();

  await expect(page.getByRole("button", { name: /use as-is/i })).toBeVisible();
  await page.getByRole("button", { name: /^edit$/i }).click();

  await page.getByRole("link", { name: "History" }).click();
  await expect(page.getByText("1HG CM826 3 3 A 004353")).toHaveCount(0);

  await page.getByRole("link", { name: "Scan" }).click();
  await page.getByRole("button", { name: /type vin instead/i }).click();
  await page.locator("input[type=text], input:not([type])").first().fill("1HGCM82633A004353");
  await page
    .getByRole("button", { name: /save|add|decode/i })
    .first()
    .click();
  await page.getByRole("button", { name: /use as-is/i }).click();
  await expect(page).toHaveURL(/#\/v\/1HGCM82633A004353/);

  await page.getByRole("link", { name: "History" }).click();
  await expect(page.getByText("1HG CM826 3 3 A 004353")).toBeVisible();
});
