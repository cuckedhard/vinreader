import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const VIN = "1HGCM82633A004352";
const VPIC = "**/api/vehicles/DecodeVinValues/**";

/**
 * SYNTHETIC vPIC responses. vpic.nhtsa.dot.gov is refused by this environment's
 * egress policy, so these are shaped from §4.7 rather than recorded from the
 * service. They exercise our handling; they do not confirm the §4.8 key names,
 * which is what scripts/verify-vpic-fields.ts is for.
 */
function body(results: Record<string, string>) {
  return {
    Count: 1,
    Message: "Results returned successfully",
    SearchCriteria: `VIN:${VIN}`,
    Results: [results],
  };
}

const OK = body({
  ErrorCode: "0",
  ErrorText: "",
  ModelYear: "2003",
  Make: "HONDA",
  Model: "Accord",
  BodyClass: "Sedan/Saloon",
  VehicleType: "PASSENGER CAR",
  Doors: "4",
  EngineCylinders: "4",
  DisplacementL: "2.4",
  FuelTypePrimary: "Gasoline",
  Manufacturer: "HONDA OF AMERICA MFG., INC.",
  PlantCity: "MARYSVILLE",
  PlantState: "OHIO",
  PlantCountry: "UNITED STATES (USA)",
  Trim: "",
  Series: "",
});

const OFF_HIGHWAY = body({ ErrorCode: "6", ErrorText: "Incomplete VIN", Make: "", Model: "" });
const PARTIAL = body({
  ErrorCode: "8",
  ErrorText: "No detailed data available",
  Make: "HONDA",
  Model: "Accord",
  ModelYear: "2003",
});

async function stub(page: Page, payload: unknown) {
  await page.route(VPIC, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) }),
  );
}

async function saveVin(page: Page, vin = VIN) {
  await page.getByRole("button", { name: /type vin instead/i }).click();
  await page.locator("input[type=text], input:not([type])").first().fill(vin);
  await page
    .getByRole("button", { name: /save|add|decode/i })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`#/v/${vin}`));
}

test("fills the sheet from a successful decode", async ({ page }) => {
  await stub(page, OK);
  await page.goto("/#/scan");
  await saveVin(page);

  const identity = page.getByLabel("Identity");
  await expect(identity.getByText("HONDA", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(identity.getByText("Accord", { exact: true })).toBeVisible();
  await expect(identity.getByText("Sedan/Saloon")).toBeVisible();
  // §4.8 joins the plant parts with ", ".
  await expect(
    page.getByLabel("Manufacturing").getByText("MARYSVILLE, OHIO, UNITED STATES (USA)"),
  ).toBeVisible();
  // N2: Trim and Series came back empty and must not be rendered as rows at all.
  await expect(identity.getByText("Trim", { exact: true })).toHaveCount(0);
  await expect(identity.getByText("Series", { exact: true })).toHaveCount(0);
});

/** §9-S2 acceptance: airplane-mode scan, then back online, filling with no user action. */
test("a VIN saved offline fills itself once the signal returns", async ({ page, context }) => {
  await stub(page, OK);
  await page.goto("/#/scan");

  await context.setOffline(true);
  await saveVin(page);
  await expect(page.getByText(/offline — vin saved/i)).toBeVisible();
  await expect(page.getByLabel("Identity")).toHaveCount(0);

  // No reload, no tap: the queue wakes on the `online` event (§5.4).
  await context.setOffline(false);
  const filled = page.getByLabel("Identity");
  await expect(filled.getByText("HONDA", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(filled.getByText("Accord", { exact: true })).toBeVisible();
});

test("shows the off-highway notice when NHTSA cannot decode the PIN", async ({ page }) => {
  await stub(page, OFF_HIGHWAY);
  await page.goto("/#/scan");
  await saveVin(page);

  await expect(page.getByText(/off-highway machine PIN/i)).toBeVisible({ timeout: 15_000 });
  // The structural read is still the answer and stays on screen.
  await expect(page.getByText("1HG CM826 3 3 A 004352")).toBeVisible();
  await expect(page.getByText("North America")).toBeVisible();
});

test("surfaces partial data with the reason NHTSA gave", async ({ page }) => {
  await stub(page, PARTIAL);
  await page.goto("/#/scan");
  await saveVin(page);

  // §6.4 interpolates NHTSA's own ErrorText into the notice.
  await expect(
    page.getByText("NHTSA returned partial data: No detailed data available"),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel("Identity").getByText("HONDA", { exact: true })).toBeVisible();
});

test("history shows the decoded vehicle and searches by make", async ({ page }) => {
  await stub(page, OK);
  await page.goto("/#/scan");
  await saveVin(page);
  await expect(page.getByLabel("Identity").getByText("HONDA", { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  await page.getByRole("link", { name: "History" }).click();
  await expect(page.getByText(/HONDA/).first()).toBeVisible();

  const search = page.locator("input").first();
  await search.fill("honda");
  await expect(page.getByText("1HG CM826 3 3 A 004352")).toBeVisible();
  await search.fill("zzzz");
  await expect(page.getByText("1HG CM826 3 3 A 004352")).toHaveCount(0);
});
