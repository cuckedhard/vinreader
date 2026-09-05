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
 * discards its answer, and the fix is to render `error` above the loading line.
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

for (const [name, script] of [
  ["indexedDB.open throws", OPEN_THROWS],
  ["indexedDB is absent", NO_INDEXEDDB],
] as const) {
  test(`[G5] Settings says why it is empty when ${name}`, async ({ page }) => {
    await page.addInitScript(script);
    await page.goto("/#/settings");

    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    // TODAY: this is what the screen shows, permanently. The assertion is written as the
    // thing that must stop being true rather than as the thing that must be true, so it
    // cannot pass by the wording of the replacement happening to differ.
    await expect(page.getByText("Loading…")).toHaveCount(0, { timeout: 10_000 });
  });
}
