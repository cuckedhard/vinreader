import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Drives the real §6.3 state machine against Chromium's fake camera, fed a
 * generated Code 39 barcode of the ANSI door-label form `I` + VIN. Synthetic,
 * so it proves the pipeline works — never that a scuffed label in glare reads
 * (§13.4, §13.7).
 */
const Y4M = resolve(process.cwd(), "bench/fake-camera.y4m");

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

test("reads a door-label barcode and saves the VIN", async ({ page }) => {
  const errors: string[] = [];
  // Two console errors here are browser policy, not app faults, and both are
  // states §6.1 already says the app must never depend on: the self-signed dev
  // certificate blocks service-worker registration, and vibrate is refused until
  // the frame has seen a tap (this run navigates straight to /#/scan).
  const environmental = (t: string) =>
    t.includes("SSL certificate") || t.includes("navigator.vibrate");
  page.on("console", (m) => {
    if (m.type() === "error" && !environmental(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => !environmental(String(e)) && errors.push(String(e)));

  await page.goto("/#/scan");
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true);

  // §6.3: two identical reads within 1.5s confirm, then the record is written.
  await expect(page).toHaveURL(/#\/v\/1HGCM82633A004352/, { timeout: 20_000 });
  await expect(page.getByText("1HG CM826 3 3 A 004352")).toBeVisible();
  await expect(page.getByText("2003")).toBeVisible();

  await page.getByRole("link", { name: "History" }).click();
  await expect(page.getByText("1HG CM826 3 3 A 004352")).toBeVisible();
  expect(errors).toEqual([]);
});

test("logs the scan with the symbology ZXing reported", async ({ page }) => {
  await page.goto("/#/scan");
  await expect(page).toHaveURL(/#\/v\/1HGCM82633A004352/, { timeout: 20_000 });

  const events = await page.evaluate(async () => {
    const open = indexedDB.open("vinrelay");
    const dbh: IDBDatabase = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
    const tx = dbh.transaction("scanEvents", "readonly").objectStore("scanEvents").getAll();
    return await new Promise<Array<{ vin: string; symbology: string; raw: string }>>((res, rej) => {
      tx.onsuccess = () => res(tx.result);
      tx.onerror = () => rej(tx.error);
    });
  });

  expect(events).toHaveLength(1);
  expect(events[0]!.vin).toBe("1HGCM82633A004352");
  expect(events[0]!.symbology).toBe("code_39");
  // §5.2 keeps the raw read, so the `I` data identifier survives in the log.
  expect(events[0]!.raw).toContain("I1HGCM82633A004352");
});
