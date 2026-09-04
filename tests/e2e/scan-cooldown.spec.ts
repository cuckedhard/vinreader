import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

/**
 * §13.2 adversary, round 1 of `harden S1`.
 *
 * §6.3: "Cooldown: the same VIN confirmed again within 10 s is ignored (prevents
 * double-logging on return to Scan)." This drives exactly that sentence: scan the
 * label, land on the Sheet, walk back to Scan with the label still in frame.
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

test.beforeEach(async ({ page }) => {
  await page.route("**/api/vehicles/DecodeVinValues/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        Count: 1,
        Message: "synthetic",
        SearchCriteria: null,
        Results: [{ ErrorCode: "0", Make: "HONDA", Model: "Accord", ModelYear: "2003" }],
      }),
    }),
  );
});

async function readStore(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    const open = indexedDB.open("vinrelay");
    const dbh: IDBDatabase = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
    function all<T>(store: string): Promise<T[]> {
      const req = dbh.transaction(store, "readonly").objectStore(store).getAll();
      return new Promise((res, rej) => {
        req.onsuccess = () => res(req.result as T[]);
        req.onerror = () => rej(req.error);
      });
    }
    const events = await all<{ vin: string; at: string }>("scanEvents");
    const vehicles = await all<{ vin: string; scanCount: number }>("vehicles");
    return { events, vehicles };
  });
}

test("[A-02] the same VIN is not logged twice on an immediate return to Scan", async ({ page }) => {
  await page.goto("/#/scan");
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`), { timeout: 20_000 });

  // Straight back to the camera with the same label still in front of it — the exact
  // case §6.3's ten-second cooldown names.
  await page.getByRole("link", { name: "Scan", exact: true }).click();
  await expect(page).toHaveURL(/#\/scan/);
  // Give the camera the same budget the first read had; the assertion below is about
  // what was written, not about how long the second read took.
  await page.waitForURL(new RegExp(`#/v/${VIN}`), { timeout: 20_000 }).catch(() => undefined);

  const { events, vehicles } = await readStore(page);
  const times = events.map((e) => Date.parse(e.at)).sort((a, b) => a - b);
  console.log(
    `[A-02] scanEvents=${events.length} scanCount=${vehicles[0]?.scanCount} gaps=${times
      .slice(1)
      .map((t, i) => t - times[i]!)
      .join(",")}ms`,
  );

  expect(events.length, "the first read never landed").toBeGreaterThanOrEqual(1);
  // §6.3, stated as the invariant it is: two confirmations of the same VIN can never be
  // logged less than the cooldown apart. Never inconclusive — a suppressed second read
  // simply leaves one event, and a genuinely late one leaves a gap over the bound.
  for (let i = 1; i < times.length; i += 1) {
    expect(
      times[i]! - times[i - 1]!,
      "§6.3: the same VIN was logged twice inside the 10 s cooldown",
    ).toBeGreaterThanOrEqual(10_000);
  }
  expect(vehicles[0]?.scanCount).toBe(events.length);
});
