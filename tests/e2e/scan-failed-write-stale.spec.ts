import { expect, test } from "@playwright/test";
import { writeQrY4m } from "./qr-video";

/**
 * [R3-E] A failed write's banner must not outlive the read it was about.
 *
 * §6.3 holds a check-digit mismatch behind Rescan / Use as-is and writes nothing until the
 * user chooses. When Use as-is fails, `ScanScreen` deliberately calls `rescan()` *without*
 * `dismiss()` — `accept` is what records the §6.3 cooldown, so dismissing there would let a
 * VIN nothing wrote enter the cooldown and make the offered "Scan again" ignore the same
 * label for ten seconds. The camera therefore restarts with "Couldn't save this VIN" still
 * on screen, the same label re-confirms, and the two banners render together: one asking
 * about the label in front of the camera, one about a read that is gone. That second one is
 * a notice describing something that is not there (N2) competing with the notice that is
 * actually asking the user something (P7) — the same fault R3-F5 fixed for a refused
 * carrier, on the write path.
 *
 * The video holds one QR of a VIN §4.3 refuses, which is the read that *stays* on this
 * screen, so "leave the label in frame" is the file looping. Its own spec file because
 * Playwright will not take `test.use({ launchOptions })` inside a describe.
 */

/** §4.11: grammar ok, check digit invalid — sum 313, so position 9 should hold 5. */
const MISREAD = "1HGCM82633A004353";

const Y4M = writeQrY4m("misread-vin", [[MISREAD, 12]]);

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

/**
 * The one storage fault every phone in this app's fleet can hit: a full disk. Never lifted
 * here, unlike `scan-failed-write.spec.ts`: what this test watches happens while the write
 * is still failing.
 */
const BREAK_PUT = () => {
  IDBObjectStore.prototype.put = function () {
    const error = new Error("QuotaExceededError: storage full");
    error.name = "QuotaExceededError";
    throw error;
  };
};

test("[R3-E] a failed write's banner does not survive into the next held read", async ({
  page,
}) => {
  // The §5.6 settings row first, as `scan-storage-failure.spec.ts` does: it isolates the
  // upsert failure, and — the reason that spec gives — it pins the Dexie connection open, so
  // the injected fault lands on the first attempt rather than on a retry that may run after
  // it is lifted.
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.evaluate(BREAK_PUT);
  // HashRouter: changing the fragment does not reload, so the patch survives into /#/scan.
  await page.evaluate(() => {
    window.location.hash = "#/scan";
  });

  const held = page.getByText("Check digit doesn't match.");
  const failed = page.getByText("Couldn't save this VIN");

  // §6.3: the read is held, and nothing is written yet.
  await expect(held).toBeVisible({ timeout: 25_000 });
  await expect(failed).toHaveCount(0);

  await page.getByRole("button", { name: /use as-is/i }).click();

  // The write fails. `pending` goes with it, so this is the one banner on screen — and the
  // camera is restarting with no cooldown recorded, because nothing was saved.
  await expect(failed).toBeVisible({ timeout: 15_000 });
  await expect(held).toHaveCount(0);

  // The label never left the frame, so the same VIN re-confirms and is held again.
  const restarted = Date.now();
  await expect(held).toBeVisible({ timeout: 25_000 });
  const elapsedMs = Date.now() - restarted;
  console.log(`[R3-E] the same label was held again ${elapsedMs} ms after the failed write`);

  // The failure was about the read that has just been replaced. One banner, about the label
  // in front of the camera.
  await expect(
    failed,
    "N2/P7: the failed write's banner outlived the read it was about",
  ).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(1);

  // §6.3's cooldown belongs to a record that exists: the re-read landed inside the ten
  // seconds a cooldown would have suppressed it for, which is the property `rescan()`
  // without `dismiss()` is there to keep.
  expect(elapsedMs, "§6.3: a VIN nothing wrote entered the cooldown").toBeLessThan(10_000);
});
