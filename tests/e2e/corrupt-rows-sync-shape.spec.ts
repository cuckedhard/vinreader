import { expect, test } from "@playwright/test";

/**
 * §13.2 adversary, round 2 of `harden S1`: "corrupted Dexie rows" reaching History and the
 * Sheet — specifically the row shape §4.12 says the server will hand back.
 *
 * Round 1 (A20) guarded ONE field: `decode.status` outside §4.10 no longer takes the
 * History route down. The guard stops at that field, and §4.12's own schema produces a
 * blunter row than that. `public.vehicles` declares
 *
 *     structural jsonb not null default '{}'::jsonb,
 *     decode     jsonb not null default '{}'::jsonb,
 *
 * and `apply_scan_event()` — the trigger that creates the row, since P8 makes events the
 * truth — inserts only `(user_id, vin, meta_updated_at, first_scanned_at, last_scanned_at,
 * scan_count)`. So a `vehicles` row created by another device's scan_event carries
 * `structural = {}` and `decode = {}` until that device also pushes its meta. Pulling it
 * gives this client a row whose `structural.modelYear` and `decode.fields` are `undefined`.
 *
 * `HistoryScreen.headline()` reads `record.structural.modelYear.resolved` (HistoryScreen.tsx:66)
 * and `SheetScreen` reads `record.decode.fields.ModelYear` (SheetScreen.tsx:231), both
 * unguarded, so the throw happens during render and React unmounts the whole route (P7:
 * "Fail loudly to the user" — a blank screen is neither loud nor a screen).
 *
 * Nothing in S0–S3 writes such a row; S4's pull is the writer, and the tests are written
 * now so the shape is pinned before that lands.
 */

const VIN = "1HGCM82633A004352";

/** Exactly what §4.12's `apply_scan_event()` trigger leaves behind, mapped to §5.1. */
const SYNC_SHAPED_ROW = {
  vin: VIN,
  structural: {},
  decode: {},
  unit: null,
  notes: null,
  firstScannedAt: "2026-01-01T00:00:00.000+00:00",
  lastScannedAt: "2026-01-01T00:00:00.000+00:00",
  scanCount: 1,
  origin: "scan",
  metaUpdatedAt: "1970-01-01T00:00:00.000Z",
  deletedAt: null,
};

async function seed(page: import("@playwright/test").Page, row: unknown): Promise<void> {
  await page.evaluate(async (value) => {
    const open = indexedDB.open("vinrelay");
    const dbh: IDBDatabase = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
    const tx = dbh.transaction("vehicles", "readwrite");
    tx.objectStore("vehicles").put(value);
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }, row);
}

test("[R2-05] History survives a vehicle row with an empty structural block", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // Settings first, so Dexie has opened the database before the row is written.
  await page.goto("/#/settings");
  await seed(page, SYNC_SHAPED_ROW);

  await page.goto("/#/history");
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible({ timeout: 5_000 });
  // One unreadable row must cost that row, never every other record on the phone.
  expect(errors, "an empty §4.12 structural block unmounted the whole History route").toEqual([]);
});

test("[R2-05] the Sheet survives a vehicle row with an empty decode block", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/#/settings");
  await seed(page, SYNC_SHAPED_ROW);

  await page.goto(`/#/v/${VIN}`);
  // P7: whatever the row says, the screen still has to be a screen. The VIN itself is
  // always known — it is the primary key — so there is always something honest to render.
  await expect(page.getByText("1HG CM826 3 3 A 004352")).toBeVisible({ timeout: 5_000 });
  expect(errors, "an empty §4.12 decode block unmounted the whole Sheet route").toEqual([]);
});
