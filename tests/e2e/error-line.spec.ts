import { expect, test } from "@playwright/test";

/**
 * [R3-F4, F12] The engine string §6.4 asks for, printed once.
 *
 * §6.4 wants the underlying error under "Couldn't save this VIN" — "printed beneath it in
 * monospace" — so it is not the app's to hide. What it is not allowed to be is §6.4's own
 * word for the tone: "terse, plain". Dexie composes a rejection's `message` as the fault,
 * a newline, and the inner error restating itself, and both sites then added the name in
 * front of that, so the same sentence reached a field user twice on one line:
 *
 *   write path (R3-F4):  "storage full QuotaExceededError: storage full"
 *   boundary  (F12):     "UnknownError: Connection to Indexed Database server lost
 *                          UnknownError: Connection to Indexed Database server lost"
 *
 * Both are measured here as rendered text, and both count occurrences rather than matching
 * a whole string: a guard that pinned the exact sentence would go green on any wording and
 * red on a Dexie upgrade, and neither is what this is about.
 */

const VIN = "1HGCM82633A004352";

/** How many times `needle` occurs in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The real shape: a DOMException from IndexedDB, wrapped by Dexie on its way out. */
const BREAK_PUT = () => {
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args: unknown[]) {
    if (this.name !== "vehicles") return put.apply(this, args as never);
    throw new DOMException("storage full", "QuotaExceededError");
  };
};

/** Reads that throw once the database is open — the fault that reaches the boundary. */
const BREAK_LIST_READS = () => {
  const proto = IDBIndex.prototype as unknown as Record<string, unknown>;
  for (const name of ["getAll", "openCursor"]) {
    proto[name] = function () {
      const error = new Error("Connection to Indexed Database server lost");
      error.name = "UnknownError";
      throw error;
    };
  }
};

test("[R3-F4] the write failure prints its fault once, on one line", async ({ page }) => {
  // Open the database before injecting the fault: Dexie retries a transaction that failed
  // while the connection was still opening (scan-failed-write.spec.ts).
  await page.goto("/#/history");
  await expect(page.getByText("Nothing scanned yet")).toBeVisible();
  await page.evaluate(BREAK_PUT);

  await page.getByRole("link", { name: "Scan" }).click();
  await page.getByRole("button", { name: /type vin instead/i }).click();
  await page.getByRole("textbox", { name: /vin/i }).fill(VIN);
  await page.getByRole("button", { name: "Save VIN" }).click();

  const banner = page.getByRole("alert").filter({ hasText: "Couldn't save this VIN" });
  await expect(banner).toBeVisible();

  // The detail line: §6.4's monospace print of the underlying error.
  const detail = (await banner.locator("p.font-vin").textContent()) ?? "";
  expect(detail).toContain("storage full");
  expect(occurrences(detail, "storage full")).toBe(1);
  expect(occurrences(detail, "QuotaExceededError")).toBe(1);
  expect(detail).not.toMatch(/[\n\r\t]|\s{2}/);
});

test("[F12] the boundary prints its fault once, on one line", async ({ page }) => {
  await page.addInitScript(BREAK_LIST_READS);
  await page.goto("/#/history");

  const notice = page.getByRole("alert").filter({ hasText: "Storage isn't available" });
  await expect(notice).toBeVisible({ timeout: 10_000 });

  const detail = (await notice.locator("p.font-vin").textContent()) ?? "";
  const lost = "Connection to Indexed Database server lost";
  expect(detail).toContain(lost);
  expect(occurrences(detail, lost)).toBe(1);
  expect(occurrences(detail, "UnknownError")).toBe(1);
  expect(detail).not.toMatch(/[\n\r\t]|\s{2}/);
});
