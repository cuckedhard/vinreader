import { expect, test } from "@playwright/test";
import { writeQrY4m } from "./qr-video";

/**
 * [FR-2] The camera says what it read and why it is not a VIN.
 *
 * The field report: a DYNACRAFT (a division of PACCAR) component label on a 2013 Kenworth,
 * three Code 128 symbols, one field each, and not the federal certification label. The app
 * refused every one of them — correctly — and said nothing, so the mechanic photographed
 * the sticker and asked a person. The refusal was never the defect; the silence was.
 *
 * The video holds the part number off that sticker. A QR rather than the Code 128 it was
 * printed on, because this behaviour is symbology-independent — §4.2 sees the same
 * eighteen characters either way — and because `writeQrY4m` is the fake camera this suite
 * already has (§7 item 5).
 *
 * What must NOT happen is a strobe: the decode loop runs several times a second, and §6.4
 * rules that garbage keeps the scanner going. §6.3's two-read agreement is what separates
 * a coherent read from noise, and the last assertion here holds the message still for two
 * seconds of continuous decoding to prove it does not flicker.
 */

const PART_NUMBER = "R25-1251-200622120";
const WHY = "No 17 characters in a row here — the longest run is 9.";

// Three seconds of it, which Chromium loops for as long as a test keeps the camera open.
// Every frame is the same symbol, so the loop is indistinguishable from a phone held still.
const Y4M = writeQrY4m("not-a-vin", [[PART_NUMBER, 90]]);

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

test("[FR-2] a coherent read that is not a VIN is shown, with the reason", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/scan");

  const notice = page.getByRole("alert");
  await expect(notice).toContainText("Not a VIN yet", { timeout: 20_000 });
  // The string the app had in hand and would not show. This is the whole finding.
  await expect(notice).toContainText(PART_NUMBER);
  await expect(notice).toContainText(WHY);
  // Nothing about what it *is*: the app cannot see a part number or a pallet tag (N2).
  await expect(notice).not.toContainText(/part number/i);
  await expect(notice).not.toContainText(/sticker/i);

  // §6.4's scan states are not buried: the camera is still running and still says where to
  // point it, and the keyboard route is still on screen (N1 — a scan is never blocked).
  await expect(page.getByText("Point at the barcode on the door-jamb sticker.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Type VIN instead" })).toBeVisible();
  // Nothing was saved and nothing navigated.
  await expect(page).toHaveURL(/#\/scan$/);

  // §6.1: the read is set like a VIN, because it is read off the phone like one.
  const style = await notice.getByText(PART_NUMBER).evaluate((el) => {
    const css = getComputedStyle(el);
    return { size: parseFloat(css.fontSize), family: css.fontFamily.toLowerCase() };
  });
  expect(style.size).toBeGreaterThanOrEqual(28);
  expect(style.family).toContain("mono");
});

test("[FR-2] the banner is on screen on the smallest phone in the matrix", async ({ page }) => {
  // R3-F1: the machine stays `streaming` for a refused read, so this banner opens below a
  // full-height preview — and that is exactly how the carrier rejection shipped with 0
  // visible pixels at 360x640 while the camera worked perfectly. This banner is taller
  // still: it carries the read at §6.1's VIN size.
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/#/scan");

  const notice = page.getByRole("alert");
  await expect(notice).toContainText(PART_NUMBER, { timeout: 20_000 });

  const box = await notice.boundingBox();
  const fold = page.viewportSize()?.height ?? 0;
  expect(box).not.toBeNull();
  // Not merely in the DOM: the top of it and the reason under it are both above the fold.
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(fold);
  // And the camera is still streaming behind it (N1/P1) — nothing was stopped to make room.
  await expect(page.getByText("Point at the barcode on the door-jamb sticker.")).toBeVisible();
});

test("[FR-2] the message holds still while the decoder keeps running", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/scan");

  const notice = page.getByRole("alert");
  await expect(notice).toContainText(PART_NUMBER, { timeout: 20_000 });

  // Two seconds of continuous decoding — twenty-odd frames, every one of them the same
  // refusal — and the banner neither flickers nor repeats itself. A message per refused
  // frame would be unusable and would bury the §6.4 states that matter.
  const samples: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    samples.push((await notice.textContent()) ?? "");
    await expect(notice).toHaveCount(1);
    await page.waitForTimeout(250);
  }
  expect(new Set(samples).size).toBe(1);
});

test("[FR-2] Keep scanning answers this read, and the same code does not ask again", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/scan");

  const notice = page.getByRole("alert");
  await expect(notice).toContainText(PART_NUMBER, { timeout: 20_000 });

  // §6.1's floor, as a rendered box and against the token that defines it (§7 item 5).
  const keep = page.getByRole("button", { name: "Keep scanning" });
  const tap = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tap")),
  );
  expect(tap).toBeGreaterThan(0);
  expect((await keep.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(tap);

  await keep.click();
  await expect(notice).toHaveCount(0);

  // R3-F5: the realistic case is the same sticker still under the camera, so the tap has to
  // answer *that read* and not just the banner — otherwise the very next frame raises it
  // again and the button does nothing anyone can see.
  await page.waitForTimeout(2000);
  await expect(notice).toHaveCount(0);
  // The camera never stopped for any of this.
  await expect(page.getByText("Point at the barcode on the door-jamb sticker.")).toBeVisible();
});
