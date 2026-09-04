import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * R3-F2, round 3 of `harden S1`. Sheet → sheet is a `:vin` change (§6.2) inside one
 * mounted `SheetScreen`, and it used to leave the previous vehicle's details and notes in
 * the DOM under the current vehicle's VIN.
 *
 * `DecodeSection`, `MetaEditor` and `Actions` were three siblings sharing one
 * `key={record.vin}`. React's array reconciler gathers the outgoing siblings into a Map
 * keyed by `key`, so the three collapsed into one entry, only the last of them was given a
 * deletion, and the first two kept their host nodes after their fibers were gone —
 * unreachable DOM that no longer answers a keystroke and never re-renders. Another
 * vehicle's make, model and unit standing as fact on this vehicle's sheet is N2, and
 * §13.3 makes an N-rule violation S1.
 *
 * The counts below are the measurement: `#details-heading`, `#meta-heading` and the rest
 * are single ids, so any count above one is a second copy of that section.
 */

const HONDA = "1HGCM82633A004352";
const FORD = "1FTZX1762TKB12345";

/** `normalizeVehicle` rebuilds `structural` from the VIN, so only these fields are seeded. */
function row(vin: string, fields: Record<string, string>, unit: string) {
  return {
    vin,
    structural: {},
    decode: {
      status: "ok",
      source: "nhtsa_vpic",
      fetchedAt: "2026-01-01T00:00:00.000+00:00",
      attempts: 1,
      lastError: null,
      fields,
    },
    unit,
    notes: `notes for ${unit}`,
    firstScannedAt: "2026-01-01T00:00:00.000+00:00",
    lastScannedAt: "2026-01-01T00:00:00.000+00:00",
    scanCount: 1,
    origin: "scan",
    metaUpdatedAt: "1970-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

const ROWS = [
  row(HONDA, { Make: "HONDA", Model: "Accord", ModelYear: "2003" }, "TRUCK-A"),
  row(FORD, { Make: "FORD", Model: "F-150", ModelYear: "1996" }, "TRUCK-B"),
];

async function seed(page: Page) {
  // Settings first, so Dexie has opened the database before the rows are written.
  await page.goto("/#/settings");
  await page.evaluate(async (rows) => {
    const open = indexedDB.open("vinrelay");
    const dbh: IDBDatabase = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
    const tx = dbh.transaction("vehicles", "readwrite");
    for (const record of rows) tx.objectStore("vehicles").put(record);
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }, ROWS);
}

/** One vehicle on screen: one of every section, and no trace of the other record. */
async function expectOnlyVehicle(page: Page, vin: "honda" | "ford") {
  const honda = vin === "honda";
  await expect(page.locator("h1")).toHaveText(
    honda ? "1HG CM826 3 3 A 004352" : "1FT ZX176 2 T K B12345",
  );
  await expect(page.locator("#structural-heading")).toHaveCount(1);
  await expect(page.locator("#details-heading")).toHaveCount(1);
  await expect(page.locator("#meta-heading")).toHaveCount(1);
  await expect(page.locator("#handoff-heading")).toHaveCount(1);

  // N2: the other vehicle's make, model and unit are not on this vehicle's sheet at all.
  await expect(page.getByText(honda ? "FORD" : "HONDA")).toHaveCount(0);
  await expect(page.getByText(honda ? "F-150" : "Accord")).toHaveCount(0);
  await expect(page.locator("#sheet-unit")).toHaveCount(1);
  await expect(page.locator("#sheet-unit")).toHaveValue(honda ? "TRUCK-A" : "TRUCK-B");
}

/** A `#/v/<vin>` link tapped into an already-open app, or an edited address bar. */
async function changeFragment(page: Page, vin: string) {
  await page.evaluate((next) => {
    window.location.hash = `#/v/${next}`;
  }, vin);
}

test("[R3-F2] a fragment navigation between sheets leaves nothing of the previous vehicle", async ({
  page,
}) => {
  await seed(page);

  await page.goto(`/#/v/${HONDA}`);
  await expectOnlyVehicle(page, "honda");

  // Four in a row: the stale sections used to accumulate, one pair per navigation.
  for (const vin of [FORD, HONDA, FORD, HONDA] as const) {
    await changeFragment(page, vin);
    await expectOnlyVehicle(page, vin === HONDA ? "honda" : "ford");
  }
});

test("[R3-F2] browser Back and Forward between two sheets leave nothing behind", async ({
  page,
}) => {
  await seed(page);

  // Two adjacent sheet entries in one history stack is all Back needs to become a
  // sheet → sheet `:vin` change itself.
  await page.goto(`/#/v/${HONDA}`);
  await expectOnlyVehicle(page, "honda");
  await changeFragment(page, FORD);
  await expectOnlyVehicle(page, "ford");

  await page.goBack();
  await expectOnlyVehicle(page, "honda");

  await page.goForward();
  await expectOnlyVehicle(page, "ford");
});

test("[R3-F2] the unit box on a sheet reached by fragment belongs to that vehicle", async ({
  page,
}) => {
  await seed(page);

  await page.goto(`/#/v/${HONDA}`);
  await expect(page.locator("#sheet-unit")).toHaveValue("TRUCK-A");

  await changeFragment(page, FORD);
  // The live box is the current vehicle's and takes an edit; the stale copy took none,
  // which is how the dead DOM announced itself (P7).
  const unit = page.locator("#sheet-unit");
  await expect(unit).toHaveCount(1);
  await unit.fill("TRUCK-B-EDITED");
  await expect(unit).toHaveValue("TRUCK-B-EDITED");
  await expect(page.getByRole("button", { name: /^save$/i })).toBeEnabled();
});
