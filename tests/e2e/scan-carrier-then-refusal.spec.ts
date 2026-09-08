import { expect, test } from "@playwright/test";
import { writeQrY4m } from "./qr-video";

/**
 * [FR-4] The mirror of FR-3: a §4.9 carrier's rejection must not outlive the code it
 * describes either.
 *
 * FR-3 fixed the direction it was filed for — a refusal ends when one of the app's own codes
 * takes the frame — and this direction survived it, because the two banners are held in
 * different places. `refusal` is the machine's and the `carrier` action clears it;
 * `carrierError` is `ScanScreen`'s own `useState`, and the only thing that took it down was
 * `showCarrier`'s `candidate`/`confirmed` guard — so an agreed refusal, which leaves the
 * machine `streaming` (N1), fired nothing. A phone pointed at a VIN Relay code it cannot read
 * and then at a sticker §4.2 refuses therefore carried both banners at once, each with its own
 * "Keep scanning", the first about a code that had left the frame: a notice describing
 * something that is not there (N2), competing with the notice that is actually asking the user
 * something (P7).
 *
 * The video is `scan-carrier-stale.spec.ts`'s, with what follows the carrier changed from a
 * VIN §4.3 holds to a read §4.2 refuses — the two reads that *stay* on this screen, because a
 * saved VIN leaves for the sheet and a readable carrier leaves for Import. Its own spec file
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

const Y4M = writeQrY4m("carrier-then-not-a-vin", [
  // A second and a half of the carrier — one frame is enough for §6.4's rejection, because a
  // §4.9 payload identifies itself — and then fifteen of the component label. The ledger's
  // repro is the first 345 frames of this; the rest is headroom for the dismissal step at the
  // end, which has to happen while the label is still the thing in front of the camera:
  // Chromium loops the file, and a carrier back in the frame raises its banner again for the
  // right reason.
  [`https://vinrelay.example/#/i?d=${BODY}`, 45],
  [PART_NUMBER, 450],
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

test("[FR-4] a carrier's rejection does not outlive the code a refusal replaced", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/scan");

  // §6.4: one of the app's own codes, whose version this app does not read. The camera keeps
  // running for it (N1) — which is exactly why the next code lands underneath it.
  await expect(page.getByText("Couldn't read that code")).toBeVisible({ timeout: 20_000 });

  // The next thing the camera sees decodes cleanly and is not a VIN: §6.4's "Not a VIN yet",
  // with what was read and why (FR-2).
  await expect(page.getByText(PART_NUMBER)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Not a VIN yet")).toBeVisible();

  // One banner, about the code in front of the camera.
  await expect(
    page.getByText("Couldn't read that code"),
    "N2/P7: the carrier's rejection outlived the code it was about",
  ).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(1);
  // The sharpest form of the finding: two banners meant two "Keep scanning" buttons, and one
  // of them answered a read that was no longer on the screen it was answering for.
  await expect(page.getByRole("button", { name: "Keep scanning" })).toHaveCount(1);

  // N1: nothing here stopped the stream. The camera is still running, still says where to
  // point it, and still offers the keyboard.
  await expect(page.getByText("Point at the barcode on the door-jamb sticker.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Type VIN instead" })).toBeVisible();
  await expect(page).toHaveURL(/#\/scan$/);

  // And answering the refusal must not put the carrier's rejection back. This is the half that
  // pins *what* the suppression is keyed on: the refusal the machine holds, not the banner on
  // screen. "Keep scanning" says "I have read this", not "the code I read is back in the
  // frame" — so a suppression keyed on `showRefusal` would resurrect a notice about a code two
  // codes ago the moment the user answered the one that replaced it (R3-F5, N2, P7).
  await page.getByRole("button", { name: "Keep scanning" }).click();
  await expect(
    page.getByRole("alert"),
    "R3-F5/P7: answering the refusal put the carrier's rejection back on screen",
  ).toHaveCount(0);
});
