import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * [F8] The second tap of the two-tap delete has to land on the confirmation, not on the nav.
 *
 * §6.4 gives the Sheet's Delete an armed panel — "Delete this vehicle?" → Delete / Cancel —
 * "with the VIN shown so the wrong row cannot be deleted from the bottom of a long sheet".
 * Delete is the last control on a sheet that runs ~1955 px on a phone, so the user is
 * necessarily scrolled to the end when they arm it; the panel then grows downward from
 * where the 56 px button was and its two buttons land past the fold. Measured before the
 * fix at 390×844: Delete 1.75 of 48 px, Cancel 1.75 of 48, the banner 88 of 152 — and
 * `document.elementFromPoint` at both centres returned the bottom nav's "Scan" and
 * "History" links. The user is shown the question and not the answer, and the confirming
 * tap navigates away.
 *
 * Nothing here uses Playwright's own clicking: it scrolls a control into view before it
 * looks, which is the one thing this test must not do. The arming tap is `element.click()`
 * inside the page.
 */

const VIN = "1FUJGLDR49SAV1234";

/** A real §4.8 answer's worth of rows, so the sheet is the long one §6.4 is written about. */
const FIELDS: Record<string, string> = {
  ErrorCode: "0",
  Make: "FREIGHTLINER",
  Model: "Cascadia",
  ModelYear: "2009",
  Manufacturer: "DAIMLER TRUCKS NORTH AMERICA LLC",
  PlantCity: "CLEVELAND",
  PlantState: "NORTH CAROLINA",
  PlantCountry: "UNITED STATES (USA)",
  BodyClass: "Truck-Tractor",
  VehicleType: "TRUCK",
  GVWR: "Class 8: 33,001 lb and above",
  EngineModel: "DD15",
  EngineCylinders: "6",
  FuelTypePrimary: "Diesel",
  DriveType: "6x4",
  Series: "Cascadia 125",
  Trim: "Sleeper",
  BrakeSystemType: "Air",
  NumberOfSeats: "2",
  TransmissionStyle: "Automated Manual",
};

const ROW = {
  vin: VIN,
  structural: {},
  decode: {
    status: "ok",
    source: "nhtsa_vpic",
    fetchedAt: "2026-01-01T00:00:00.000+00:00",
    attempts: 1,
    lastError: null,
    fields: FIELDS,
  },
  unit: "TRUCK-118",
  notes: "Left front marker light out; jamb label scuffed but readable.",
  firstScannedAt: "2026-01-01T00:00:00.000+00:00",
  lastScannedAt: "2026-01-02T00:00:00.000+00:00",
  scanCount: 2,
  origin: "scan",
  metaUpdatedAt: "1970-01-01T00:00:00.000Z",
  deletedAt: null,
};

async function seed(page: Page): Promise<void> {
  // Settings first, so Dexie has opened the database before the row is written.
  await page.goto("/#/settings");
  await page.evaluate(async (record) => {
    const open = indexedDB.open("vinrelay");
    const dbh: IDBDatabase = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
    const tx = dbh.transaction("vehicles", "readwrite");
    tx.objectStore("vehicles").put(record);
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }, ROW);
}

interface Measured {
  height: number;
  visible: number;
  hit: string | null;
  hitsSelf: boolean;
}

/** How much of a control is inside the scroll container the user is looking at. */
async function measure(page: Page, label: string): Promise<Measured> {
  return page.evaluate((name) => {
    const main = document.querySelector("main");
    if (!main) throw new Error("no <main>");
    const view = main.getBoundingClientRect();
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
    if (!button) throw new Error(`no button "${name}"`);
    const box = button.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      height: box.height,
      visible: Math.max(0, Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top)),
      hit: hit?.textContent?.trim() ?? null,
      hitsSelf: button === hit || button.contains(hit),
    };
  }, label);
}

/** The bottom-nav links a mistapped confirmation used to hit. */
const NAV = ["Scan", "History", "Settings"];

const PHONES = [
  { name: "Galaxy S9+ 320x658", viewport: { width: 320, height: 658 } },
  { name: "Pixel 7 412x839", viewport: { width: 412, height: 839 } },
  { name: "iPhone-class 390x844", viewport: { width: 390, height: 844 } },
];

for (const phone of PHONES) {
  test.describe(phone.name, () => {
    test.use({ viewport: phone.viewport });

    test("[F8] the armed delete confirmation is on screen and tappable", async ({ page }) => {
      await seed(page);
      await page.goto(`/#/v/${VIN}`);
      await expect(page.locator("#delete-heading")).toBeVisible();

      // The state the finding is about: the user has scrolled to the end of a long sheet,
      // because that is where §6.2 puts Delete.
      const scrolls = await page.evaluate(() => {
        const main = document.querySelector("main");
        if (!main) throw new Error("no <main>");
        main.scrollTop = main.scrollHeight;
        return { scrollHeight: main.scrollHeight, clientHeight: main.clientHeight };
      });
      expect(scrolls.scrollHeight).toBeGreaterThan(scrolls.clientHeight);

      // Arm it without Playwright scrolling anything into view first.
      await page.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find(
          (candidate) => candidate.textContent?.trim() === "Delete",
        );
        if (!button) throw new Error("no Delete button");
        button.click();
      });
      await expect(page.getByText("Delete this vehicle?")).toBeVisible();

      for (const label of ["Delete", "Cancel"]) {
        const control = await measure(page, label);
        // §6.1 floors both at 48 px, and §6.4 makes Cancel the equal of Delete.
        expect(control.height).toBeGreaterThanOrEqual(48);
        expect(control.visible).toBeCloseTo(control.height, 1);
        expect(control.hitsSelf).toBe(true);
        expect(NAV).not.toContain(control.hit);
      }

      // §6.4's reason for the panel: the VIN it names must be readable at the same time,
      // or the confirmation cannot do the one job it has.
      const named = await page.evaluate(() => {
        const main = document.querySelector("main");
        const alert = document.querySelector('[role="alert"]');
        if (!main || !alert) throw new Error("no <main> or no confirmation");
        const view = main.getBoundingClientRect();
        const box = alert.getBoundingClientRect();
        return {
          height: box.height,
          visible: Math.max(0, Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top)),
          text: alert.textContent ?? "",
        };
      });
      expect(named.visible).toBeCloseTo(named.height, 1);
      expect(named.text).toContain("1FU");
    });
  });
}
