import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

/**
 * §9-S3 phone-to-phone: "show QR, scan QR". The receiving phone must reach the import
 * preview, never a silently confirmed VIN. The app's own QR decodes identically every
 * frame, so without the carrier check ahead of extractVin the two-read rule would confirm
 * a VIN fabricated out of the base64url body (D14) — measured at roughly one payload in
 * ten during the pre-build review.
 */
test.use({
  launchOptions: {
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${resolve(process.cwd(), "bench/fake-qr.y4m")}`,
    ],
  },
});

test("routes a scanned payload QR to the import preview", async ({ page }) => {
  await page.goto("/#/scan");

  await expect(page).toHaveURL(/#\/i\?d=/, { timeout: 20_000 });
  await expect(page.getByText("1HG CM826 3 3 A 004352")).toBeVisible();
  await expect(page.getByRole("button", { name: /^import$/i })).toBeVisible();

  // The scan itself wrote nothing: the preview is a decision, not a side effect.
  await page.getByRole("link", { name: "History" }).click();
  await expect(page.getByText("1HG CM826 3 3 A 004352")).toHaveCount(0);
});
