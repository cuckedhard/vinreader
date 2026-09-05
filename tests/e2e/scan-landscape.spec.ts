import { expect, test } from "@playwright/test";

/**
 * [F11] §6.1: "Portrait and landscape both work." In landscape it did not.
 *
 * The scan column is `max-w-md` and the preview is `aspect-[3/4] max-h-[60vh]`, both written
 * for a phone held upright. Turned sideways the preview rendered 414×234 with wide empty
 * margins on either side and the rest of the column ran past the fold: at 844×390 "Type VIN
 * instead" had **0 of its 48 px** inside `main` and a tap at its centre landed on the bottom
 * nav, and §6.4's aiming line was clipped to 27 of 49.5 px. At 640×360 the same button was
 * 0 px and the line 15 of 49.5. `main` scrolls (460 vs 341, 442 vs 311) but nothing on
 * screen says so, and N1/P1 make the keyboard fallback the one control that must never be
 * unreachable — least of all while the camera is running fine.
 *
 * This is F7's measurement in F7's shape, aimed at `streaming` rather than at the error
 * states: the same `main`-relative arithmetic, the same `elementFromPoint` hit test, and
 * nothing that scrolls. Playwright's `toBeVisible` cannot see this defect, because it
 * scrolls a control into view before it looks.
 *
 * The camera is Chromium's fake device with **no** file behind it, so the stream is live and
 * carries no barcode: the machine sits in `streaming` and the §6.3 aiming state stays put
 * for the length of the measurement.
 */

test.use({
  launchOptions: {
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

/** The bottom-nav links a mistapped fallback used to hit. */
const NAV = ["Scan", "History", "Settings"];

/** §6.4's aiming line, verbatim — the status line that was being clipped. */
const AIMING = "Point at the barcode on the door-jamb sticker.";

interface Measured {
  height: number;
  visible: number;
  hit: string | null;
  hitsSelf: boolean;
}

/** How much of an element is inside `main`'s client rect, and what a tap at its centre hits. */
async function measure(
  page: import("@playwright/test").Page,
  find: "button" | "status",
  label: string,
): Promise<Measured> {
  return page.evaluate(
    ({ find: kind, label: name }) => {
      const main = document.querySelector("main");
      if (!main) throw new Error("no <main>");
      const view = main.getBoundingClientRect();
      const target =
        kind === "button"
          ? [...document.querySelectorAll("button")].find(
              (candidate) => candidate.textContent?.trim() === name,
            )
          : [...document.querySelectorAll("p")].find(
              (candidate) => candidate.textContent?.trim() === name,
            );
      if (!target) throw new Error(`no ${kind} "${name}"`);
      const box = target.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        height: box.height,
        visible: Math.max(0, Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top)),
        hit: hit?.textContent?.trim() ?? null,
        hitsSelf: target === hit || target.contains(hit),
      };
    },
    { find, label },
  );
}

/** The two landscape shapes F11 measured: a modern phone turned, and the narrowest one. */
const SIDEWAYS = [
  { name: "phone in landscape 844x390", viewport: { width: 844, height: 390 } },
  { name: "small phone in landscape 640x360", viewport: { width: 640, height: 360 } },
];

for (const shape of SIDEWAYS) {
  test.describe(shape.name, () => {
    test.use({ viewport: shape.viewport });

    test("[F11] the keyboard fallback and the aiming line are on screen while streaming", async ({
      page,
    }) => {
      await page.goto("/#/scan");
      // The §6.3 streaming state, which is the one with a live preview and no error.
      await expect(page.getByText(AIMING)).toBeVisible();

      const aiming = await measure(page, "status", AIMING);
      expect(aiming.visible).toBeCloseTo(aiming.height, 1);

      const typed = await measure(page, "button", "Type VIN instead");
      expect(typed.height).toBeGreaterThanOrEqual(48);
      expect(typed.visible).toBeCloseTo(typed.height, 1);
      expect(typed.hitsSelf).toBe(true);
      expect(NAV).not.toContain(typed.hit);
    });

    test("[F11] the preview is still there, and still the shape of a label", async ({ page }) => {
      await page.goto("/#/scan");
      await expect(page.getByText(AIMING)).toBeVisible();

      const preview = await page.evaluate(() => {
        const video = document.querySelector("video");
        const main = document.querySelector("main");
        if (!video || !main) throw new Error("no preview");
        const box = video.getBoundingClientRect();
        const view = main.getBoundingClientRect();
        return {
          width: box.width,
          height: box.height,
          visible: Math.max(0, Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top)),
        };
      });

      // Whole, and big enough to aim with: a fix that buys the fallback back by shrinking
      // the camera to nothing would pass the test above and fail the user (§9-S1, §11).
      expect(preview.visible).toBeCloseTo(preview.height, 1);
      expect(preview.height).toBeGreaterThanOrEqual(150);
      // Wider than the portrait column would have allowed: the landscape width the finding
      // measured as empty margin is where the preview now is.
      expect(preview.width).toBeGreaterThanOrEqual(280);
    });
  });
}
