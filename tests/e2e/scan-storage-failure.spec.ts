import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

/**
 * §13.2 adversary, round 2 of `harden S1`: storage quota errors on the CAMERA path.
 *
 * `tests/e2e/scan-failed-write.spec.ts` (round 1, N-02) already drives a failed write, but
 * it types the VIN — `ManualEntry` never calls `getSettings`, so it exercises
 * `useVinCommit.write`, whose settings read is deliberately guarded
 * (`getSettings().catch(() => null)`, "N1: a settings read that fails must not fail the
 * save"). The camera path is different: `ScanScreen`'s commit effect awaits its OWN
 * unguarded `getSettings()` before `request()`, and the caller is `void commit(sighting)`
 * with no rejection handler. These two tests split that difference.
 *
 * §6.3 · §5.6 · P7 ("Fail loudly to the user, quietly in the log. No silent
 * catch-and-ignore.") · §6.1 (the screen change is the primary feedback).
 */
const Y4M = resolve(process.cwd(), "bench/fake-camera.y4m");

const VIN = "1HGCM82633A004352";

test.use({
  launchOptions: {
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${Y4M}`,
    ],
  },
});

/** The one storage fault every phone in this app's fleet can hit: a full disk. */
const BREAK_PUT = () => {
  const put = IDBObjectStore.prototype.put;
  (window as unknown as { restorePut: () => void }).restorePut = () => {
    IDBObjectStore.prototype.put = put;
  };
  IDBObjectStore.prototype.put = function () {
    const error = new Error("QuotaExceededError: storage full");
    error.name = "QuotaExceededError";
    throw error;
  };
};

/**
 * [R2-03] §5.6 `getSettings()` opens an `rw` transaction and PUTS the default row when it
 * is missing — which is every first scan on a device. With storage full it rejects, and
 * `ScanScreen`'s commit effect has no catch: nothing is written, nothing is shown, and
 * `acted.current` has already been stamped so the sighting is never retried. The scanner
 * sits on "Got it ✓" over a VIN that does not exist in the database.
 */
test("[R2-03] a scan that cannot read settings still tells the user nothing was saved", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.addInitScript(BREAK_PUT);
  await page.goto("/#/scan");

  // §6.3 reaches `confirmed` from the camera alone; storage is not in that path. The
  // status line is asserted through the VIN rather than the success wording: R2-04 in this
  // same round establishes that "Got it ✓" must NOT appear when nothing was stored, and
  // the fix for it makes the line read "Check this read." here.
  await expect(page.getByText("1HG CM826 3 3 A 004352")).toBeVisible({ timeout: 25_000 });

  // Nothing was written — that part is correct and expected with a full disk.
  const written = await page.evaluate(async () => {
    const open = indexedDB.open("vinrelay");
    const dbh: IDBDatabase = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
    if (!dbh.objectStoreNames.contains("vehicles")) return 0;
    const req = dbh.transaction("vehicles", "readonly").objectStore("vehicles").getAll();
    const rows: unknown[] = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result as unknown[]);
      req.onerror = () => rej(req.error);
    });
    return rows.length;
  });
  expect(written, "the write should have failed with storage full").toBe(0);

  // P7: the failure has to reach the user. The same fault on the keyboard path renders
  // "Couldn't save this VIN"; the camera path must not be quieter than the keyboard.
  await expect(
    page.getByRole("alert").filter({ hasText: "Couldn't save this VIN" }),
    "P7: a scan that saved nothing was reported to the user as a success",
  ).toBeVisible({ timeout: 10_000 });

  expect(pageErrors, "the settings read rejected with no handler").toEqual([]);
});

/**
 * [R2-04] The handled half of the same fault. With the settings row already present
 * `getSettings()` succeeds, `write()` catches the upsert failure and renders the §6.4-less
 * "Couldn't save this VIN" banner — but the machine is still `confirmed`, so `CameraView`
 * keeps rendering "Got it ✓" in `--ok` green directly above it. §6.1 makes the screen
 * change the primary feedback and round 1 (A05) already removed the success line from the
 * other state where the read is not a saved scan; this is the same contradiction on the
 * write-failure branch.
 */
test("[R2-04] the success line is not shown next to a write failure", async ({ page }) => {
  // Create the §5.6 settings row first, so this test isolates the upsert failure.
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  // HashRouter: changing the fragment does not reload, so the patch survives into /#/scan.
  await page.evaluate(BREAK_PUT);
  await page.evaluate(() => {
    window.location.hash = "#/scan";
  });

  await expect(page.getByRole("alert").filter({ hasText: "Couldn't save this VIN" })).toBeVisible({
    timeout: 25_000,
  });

  // Nothing was saved, so nothing was "got".
  await expect(page).not.toHaveURL(new RegExp(`#/v/${VIN}`));
  await expect(
    page.getByText("Got it ✓"),
    "§6.1/§6.3: the success line stands beside 'Nothing was written'",
  ).toHaveCount(0);
});


/**
 * [R3-F11] §6.4 answers a failed write in two halves — the status line "Not saved." beside
 * the VIN it is about, and the banner "Couldn't save this VIN" with what went wrong and the
 * way on. They were 200 px apart at 390×844, with "Type VIN instead" between them: "Not
 * saved." at y 62, the VIN at 94.8, the button at 180.8, the banner at 261.8. Both are on
 * screen even at 360×640, so this is ordering rather than visibility — a message split
 * around an unrelated control is one a hurried reader puts together wrong, or not at all.
 */
test("[R3-F11] the two halves of the write failure are one message", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); // §6.1's case: one hand, a phone.
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.evaluate(BREAK_PUT);
  await page.evaluate(() => {
    window.location.hash = "#/scan";
  });

  const banner = page.getByRole("alert").filter({ hasText: "Couldn't save this VIN" });
  await expect(banner).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText("Not saved.")).toBeVisible();

  const split = await page.evaluate(() => {
    const boxOf = (text: string) => {
      const node = Array.from(document.querySelectorAll("p")).find(
        (p) => (p.textContent ?? "").trim() === text,
      );
      if (node === undefined) throw new Error(`no "${text}"`);
      return node.getBoundingClientRect();
    };
    const status = boxOf("Not saved.");
    const title = boxOf("Couldn't save this VIN");
    const top = Math.min(status.bottom, title.bottom);
    const bottom = Math.max(status.top, title.top);
    // Anything a user can act on that sits in the gap between the two halves and belongs to
    // neither of them. The banner's own action is part of the message it is attached to.
    const alert = document.querySelector("[role=alert]");
    const between = Array.from(document.querySelectorAll("button, a[href]"))
      .filter((el) => alert === null || !alert.contains(el))
      .map((el) => ({ el, box: el.getBoundingClientRect() }))
      .filter(({ box }) => box.height > 0 && box.top + box.height / 2 > top)
      .filter(({ box }) => box.top + box.height / 2 < bottom)
      .map(({ el }) => (el.textContent ?? "").trim());
    return { between, gap: Math.round(bottom - top) };
  });

  expect(split.between, "a control stands between the two halves of one message").toEqual([]);
});
