import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

/**
 * §13.2 adversary, round 3 of `harden S1`. [R3-A] at the app level.
 *
 * §4.7: "one request per VIN ever (cache is permanent; a manual Refresh details button on
 * the sheet is the only way to re-fetch)". The app has two entry points into the decode
 * queue and only one of them is guarded:
 *
 *   Shell.tsx:11        `startDecodeQueue()` — §5.4's three triggers, behind an in-flight guard
 *   useVinCommit.ts:24  `runDecodeQueueOnce()` — kicked by every successful save, unguarded
 *
 * This drives the field case: the phone is on a weak radio, so the request a scan kicked
 * off is still out (the §4.7 client spends up to 38 s on one VIN — a 10 s timeout, three
 * attempts, 2 s and 6 s backoff), and the radio flaps, which is §5.4's "online" trigger.
 *
 * Deterministic: the first response is held open by the route handler until this test
 * releases it, so nothing here depends on how fast the network or the queue is.
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

test("[R3-A] a scan in flight is not re-requested by the §5.4 online trigger", async ({ page }) => {
  const requested: string[] = [];
  const release: (() => void)[] = [];

  await page.route("**/api/vehicles/DecodeVinValues/**", async (route) => {
    requested.push(route.request().url());
    // Hold the first request open — the weak-radio case §4.7's retry ladder is written
    // for. Every later request is answered at once, so nothing waits on a timeout.
    if (requested.length === 1) {
      await new Promise<void>((resolve_) => release.push(resolve_));
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        Count: 1,
        Message: "synthetic",
        SearchCriteria: null,
        Results: [{ ErrorCode: "0", Make: "HONDA", Model: "Accord", ModelYear: "2003" }],
      }),
    });
  });

  await page.goto("/#/scan");
  // The scan lands, is written, and kicks the decode queue on the way to the Sheet.
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`), { timeout: 20_000 });
  await expect.poll(() => requested.length, { timeout: 10_000 }).toBe(1);

  // §5.4 trigger: the radio comes back. The row is still `pending` because the request
  // above has not been answered, so a second run has something to pick up.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  // A run needs one IndexedDB read to reach `fetch`; a second is well inside a second.
  // The failing direction lands in milliseconds, so this budget only costs a passing run.
  await page.waitForTimeout(1_000);

  const vins = requested.map((url) => url.split("/").pop()?.split("?")[0]);
  release.forEach((resolve_) => resolve_());

  // FAILS today: two requests for one VIN. §4.7 gives a VIN one request ever, and the
  // second one also spends a second `attempts` against §5.4's budget of ten.
  expect(vins).toEqual([VIN]);
});
