import { expect, test } from "@playwright/test";

/**
 * §13.2 adversary, round 1 of `harden S1`: a Dexie row whose `decode.status` is outside
 * the §4.10 enum reaching the History screen.
 *
 * `DECODE_CHIP` (HistoryScreen.tsx) is typed `Record<DecodeStatus, … | null>`, so the
 * lookup looks total to TypeScript and the guard below it tests for `null`. At runtime
 * an unmodelled status returns `undefined`, the guard lets it through, and reading
 * `.tone` throws during render — which unmounts the whole route, not just that row.
 * No shipped write path can produce such a row today (`upsertVehicle` sets the status
 * itself and the S3 import is zod-validated), so this is about blast radius: one bad
 * row costs every record in History, and §4.12's S4 pull path is the next writer.
 */

const VIN = "1HGCM82633A004352";

const STRUCTURAL = {
  wmi: "1HG",
  vds: "CM826",
  checkDigit: "3",
  checkDigitValid: true,
  yearCode: "3",
  modelYear: { candidates: [2003], resolved: 2003 },
  plantCode: "A",
  serial: "004352",
  region: "North America",
  country: "United States",
  manufacturerFromWmi: null,
};

test("[A-06] History renders when a row carries a decode status outside §4.10", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // Settings first, so Dexie has opened the database before the row is written.
  await page.goto("/#/settings");
  await page.evaluate(
    async ([vin, structural]) => {
      const open = indexedDB.open("vinrelay");
      const dbh: IDBDatabase = await new Promise((res, rej) => {
        open.onsuccess = () => res(open.result);
        open.onerror = () => rej(open.error);
      });
      const tx = dbh.transaction("vehicles", "readwrite");
      tx.objectStore("vehicles").put({
        vin,
        structural,
        decode: {
          // Outside §4.10 `DecodeStatus`.
          status: "weird",
          source: "nhtsa_vpic",
          fetchedAt: null,
          attempts: 0,
          lastError: null,
          fields: {},
        },
        unit: null,
        notes: null,
        firstScannedAt: "2026-01-01T00:00:00.000+00:00",
        lastScannedAt: "2026-01-01T00:00:00.000+00:00",
        scanCount: 1,
        origin: "scan",
        metaUpdatedAt: "1970-01-01T00:00:00.000Z",
        deletedAt: null,
      });
      await new Promise<void>((res, rej) => {
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    },
    [VIN, STRUCTURAL] as const,
  );

  await page.goto("/#/history");
  // P7: whatever the row says, the screen still has to be a screen.
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible({ timeout: 5_000 });
  expect(errors, "one unmodelled row unmounted the whole History route").toEqual([]);
});
