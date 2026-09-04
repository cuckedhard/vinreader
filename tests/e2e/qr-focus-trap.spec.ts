import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { encodePayload } from "../../src/lib/payload/codec";

/**
 * §6.6: "Everything is keyboard-reachable: Tab / Enter / Escape, visible focus ring."
 *
 * The QR overlay is the one screen in this app that covers another screen, and it is the one
 * the user holds up for someone else to scan. Focus leaving it is not cosmetic. Measured
 * before the fix, from the Close button: Tab reached **Scan, History, Settings** in the bottom
 * nav, then the browser's own UI, then wrapped around into the sheet underneath at **Refresh
 * details** and the unit field; Shift+Tab reached **Copy JSON** and **Refresh details** — 11 of
 * 12 presses landed on a control the user could not see, and a screen reader followed them
 * off the code and into a form behind it.
 *
 * These assertions live in the e2e suite because none of this is observable anywhere else:
 * vitest runs in the `node` environment with no DOM, and sequential focus navigation, a modal
 * dialog's focus scope and the inertness of the content behind it are all engine behaviour.
 *
 * They assert the property, not the mechanism — "nothing behind the overlay can take focus" —
 * so the trap can be rebuilt a different way without rewriting the test. Note what the
 * property deliberately allows: a stop where *nothing in the page* is focused. That is the
 * keyboard in the browser's own UI (address bar, tab strip), which every native modal permits
 * and no page should take away. What it forbids is landing on an element behind the overlay.
 */

const VIN = "1HGCM82633A004352";

const PAYLOAD = encodePayload({
  v: 1,
  vin: VIN,
  y: "2003",
  mk: "HONDA",
  md: "Accord",
  u: "UNIT-42",
});

/** Matches the overlay however it is built: a native `<dialog>` or a div carrying the role. */
const OVERLAY = 'dialog, [role="dialog"]';

interface FocusState {
  /** `document.activeElement` is the overlay or inside it. */
  inside: boolean;
  /** Nothing in the page holds focus — the keyboard is in the browser's own UI. */
  browserUi: boolean;
  /** What the keyboard actually reached, so a failure names the control it escaped to. */
  name: string;
}

async function focusState(page: Page): Promise<FocusState> {
  return page.evaluate((overlay) => {
    const el = document.activeElement;
    if (el === null || el === document.body || el === document.documentElement) {
      return { inside: false, browserUi: true, name: "nothing in the page" };
    }
    const label = (el.getAttribute("aria-label") ?? el.textContent ?? "")
      .trim()
      .replaceAll(/\s+/g, " ")
      .slice(0, 40);
    return {
      inside: el.closest(overlay) !== null,
      browserUi: false,
      name: `${el.tagName.toLowerCase()}${label === "" ? "" : ` "${label}"`}`,
    };
  }, OVERLAY);
}

/** Import a record, land on its sheet, and open the QR overlay from the button that owns it. */
async function openQr(page: Page) {
  await page.goto(`/#/i?d=${PAYLOAD}`);
  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));

  await page.getByRole("button", { name: /qr code/i }).click();
  await expect(page.locator(OVERLAY)).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible();
}

test("Tab cycles inside the QR overlay instead of walking into the sheet behind it", async ({
  page,
}) => {
  await openQr(page);

  // Opening it has to move the keyboard into it, or the first Tab starts from the sheet.
  expect(await focusState(page)).toMatchObject({ inside: true });

  // More presses in each direction than the overlay has controls: this passes only if focus
  // comes back round, so "focus fell out and stayed out" fails here too.
  const trail: FocusState[] = [];
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("Tab");
    trail.push(await focusState(page));
  }
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("Shift+Tab");
    trail.push(await focusState(page));
  }

  const behind = trail.filter((state) => !state.inside && !state.browserUi).map((s) => s.name);
  expect(behind).toEqual([]);
  // Both directions return into the overlay rather than parking outside it.
  expect(trail.filter((state) => state.inside).length).toBeGreaterThanOrEqual(2);
});

test("nothing behind the QR overlay can take focus while it is up", async ({ page }) => {
  await openQr(page);

  // Inert, not merely covered: a control that is only painted over is still a control for a
  // screen reader, for a stylus that lands outside the code, and for anything that calls
  // focus() — which is exactly what a modal makes impossible.
  const outside = await page.evaluate((overlay) => {
    const candidates = [
      ...document.querySelectorAll<HTMLElement>("button, a[href], input, textarea, select"),
    ].filter((el) => el.closest(overlay) === null);
    const tookFocus: string[] = [];
    for (const el of candidates) {
      el.focus();
      if (document.activeElement === el) {
        tookFocus.push(
          `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 24)}"`,
        );
      }
    }
    return { count: candidates.length, tookFocus };
  }, OVERLAY);

  // The sheet and the bottom nav are still in the DOM behind the code — if they were not,
  // this test would be asserting nothing.
  expect(outside.count).toBeGreaterThan(0);
  expect(outside.tookFocus).toEqual([]);
});

test("Escape closes the QR and hands the keyboard back to the button that opened it", async ({
  page,
}) => {
  await openQr(page);

  await page.keyboard.press("Escape");
  await expect(page.locator(OVERLAY)).toHaveCount(0);

  // §6.6 again: after a close, Tab carries on from where the user was, not from the top of
  // the document. The overlay is unmounted rather than closed in place, so the platform's own
  // focus restoration never runs and the component has to do this itself.
  expect((await focusState(page)).name).toContain("QR code");
});

test("closing with the button hands the keyboard back the same way", async ({ page }) => {
  await openQr(page);

  await page.getByRole("button", { name: /^close$/i }).click();
  await expect(page.locator(OVERLAY)).toHaveCount(0);
  expect((await focusState(page)).name).toContain("QR code");
});
