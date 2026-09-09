import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { encodePayload } from "../../src/lib/payload/codec";

/**
 * [F5] §4.9: "The receiver runs its own vPIC decode to fill the full sheet; the payload's
 * summary fields are used immediately so the receiver is useful offline too."
 *
 * They were not. `runImport` passed the VIN, the unit, the notes and the paint code and
 * dropped `y mk md tr bc en fu dr gv` on the floor, so the receiving phone showed — and
 * re-shared — a bare VIN until it could reach NHTSA. That is the two-crew handoff of §9-S3
 * failing at exactly the moment it is needed, and N1/P1 say nothing may wait on a network.
 *
 * So NHTSA is unreachable for the whole spec. Anything the sheet knows about this vehicle
 * came out of the payload, which is the only way this can be measured: with the stub in
 * place, a green run would prove nothing about the import.
 */

const VIN = "1HGCM82633A004352"; // §4.11 fixture.

const PAYLOAD = encodePayload({
  v: 1,
  vin: VIN,
  y: "2003",
  mk: "HONDA",
  md: "Accord",
  bc: "Sedan/Saloon",
  fu: "Gasoline",
});

/** No signal. Every vPIC request fails, exactly as it does in a bay with no bars. */
async function offline(page: Page) {
  await page.route("**/api/vehicles/**", (route) => route.abort());
}

test.beforeEach(async ({ page }) => offline(page));

test("[F5] an imported summary is on the sheet with no signal at all", async ({ page }) => {
  await page.goto(`/#/i?d=${PAYLOAD}`);
  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));

  // §4.8's own rows, from the payload alone: this is the decoded block, below the
  // structural one, and none of these four values is derivable from the 17 characters.
  // `.first()` because §4.8's "All fields" block prints every value a second time.
  const details = page.locator("section", { has: page.getByText("Vehicle details") }).first();
  for (const value of ["HONDA", "Accord", "Sedan/Saloon", "Gasoline"]) {
    await expect(details.getByText(value, { exact: true }).first(), value).toBeVisible();
  }

  // Still the record's own, after a reload: it is in Dexie and not in a screen's state.
  await page.reload();
  await expect(details.getByText("HONDA", { exact: true }).first()).toBeVisible();
});

test("[F5] History reads the imported vehicle by name, offline", async ({ page }) => {
  // The phone layout, where §6.2's row carries one headline; §6.6's table splits the same
  // three fields into columns of their own.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/i?d=${PAYLOAD}`);
  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));

  await page.getByRole("link", { name: "History" }).click();
  await expect(page.getByText("2003 HONDA Accord")).toBeVisible();
});

test("[F5] and the phone re-shares it, rather than handing on a bare VIN", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await page.goto(`/#/i?d=${PAYLOAD}`);
  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));

  // §6.5's Link: the `VINRELAY1:` carrier, written by the real codec from the real record.
  await page.getByRole("button", { name: /copy link/i }).click();
  await expect(page.getByText("Copied")).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link.startsWith("VINRELAY1:")).toBe(true);

  // Read back through the app's own Import, so what is measured is what a second phone
  // would see — §6.4's preview heading, which is where the summary shows up.
  await page.goto("/#/i");
  await page.getByLabel(/paste a link/i).fill(link);
  await page.getByRole("button", { name: /preview import/i }).click();
  await expect(page.getByRole("heading", { level: 2 })).toContainText("2003 HONDA Accord");
});

test("[F5] the receiver still asks NHTSA for the rest of the sheet", async ({ page }) => {
  // §4.9 gives the summary and the decode two different jobs, and taking the first must not
  // cancel the second: the record stays `pending` so §5.4 keeps trying (N1).
  await page.goto(`/#/i?d=${PAYLOAD}`);
  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));

  await page.getByRole("link", { name: "History" }).click();
  // §6.4's chip for a row vPIC has not answered for. `ok` gets no chip, so this is also
  // the assertion that the import did not label the sender's three fields as an answer.
  await expect(page.getByText(/Details pending|Details failed/)).toBeVisible();
});
