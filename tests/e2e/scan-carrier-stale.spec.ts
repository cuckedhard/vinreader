import { expect, test } from "@playwright/test";
import { writeQrY4m } from "./qr-video";

/**
 * [R3-F5, second half] A rejection must not outlive the code it describes.
 *
 * `carrierError` was cleared only by a *good carrier*, so pointing the camera at a code the
 * app refuses and then at a real label left the scan screen carrying both banners at once:
 * one about the label in front of the camera, one about a code that had left the frame. A
 * notice that describes something no longer there is a guess shown as a fact (N2), and it
 * competes with the banner that is actually asking the user something (P7).
 *
 * The video is a refused carrier followed by a QR holding a VIN §4.3 refuses — the one good
 * read that *stays* on this screen (§6.3 holds it behind the mismatch banner rather than
 * saving it), and therefore the only one that can be seen beside the stale banner. Its own
 * spec file because Playwright will not take `test.use({ launchOptions })` inside a describe.
 */

/** §4.9's URL carrier, declaring a version this app does not read. */
const BODY = Buffer.from(
  JSON.stringify({ v: 2, vin: "1HGCM82633A004352", mk: "HONDA", md: "Accord" }),
  "utf8",
)
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

/** §4.11: grammar ok, check digit invalid — sum 313, so position 9 should hold 5. */
const MISREAD = "1HGCM82633A004353";

const Y4M = writeQrY4m("carrier-then-vin", [
  [`https://vinrelay.example/#/i?d=${BODY}`, 45],
  [MISREAD, 600],
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

test("[R3-F5] the rejection does not outlive the code it was about", async ({ page }) => {
  await page.goto("/#/scan");
  await expect(page.getByText("Couldn't read that code")).toBeVisible({ timeout: 20_000 });

  // The next thing the camera sees is a VIN, held back by §4.3 rather than saved.
  await expect(page.getByText("Check digit doesn't match.")).toBeVisible({ timeout: 20_000 });

  // One banner, about the label in front of the camera.
  await expect(page.getByText("Couldn't read that code")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(1);
});
