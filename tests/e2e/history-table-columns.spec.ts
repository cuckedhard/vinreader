import { expect, test, type Page } from "@playwright/test";

/**
 * [F9] §6.6 fixes eight columns — VIN · Year · Make · Model · Unit · Last scanned · Status ·
 * Copy — and two of them were never on screen at any width measured. The table's *min-content*
 * width beat its scroll container even at 1280×900 with one record: 950 px of table in 770 px
 * of container, so each row's "Copy row" button rendered 62.63 × 56 with 0 visible pixels and
 * `elementFromPoint` at its centre returned the side pane behind it. One row carrying the
 * longest §6.4 status chip took the table to 1110.
 *
 * None of that width was content. It was three `whitespace-nowrap` constraints — on the VIN
 * cell, on the `Chip`, and on the Year — that stopped the table from doing the one thing a
 * table does when it is squeezed. `VinDisplay` already documents that it "wraps at the §4.1
 * group breaks"; the cell was overriding it. With those gone the same two rows measure 725 px
 * of min-content, and the eight columns are all on screen at 1280×900.
 *
 * Below roughly 1200 px the table still scrolls sideways, and that is arithmetic rather than
 * a fault this test can hide: at §6.6's own 900 px threshold the pane leaves the table 472 px,
 * and eight columns headed by a 17-character grouped VIN do not fit in 472 px. Recorded in the
 * ledger with the numbers rather than asserted away here.
 */

const HONDA = "1HGCM82633A004352";
/** §4.4: position 10 `T` with a digit at 7 leaves 1996 and 2026 both standing (N2). */
const FORD = "1FTZX1762TKB12345";

function row(vin: string, unit: string, decode: Record<string, unknown>) {
  return {
    vin,
    structural: {
      wmi: vin.slice(0, 3),
      vds: vin.slice(3, 8),
      checkDigit: vin[8],
      checkDigitValid: true,
      yearCode: vin[9],
      modelYear: { candidates: [], resolved: null },
      plantCode: vin[10],
      serial: vin.slice(11),
      region: "North America",
      country: "United States",
      manufacturerFromWmi: null,
    },
    decode,
    unit,
    notes: null,
    firstScannedAt: "2026-01-01T00:00:00.000+00:00",
    lastScannedAt: "2026-01-01T00:00:00.000+00:00",
    scanCount: 1,
    origin: "scan",
    metaUpdatedAt: "1970-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

/** The two worst realistic rows: an unresolved year, and the longest §6.4 status chip. */
const ROWS = [
  row(HONDA, "TRUCK-7", {
    status: "ok",
    source: "nhtsa_vpic",
    fetchedAt: "2026-01-01T00:00:00.000+00:00",
    attempts: 1,
    lastError: null,
    fields: { Make: "HONDA", Model: "Accord", ModelYear: "2003" },
  }),
  // "Details failed — tap to retry" — the longest chip §6.4 has.
  row(FORD, "TRUCK-B", {
    status: "failed",
    source: "nhtsa_vpic",
    fetchedAt: null,
    attempts: 10,
    lastError: "unreachable",
    fields: {},
  }),
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

test("[F9] all eight §6.6 columns are on screen on a desktop, and Copy is hittable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await seed(page);
  await page.goto("/#/history");
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByText("Details failed — tap to retry")).toBeVisible();

  // The table fits its scroll container: no column is parked outside it.
  const fit = await page.evaluate(() => {
    const wrap = document.querySelector("div.overflow-x-auto");
    if (!(wrap instanceof HTMLElement)) throw new Error("no scroll container");
    return { client: wrap.clientWidth, scroll: wrap.scrollWidth };
  });
  expect(fit.scroll).toBeLessThanOrEqual(fit.client);

  // §6.5: "on the wide layout every row has a copy button". Measured as the ledger measured
  // it — visible width, and what a tap at the centre of the button actually reaches.
  const copies = page.getByRole("button", { name: /^Copy row for / });
  await expect(copies).toHaveCount(ROWS.length);
  for (let i = 0; i < ROWS.length; i += 1) {
    const hit = await copies.nth(i).evaluate((el) => {
      const wrap = el.closest("div.overflow-x-auto") as HTMLElement;
      const box = el.getBoundingClientRect();
      const clip = wrap.getBoundingClientRect();
      const visible = Math.max(0, Math.min(box.right, clip.right) - Math.max(box.left, clip.left));
      const under = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { width: box.width, visible, self: el.contains(under) };
    });
    expect(hit.visible).toBe(hit.width);
    expect(hit.self).toBe(true);
  }

  // And the Status column beside it is whole, not sliced mid-word.
  const chip = await page.getByText("Details failed — tap to retry").evaluate((el) => {
    const wrap = el.closest("div.overflow-x-auto") as HTMLElement;
    const box = el.getBoundingClientRect();
    const clip = wrap.getBoundingClientRect();
    return { right: box.right, edge: clip.right };
  });
  expect(chip.right).toBeLessThanOrEqual(chip.edge);
});
