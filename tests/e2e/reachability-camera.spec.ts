import { expect, test } from "@playwright/test";
import { writeQrY4m } from "./qr-video";

/**
 * [RCH-5] R3-F1's own shape, held to the rule `reachability.spec.ts` states.
 *
 * An alert that opens **while the camera is streaming** — the machine stays `streaming` for
 * a refused §4.9 carrier, so the preview keeps its full height and the banner grows under
 * it. The ledger measured that banner at **0 visible pixels** at 360×640 with "Keep
 * scanning" 110 px below the fold, and `scan-carrier-version.spec.ts` passed anyway because
 * Playwright's `isVisible()` ignores the scroll clip. This measures the clip.
 *
 * It is a file of its own because the fake camera is a *launch* flag: Playwright refuses
 * `test.use({ launchOptions })` inside a describe, and hoisting it into the main file would
 * hand every other test a live camera it does not want. Same rule, same measurement, same
 * `clippedNow` logic — restated here rather than exported, because the two files run in
 * different workers and the shared piece is eight lines of geometry.
 */

/** A §4.9 URL carrier whose payload declares version 2 — the one P6 refuses by name. */
const CARRIER_V2 = (() => {
  const body = Buffer.from(
    JSON.stringify({ v: 2, vin: "1HGCM82633A004352", mk: "HONDA", md: "Accord" }),
    "utf8",
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `https://vinrelay.example/#/i?d=${body}`;
})();

const CARRIER_Y4M = writeQrY4m("rch-carrier-v2", [[CARRIER_V2, 8]]);

test.use({
  launchOptions: {
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${CARRIER_Y4M}`,
    ],
  },
});

/** 390×844 is §6.1's phone; 320×658 is the Galaxy S9+ profile `test:e2e:android` runs. */
const PHONES = [
  { name: "390x844", viewport: { width: 390, height: 844 } },
  { name: "320x658 Galaxy S9+", viewport: { width: 320, height: 658 } },
];

const CONTROLS =
  'a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';

for (const phone of PHONES) {
  test.describe(phone.name, () => {
    test.use({ viewport: phone.viewport });

    test("[RCH-5] an alert raised by the live camera lands in the clip", async ({ page }) => {
      await page.goto("/#/scan");
      await expect(page.getByRole("alert")).toBeAttached({ timeout: 20_000 });
      await page.waitForTimeout(600);

      const clipped = await page.evaluate((selector) => {
        function scroller(el: Element): Element {
          let node: Element | null = el.parentElement;
          while (node !== null && node !== document.body) {
            const style = getComputedStyle(node);
            if (
              /(auto|scroll)/.test(style.overflowY) &&
              node.scrollHeight > node.clientHeight + 1
            ) {
              return node;
            }
            node = node.parentElement;
          }
          return document.scrollingElement ?? document.documentElement;
        }
        function say(el: Element): string {
          return (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 44);
        }

        const bad: string[] = [];
        for (const region of document.querySelectorAll('[role="alert"]')) {
          for (const el of [region, ...region.querySelectorAll(selector)]) {
            const box = el.getBoundingClientRect();
            if (box.width === 0 || box.height === 0) continue;
            const clip = scroller(el).getBoundingClientRect();
            const top = Math.max(clip.top, 0);
            const bottom = Math.min(clip.bottom, window.innerHeight);
            const visible = Math.max(0, Math.min(box.bottom, bottom) - Math.max(box.top, top));
            const cy = (Math.max(box.top, top) + Math.min(box.bottom, bottom)) / 2;
            const hit =
              visible > 0 ? document.elementFromPoint(box.left + box.width / 2, cy) : null;
            const hitsSelf = hit !== null && (hit === el || el.contains(hit));
            if (visible >= box.height - 0.5 && hitsSelf) continue;
            bad.push(
              `"${say(el)}": ${Math.round(visible)} of ${Math.round(box.height)} px inside ` +
                `the clip, a tap there hits ${hit === null ? "nothing" : `"${say(hit)}"`}`,
            );
          }
        }
        return bad;
      }, CONTROLS);

      expect(clipped, "the refused carrier's banner is outside the scroll clip").toEqual([]);
    });
  });
}
