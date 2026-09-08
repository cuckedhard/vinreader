import { expect, test } from "@playwright/test";
import { writeQrY4m } from "./qr-video";

/**
 * [FR-3] A refusal must not outlive the code it describes — including when what replaces it
 * is one of the app's own §4.9 carriers.
 *
 * R3-F5 fixed this in one direction and FR-2 in the other: a refused carrier is dropped once
 * a VIN turns up (`showCarrier`'s state guard), and an agreed refusal is dropped by
 * `decoded`. Neither covers a *carrier* replacing a *refusal*. `readScanResult` answers
 * `{kind:"carrier"}` above `extractVinExplained` and the hook only handed that to the screen,
 * so nothing told the machine the frame had moved on and `machine.refusal` stood. A phone
 * pointed at a refused sticker and then at a VIN Relay code therefore carried both banners at
 * once, each with its own "Keep scanning", one of them about a code that had left the frame —
 * a notice describing something that is not there (N2) competing with the notice that is
 * actually asking the user something (P7).
 *
 * The video is the component label's part number followed by a §4.9 URL carrier declaring a
 * version this app does not read — the one carrier read that *stays* on this screen, because
 * a readable one navigates to Import and takes the whole screen with it. Its own spec file
 * because Playwright will not take `test.use({ launchOptions })` inside a describe.
 */

/** The field report's part number: decodes cleanly on every frame, and is not a VIN (§4.2). */
const PART_NUMBER = "R25-1251-200622120";

/** §4.9's URL carrier, declaring a version this app does not read (P6). */
const BODY = Buffer.from(
  JSON.stringify({ v: 2, vin: "1HGCM82633A004352", mk: "HONDA", md: "Accord" }),
  "utf8",
)
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

const Y4M = writeQrY4m("not-a-vin-then-carrier", [
  // Two seconds of the component label — long enough for §6.3's two-read agreement to put
  // the refusal on screen — and then ten of the carrier. Chromium loops the file, so the
  // second segment is deliberately the long one: the assertions below are about what is on
  // screen while the carrier is the thing in front of the camera.
  [PART_NUMBER, 60],
  [`https://vinrelay.example/#/i?d=${BODY}`, 300],
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

test("[FR-3] the refusal does not outlive the code a carrier replaced", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/scan");

  // §6.4: what was read and why it is not a VIN (FR-2).
  await expect(page.getByText(PART_NUMBER)).toBeVisible({ timeout: 20_000 });

  // The next thing the camera sees is one of the app's own codes, and this app cannot read
  // its version — §6.4's "Couldn't read that code", which leaves the camera running.
  await expect(page.getByText("Couldn't read that code")).toBeVisible({ timeout: 20_000 });

  // One banner, about the code in front of the camera. Both halves of the pair are named
  // because the finding was the pair: the refusal's title, and the read it quoted.
  await expect(
    page.getByText(PART_NUMBER),
    "N2/P7: the refusal outlived the code it was about",
  ).toHaveCount(0);
  await expect(page.getByText("Not a VIN yet")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(1);
  // The sharpest form of it: two banners meant two "Keep scanning" buttons, and one of them
  // answered a read that was no longer on the screen it was answering for.
  await expect(page.getByRole("button", { name: "Keep scanning" })).toHaveCount(1);

  // N1: nothing here stopped the stream. The camera is still running, still says where to
  // point it, and still offers the keyboard.
  await expect(page.getByText("Point at the barcode on the door-jamb sticker.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Type VIN instead" })).toBeVisible();
  await expect(page).toHaveURL(/#\/scan$/);
});
