import { expect, test } from "@playwright/test";

/**
 * §13.2 adversary — IndexedDB that never opens, on the two routes `storage-unavailable`
 * does not cover.
 *
 * [G5] **Settings holds the reason and renders "Loading…" instead of it, forever.**
 * `SettingsScreen` already runs the storage-availability probe F1-b says is missing —
 * `useEffect(() => { getSettings().catch((cause) => setError(describe(cause))) })`
 * (SettingsScreen.tsx:229-231) — so the failure IS captured, in `error`. But the loading
 * gate three lines below it, `if (!stored) return <h1>Settings</h1><p>Loading…</p>`
 * (SettingsScreen.tsx:243-251), returns before the render that would show `error`. The
 * live query never emits (Dexie filters `DatabaseClosedError` out of `liveQuery`), so
 * `stored` stays `undefined` and the screen says "Loading…" for the rest of the session
 * while holding the sentence that explains it.
 *
 * P7: every error state is loud. This one is written, caught, stored — and then stepped
 * over. Settings is also where "Clear all data" lives, which is the one recovery a user
 * has for a wedged database, so the screen that cannot say what is wrong is the screen
 * they were sent to.
 *
 * This is not F1-b. F1-b needs a probe that does not exist; this one has the probe and
 * discards its answer, and the fix is to render what it caught above the loading line.
 *
 * [F1-b] **The Sheet and History render an empty frame instead of a reason.** Same fault,
 * a different gap: no probe at all on those two routes, so `useLiveQuery` returning
 * `undefined` forever was read as "still loading" forever. `useStorageFailure` is the
 * signal; the four cases below are the floor under it.
 *
 * The two faults below are the two ways IndexedDB refuses at the door, copied from
 * `storage-unavailable.spec.ts` so both specs describe the same platform behaviour.
 */

/** Storage refused at the door: an enterprise policy, an opaque-origin frame. */
const OPEN_THROWS = () => {
  indexedDB.open = function () {
    throw new DOMException("The user denied permission to access the database.", "SecurityError");
  };
};

/** Storage absent altogether. */
const NO_INDEXEDDB = () => {
  Object.defineProperty(window, "indexedDB", { value: undefined, configurable: true });
};

/** §4.11's fixture VIN, the one every other spec here saves and reads back. */
const VIN = "1HGCM82633A004352";

/** The §6.4-tone notice supplied under §0 rule 4 and pinned by `src/app/ErrorBoundary.test.ts`. */
const STORAGE_TITLE = "Storage isn't available";

for (const [name, script] of [
  ["indexedDB.open throws", OPEN_THROWS],
  ["indexedDB is absent", NO_INDEXEDDB],
] as const) {
  /**
   * [F1-b] The Sheet is where a scan lands, and under this fault it rendered NOTHING —
   * `main.innerHTML.length` was 0, no heading, no message, no error, for the rest of the
   * session — because `SheetScreen` reads `record === undefined` as "still loading" and
   * `liveQuery` never emits when the database never opened. The boundary cannot reach it:
   * Dexie filters `DatabaseClosedError` before `observer.error`, so nothing is ever thrown.
   */
  test(`[F1-b] the Sheet says why it is empty when ${name}`, async ({ page }) => {
    await page.addInitScript(script);
    await page.goto(`/#/v/${VIN}`);

    const notice = page.getByRole("alert").filter({ hasText: STORAGE_TITLE });
    await expect(notice).toBeVisible({ timeout: 10_000 });
    // The measurement from the ledger, as the thing that must stop being true.
    expect(await page.locator("main").innerHTML()).not.toBe("");
  });

  /** [F1-b] History as the row originally recorded it: its heading, and then nothing. */
  test(`[F1-b] History says why it is empty when ${name}`, async ({ page }) => {
    await page.addInitScript(script);
    await page.goto("/#/history");

    await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: STORAGE_TITLE })).toBeVisible({
      timeout: 10_000,
    });
  });

  test(`[G5] Settings says why it is empty when ${name}`, async ({ page }) => {
    await page.addInitScript(script);
    await page.goto("/#/settings");

    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    // WAS: this, permanently. The assertion is written as the thing that must stop being
    // true rather than as the thing that must be true, so it cannot pass by the wording of
    // the replacement happening to differ.
    await expect(page.getByText("Loading…")).toHaveCount(0, { timeout: 10_000 });

    // And the replacement is the reason, not an empty screen: the same §6.4-tone notice the
    // Sheet and History now show, over the failure `getSettings()` had already caught.
    await expect(page.getByRole("alert").filter({ hasText: STORAGE_TITLE })).toBeVisible();
  });
}
