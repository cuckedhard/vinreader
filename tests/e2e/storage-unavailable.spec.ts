import { expect, test } from "@playwright/test";

/**
 * [F1] Storage fails, and the app still has to be an app.
 *
 * Every screen that reads §5 storage reads it through `useLiveQuery`, and
 * `dexie-react-hooks` re-throws a rejected query **during render** — deliberately, "so that
 * an ErrorBoundrary can catch it" (dexie-react-hooks.mjs:94). There was no boundary
 * anywhere under `src/`, so React's answer to that throw was to unmount the root: an empty
 * `<div id="root">`, no Scan screen, no way to type a VIN, on the one device where the
 * keyboard path matters most (N1/P1 — a scan is never blocked).
 *
 * The write path was already defended (`useVinCommit` catches the upsert, `getSettings()`
 * catches its read). This is the read path, and these tests are the floor under it.
 *
 * Two different faults, because IndexedDB fails in two different ways and only one of them
 * reaches the boundary:
 *   · reads that throw **after** the database opened — iOS Safari's "Connection to Indexed
 *     Database server lost", a disk error mid-session. Dexie rejects the query, `liveQuery`
 *     forwards it, and the hook throws. This is the blank page.
 *   · IndexedDB absent or refusing to open. Dexie's failure is a `DatabaseClosedError`,
 *     which `liveQuery` filters out (dexie.mjs:6134), so nothing is ever emitted and the
 *     screen simply never answers. Asserted here only to the extent that it is asserted at
 *     all: the app renders and the keyboard path works.
 */

/** Reads that throw once the database is open. The fault that unmounted the root. */
const BREAK_READS = () => {
  const proto = IDBObjectStore.prototype as unknown as Record<string, unknown>;
  for (const name of ["get", "getAll", "openCursor", "count"]) {
    proto[name] = function () {
      const error = new Error("Connection to Indexed Database server lost");
      error.name = "UnknownError";
      throw error;
    };
  }
};

/**
 * The same fault, but only on the index cursors that list rows — History orders by
 * `lastScannedAt` (§5.3), so this is its read and not the shell's. It isolates a screen
 * failing from the app failing.
 */
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

const VIN = "1HGCM82633A004352";

/** N1/P1: read or type a VIN. Storage is what fails afterwards, not the screen. */
async function reachesManualEntry(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: /type vin instead/i }).click();
  await page.locator("input[type=text], input:not([type])").first().fill(VIN);
  await expect(page.getByText("1HG CM826 3 3 A 004352")).toBeVisible();
}

test("[F1] a read that throws does not take the app down", async ({ page }) => {
  await page.addInitScript(BREAK_READS);
  await page.goto("/#/scan");

  // The floor. Before the boundary this was empty — on this route and on every other,
  // because the throw came from the shell's own theme query and killed the root.
  await expect(page.locator("#root")).not.toBeEmpty();
  await reachesManualEntry(page);
});

test("[F1] the screen that could not read says so, and the nav still leaves it", async ({
  page,
}) => {
  await page.addInitScript(BREAK_LIST_READS);
  await page.goto("/#/history");

  // P7: loudly to the user. §6.4 has no line for this state; the wording is supplied under
  // §0 rule 4 and pinned by src/app/ErrorBoundary.test.ts.
  const notice = page.getByRole("alert").filter({ hasText: "Storage isn't available" });
  await expect(notice).toBeVisible({ timeout: 10_000 });
  await expect(notice).toContainText("UnknownError: Connection to Indexed Database server lost");

  // The boundary is keyed on the route, so the notice does not outlive the screen that
  // raised it — without that, one failed History would make Scan unreachable for good.
  await page.getByRole("link", { name: "Scan" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Storage isn't available" })).toHaveCount(
    0,
  );
  await reachesManualEntry(page);
});

for (const [name, script] of [
  ["indexedDB.open throws", OPEN_THROWS],
  ["indexedDB is absent", NO_INDEXEDDB],
] as const) {
  test(`[F1] the keyboard path survives when ${name}`, async ({ page }) => {
    await page.addInitScript(script);
    await page.goto("/#/scan");

    await expect(page.locator("#root")).not.toBeEmpty();
    await reachesManualEntry(page);

    // History renders its own frame rather than a white page. It cannot yet say why it is
    // empty — Dexie's `DatabaseClosedError` never reaches the boundary — and that gap is
    // reported rather than asserted away here.
    await page.getByRole("link", { name: "History" }).click();
    await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  });
}
