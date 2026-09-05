import { expect, test } from "@playwright/test";

/**
 * [F7] §6.4's escape routes out of a camera error must be on the screen, not below it.
 *
 * §6.4 puts Retry and then "Type VIN instead" under a notice that can be retried, §6.1
 * floors them at 56 px and 48 px, and N1/P1 says a scan is never blocked — a user who
 * cannot see the keyboard fallback is blocked as surely as one whose camera is dead.
 *
 * The defect this pins: `CameraView` hid the preview only in `confirmed`, so in every
 * error state a dead `aspect-[3/4] max-h-[60vh]` black box still took the fold and pushed
 * the notice and both buttons past it. Measured on the two Android profiles this project's
 * own gate runs (`bun run test:e2e:android`): at 320×658 both buttons had 0 of their 56 /
 * 48 px inside `main`, and `document.elementFromPoint` at their centres returned the
 * bottom nav — a tap aimed at the fallback navigated away instead.
 *
 * The measurement is against `main`'s client rect rather than against `toBeVisible`,
 * because a control scrolled past the fold *is* visible to Playwright: it scrolls it into
 * view before it looks. Nothing here scrolls.
 */

/** The bottom-nav links the mistapped buttons used to hit. */
const NAV = ["Scan", "History", "Settings"];

interface Measured {
  height: number;
  visible: number;
  hit: string | null;
  hitsSelf: boolean;
}

async function measure(page: import("@playwright/test").Page, label: string): Promise<Measured> {
  return page.evaluate((name) => {
    const main = document.querySelector("main");
    if (!main) throw new Error("no <main>");
    const view = main.getBoundingClientRect();
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim().toLowerCase() === name.toLowerCase(),
    );
    if (!button) throw new Error(`no button "${name}"`);
    const box = button.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      height: box.height,
      visible: Math.max(0, Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top)),
      hit: hit?.textContent?.trim() ?? null,
      hitsSelf: button === hit || button.contains(hit),
    };
  }, label);
}

/** How much of the §6.4 notice itself is inside the fold. */
async function measureNotice(page: import("@playwright/test").Page): Promise<Measured> {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    const alert = document.querySelector('[role="alert"]');
    if (!main || !alert) throw new Error("no <main> or no notice");
    const view = main.getBoundingClientRect();
    const box = alert.getBoundingClientRect();
    return {
      height: box.height,
      visible: Math.max(0, Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top)),
      hit: null,
      hitsSelf: true,
    };
  });
}

/** Both §6.4 routes, whole and tappable, at the size §6.1 gives them. */
async function expectBothRoutesUsable(page: import("@playwright/test").Page): Promise<void> {
  // The notice says which of the two routes is the one that will work, so a clipped notice
  // is the same failure one step earlier (§6.4).
  const notice = await measureNotice(page);
  expect(notice.visible).toBeCloseTo(notice.height, 1);

  const retry = await measure(page, "Retry");
  expect(retry.height).toBeGreaterThanOrEqual(56);
  expect(retry.visible).toBeCloseTo(retry.height, 1);
  expect(retry.hitsSelf).toBe(true);
  expect(NAV).not.toContain(retry.hit);

  const typed = await measure(page, "Type VIN instead");
  expect(typed.height).toBeGreaterThanOrEqual(48);
  expect(typed.visible).toBeCloseTo(typed.height, 1);
  expect(typed.hitsSelf).toBe(true);
  expect(NAV).not.toContain(typed.hit);
}

/** §6.3's `permission_denied`: the browser has the camera and refuses it to this origin. */
async function denyCamera(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    const devices = navigator.mediaDevices;
    if (!devices) return;
    devices.getUserMedia = () =>
      Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
  });
}

/**
 * The two Android profiles `playwright.config.ts` declares, run here under the gate's own
 * `desktop` project so the guard is inside `bun run test:e2e` rather than beside it. The
 * viewport is the whole measurement; the user agent is not.
 */
const PHONES = [
  { name: "Galaxy S9+ 320x658", viewport: { width: 320, height: 658 } },
  { name: "Pixel 7 412x839", viewport: { width: 412, height: 839 } },
  { name: "iPhone-class 390x844", viewport: { width: 390, height: 844 } },
];

for (const phone of PHONES) {
  test.describe(phone.name, () => {
    test.use({ viewport: phone.viewport });

    test(`[F7] permission_denied keeps Retry and Type VIN instead on screen`, async ({ page }) => {
      await denyCamera(page);
      await page.goto("/#/scan");
      await expect(page.getByText(/camera is blocked/i)).toBeVisible();
      await expectBothRoutesUsable(page);
    });

    test(`[F7] no_camera keeps Retry and Type VIN instead on screen`, async ({ page }) => {
      // Headless Chromium without the fake-device flags has no camera at all, which is
      // exactly the state §6.4 calls "No camera is available on this device."
      await page.goto("/#/scan");
      await expect(page.getByText(/no camera is available/i)).toBeVisible();
      await expectBothRoutesUsable(page);
    });
  });
}
