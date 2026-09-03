import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { encodePayload } from "../../src/lib/payload/codec";

const VIN = "1HGCM82633A004352";

/** Built with the real §4.9 codec, so the test cannot drift from the implementation. */
const PAYLOAD = encodePayload({
  v: 1,
  vin: VIN,
  y: "2003",
  mk: "HONDA",
  md: "Accord",
  bc: "Sedan/Saloon",
  u: "UNIT-42",
  n: "Rear light out",
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

test("imports a payload URL after showing what it will import", async ({ page }) => {
  await page.goto(`/#/i?d=${PAYLOAD}`);

  // §6.4: preview then confirm. Nothing is written until Import.
  await expect(page.getByText("1HG CM826 3 3 A 004352")).toBeVisible();
  await expect(page.getByRole("button", { name: /^import$/i })).toBeVisible();

  await page.getByRole("link", { name: "History" }).click();
  await expect(page.getByText("1HG CM826 3 3 A 004352")).toHaveCount(0);

  await page.goto(`/#/i?d=${PAYLOAD}`);
  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));

  // The payload's own unit and notes came across, not just the VIN.
  await expect(page.getByLabel("Unit")).toHaveValue("UNIT-42");
  await expect(page.getByRole("textbox", { name: "Notes" })).toHaveValue("Rear light out");
});

test("rejects a corrupt payload without stranding the user", async ({ page }) => {
  await page.goto("/#/i?d=not-a-real-payload");
  await expect(page.getByRole("button", { name: /^import$/i })).toHaveCount(0);
  // P7: a failure is stated, and the paste box is still there to try again.
  await expect(page.locator("textarea, input[type=text]").first()).toBeVisible();
});

test("names the version when a payload is from a newer format", async ({ page }) => {
  const future = encodePayload({ v: 1, vin: VIN });
  // Re-encode with v:2 by hand: the codec refuses to build one, which is the point.
  const bytes = Buffer.from(future.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
  const v2 = Buffer.from(bytes.replace('"v":1', '"v":2'))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await page.goto(`/#/i?d=${v2}`);
  await expect(page.getByText(/2/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^import$/i })).toHaveCount(0);
});

test("exports every saved record as a JSON bundle and as CSV", async ({ page }) => {
  await page.goto(`/#/i?d=${PAYLOAD}`);
  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));

  await page.getByRole("link", { name: "History" }).click();

  const jsonDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: /export json/i }).click();
  const json = await jsonDownload;
  const bundle = JSON.parse(
    await (await json.createReadStream())!.toArray().then((c) => c.join("")),
  );
  expect(bundle.app).toBe("vin-relay");
  expect(bundle.v).toBe(1);
  expect(bundle.vehicles).toHaveLength(1);
  expect(bundle.vehicles[0].vin).toBe(VIN);

  const csvDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: /export csv/i }).click();
  const csv = await csvDownload;
  const text = await (await csv.createReadStream())!.toArray().then((c) => c.join(""));
  const [header, first] = text.split("\r\n");
  expect(header).toBe(
    "vin,year,make,model,trim,body,engine,fuel,drive,gvwr,plant,unit,notes," +
      "firstScannedAt,lastScannedAt,scanCount,decodeStatus",
  );
  expect(first).toContain(VIN);
});

test("shows a scannable QR for the record", async ({ page }) => {
  await page.goto(`/#/i?d=${PAYLOAD}`);
  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));

  await page.getByRole("button", { name: /qr code/i }).click();
  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible();
  // A QR that renders at zero size is not a QR.
  const box = await canvas.boundingBox();
  expect(box!.width).toBeGreaterThan(150);
});
