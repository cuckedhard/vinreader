import { expect, test } from "@playwright/test";
import { writeQrY4m } from "./qr-video";

/**
 * [FR-2, second half] A refusal must not outlive the code it describes.
 *
 * R3-F5 is the precedent and the warning: the carrier rejection was cleared only by a good
 * carrier, so a phone that had been pointed at a refused code and then at a real label
 * carried both notices at once — one about the label in front of the camera, one about
 * something that had left the frame. A notice describing what is no longer there is a guess
 * shown as a fact (N2), and it competes with the banner that is actually asking the user
 * something (P7).
 *
 * The video is the component label's part number followed by a VIN §4.3 refuses — the one
 * good read that *stays* on this screen, because §6.3 holds it behind the mismatch banner
 * rather than saving it, and therefore the only one that could be seen beside a stale
 * refusal. Its own spec file because Playwright will not take `test.use({ launchOptions })`
 * inside a describe.
 */

const PART_NUMBER = "R25-1251-200622120";
/** §4.11: grammar ok, check digit invalid — sum 313, so position 9 should hold 5. */
const MISREAD = "1HGCM82633A004353";

const Y4M = writeQrY4m("not-a-vin-then-vin", [
  // Two seconds of the component label — long enough for §6.3's two-read agreement — and
  // then the VIN, which stops the stream the moment §4.3 holds it.
  [PART_NUMBER, 60],
  [MISREAD, 240],
]);

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

test("[FR-2] the refusal does not outlive the code it was about", async ({ page }) => {
  await page.goto("/#/scan");
  await expect(page.getByText(PART_NUMBER)).toBeVisible({ timeout: 20_000 });

  // The next thing the camera sees is a VIN, held back by §4.3 rather than saved.
  await expect(page.getByText("Check digit doesn't match.")).toBeVisible({ timeout: 20_000 });

  // One banner, about the label in front of the camera.
  await expect(page.getByText(PART_NUMBER)).toHaveCount(0);
  await expect(page.getByText("Not a VIN yet")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(1);
});
