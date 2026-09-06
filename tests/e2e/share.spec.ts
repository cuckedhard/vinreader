import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { encodePayload } from "../../src/lib/payload/codec";
import { isShareableFile, sharedFile } from "../../src/features/sheet/shareFile";

/**
 * The Share button, through the browser, with `navigator.share` stubbed.
 *
 * Why a stub: Web Share is not implemented in Chromium on Linux at all, so `navigator.share`
 * is `undefined` here and the screen shows §6.4's "Sharing isn't available here." instead of
 * the button. The stub is the only way this gate can see the button's own code path. What it
 * cannot see is the browser process behind it — the allowlists that produced the Android
 * report live there, and no headless run reaches them. Their rule is pinned in
 * `src/features/sheet/shareFile.test.ts` against Chromium's own source, and the tap itself
 * stays §7 item 4's to verify on a real device (§13.7).
 */

const VIN = "1HGCM82633A004352";

const PAYLOAD = encodePayload({
  v: 1,
  vin: VIN,
  y: "2003",
  mk: "HONDA",
  md: "Accord",
  bc: "Sedan/Saloon",
  u: "UNIT-42",
  n: "Rear light out",
});

interface SharedFile {
  name: string;
  type: string;
  text: string;
}

interface Shared {
  text?: string;
  title?: string;
  url?: string;
  files: SharedFile[];
}

interface ShareStub {
  /**
   * What `navigator.canShare` answers — or `"absent"` for a browser that has `share` and
   * not `canShare`, which is the only thing that predicate legitimately reports (SH-2).
   */
  canShare: boolean | "absent";
}

interface ShareWindow {
  __shares: Shared[];
  __canShareFiles: number;
  __shareRejection: { name: string; message: string } | null;
}

/**
 * Records every `ShareData` the page hands to `navigator.share`, resolving unless a test has
 * armed a rejection (SH-3 uses that half).
 */
async function stubShare(page: Page, options: ShareStub): Promise<void> {
  await page.addInitScript((opts: ShareStub) => {
    const w = window as unknown as ShareWindow;
    w.__shares = [];
    w.__canShareFiles = 0;
    w.__shareRejection = null;

    if (opts.canShare !== "absent") {
      Object.defineProperty(navigator, "canShare", {
        configurable: true,
        // Chromium's own `canShare` never looks at a file's type: `CanShareInternal` only
        // checks that some known field is present and that any `url` parses (SH-2). This
        // stub answers the same way — one fixed answer, whatever the file is.
        value: (data: ShareData) => {
          w.__canShareFiles += (data.files ?? []).length;
          return opts.canShare === true;
        },
      });
    }

    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data: ShareData): Promise<void> => {
        const files = await Promise.all(
          (data.files ?? []).map(async (file) => ({
            name: file.name,
            type: file.type,
            text: await file.text(),
          })),
        );
        w.__shares.push({ text: data.text, title: data.title, url: data.url, files });
        const rejection = w.__shareRejection;
        if (rejection !== null) throw new DOMException(rejection.message, rejection.name);
      },
    });
  }, options);
}

/** Import the fixture record and land on its sheet, the way every other handoff test does. */
async function openSheet(page: Page): Promise<void> {
  await page.goto(`/#/i?d=${PAYLOAD}`);
  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));
}

async function shares(page: Page): Promise<Shared[]> {
  return page.evaluate(() => (window as unknown as ShareWindow).__shares);
}

/**
 * The tap hands `navigator.share` its data and does not wait for it, and the stub reads each
 * attached file before it records the call, so the record lands a microtask or two after the
 * click returns. Poll rather than sleep.
 */
async function firstShare(page: Page): Promise<Shared> {
  await expect.poll(async () => (await shares(page)).length).toBe(1);
  return (await shares(page))[0];
}

test.describe("SH-1: the file Share attaches is one the browser will carry", () => {
  test("sends the record as text/plain, which clears both Chromium allowlists", async ({
    page,
  }) => {
    await stubShare(page, { canShare: true });
    await openSheet(page);

    await page.getByRole("button", { name: /^share$/i }).click();

    const shared = await firstShare(page);
    expect(shared.files).toHaveLength(1);
    // `application/json` and `.json` are what Chromium refuses (PERMITTED_MIME_TYPES has
    // `application/pdf` and no other `application/*`; PERMITTED_EXTENSIONS has no `json`),
    // and refusing either half fails the whole share with NotAllowedError.
    expect(shared.files[0].type).toBe("text/plain");
    expect(shared.files[0].name).toBe(`vin-relay-${VIN}.txt`);

    // Same bytes as Download JSON: the container changed, the record did not. Notes and unit
    // are the fields §4.9's share text cannot carry back in machine-readable form, so they
    // are what the attachment is *for*.
    const record = JSON.parse(shared.files[0].text);
    expect(record.vin).toBe(VIN);
    expect(record.unit).toBe("UNIT-42");
    expect(record.notes).toBe("Rear light out");

    // §4.9: the readable text always goes, with the file alongside it.
    expect(shared.text).toContain(`VIN 1HG CM826 3 3 A 004352`);

    // §6.4's failure line is not shown when nothing failed.
    await expect(page.getByText("Sharing didn't finish.")).toHaveCount(0);
  });

  test("sends a file this app's own import screen can open", async ({ page }) => {
    await stubShare(page, { canShare: true });
    await openSheet(page);
    await page.getByRole("button", { name: /^share$/i }).click();
    const shared = await firstShare(page);

    // The receiver's half of §4.9: the same file, arriving as the attachment a message app
    // would hand over. `readFile` parses what it is given rather than trusting the name or
    // the type — and the picker's own filter now admits it (SH-1, ImportScreen).
    await page.goto("/#/i");
    await page.locator('input[type="file"]').setInputFiles({
      name: shared.files[0].name,
      mimeType: shared.files[0].type,
      buffer: Buffer.from(shared.files[0].text),
    });

    await expect(page.getByRole("heading", { level: 2 })).toContainText("1HG CM826 3 3 A 004352");
    await page.getByRole("button", { name: /^import$/i }).click();
    await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));
    await expect(page.getByRole("textbox", { name: "Notes" })).toHaveValue("Rear light out");
  });

  test("keeps Download JSON on .json, where nothing inspects it", async ({ page }) => {
    await stubShare(page, { canShare: true });
    await openSheet(page);

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: /download json/i }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`vin-relay-${VIN}.json`);
  });
});

/**
 * SH-2. `canShare` reports one thing — whether this browser does file sharing at all — and the
 * code was reading it as though it reported another. Both halves are asserted here: the answer
 * it can give is obeyed, and the file that goes when it says yes is one the app has checked
 * against Chromium's lists itself.
 */
test.describe("SH-2: what canShare is allowed to decide", () => {
  test("sends no file when the browser says it does not do files", async ({ page }) => {
    await stubShare(page, { canShare: false });
    await openSheet(page);

    await page.getByRole("button", { name: /^share$/i }).click();

    const shared = await firstShare(page);
    expect(shared.files).toHaveLength(0);
    // §4.9: the readable text always goes. Losing the file never blocks the share.
    expect(shared.text).toContain("VIN 1HG CM826 3 3 A 004352");
    await expect(page.getByText("Sharing didn't finish.")).toHaveCount(0);
  });

  test("sends no file when the browser has no canShare at all", async ({ page }) => {
    await stubShare(page, { canShare: "absent" });
    await openSheet(page);

    await page.getByRole("button", { name: /^share$/i }).click();

    const shared = await firstShare(page);
    expect(shared.files).toHaveLength(0);
    expect(shared.text).toContain("VIN 1HG CM826 3 3 A 004352");
  });

  test("sends a file the app has itself checked, not one canShare waved through", async ({
    page,
  }) => {
    await stubShare(page, { canShare: true });
    await openSheet(page);

    await page.getByRole("button", { name: /^share$/i }).click();

    const shared = await firstShare(page);
    // The app's own rule, run over the file that actually left the page. This is the
    // assertion `canShare` could never have made: it returns `true` for anything.
    expect(isShareableFile(shared.files[0])).toBe(true);
  });
});

/**
 * SH-3. Chromium reports a cancel and three separate internal failures through one exception
 * name, so the handler that returned on every `AbortError` discarded all of them. Each of the
 * four is armed here in turn, through a stub that rejects exactly as `navigator_share.cc`
 * does, and the screen is asked what it said about it.
 */
async function armRejection(page: Page, name: string, message: string): Promise<void> {
  await page.evaluate(
    ([n, m]) => {
      (window as unknown as ShareWindow).__shareRejection = { name: n, message: m };
    },
    [name, message],
  );
}

const SHARE_FAILED = "Sharing didn't finish. Copy or download instead.";

test.describe("SH-3: a failure is reported and a cancel is not", () => {
  test("says nothing when the user backs out of the system sheet", async ({ page }) => {
    await stubShare(page, { canShare: true });
    await openSheet(page);
    await armRejection(page, "AbortError", "Share canceled");

    await page.getByRole("button", { name: /^share$/i }).click();
    await firstShare(page);

    // Nothing was lost and nothing was chosen wrongly: the screen stays as it was.
    await expect(page.getByText(SHARE_FAILED)).toHaveCount(0);
  });

  for (const [label, name, message] of [
    // ShareError::INTERNAL_ERROR — no window or activity, a temp file that could not be
    // created, a blob that could not be read.
    ["an internal error", "AbortError", "Share failed"],
    // ShareClientImpl::OnConnectionError — the Mojo pipe to the browser process went away.
    [
      "a dropped connection",
      "AbortError",
      "Internal error: could not connect to Web Share interface.",
    ],
    // What SH-1's file produced on every tap, and what the user reported.
    ["a refused share", "NotAllowedError", "Permission denied"],
  ] as const) {
    test(`reports ${label}, with the engine's own words under §6.4's line`, async ({ page }) => {
      await stubShare(page, { canShare: true });
      await openSheet(page);
      await armRejection(page, name, message);

      await page.getByRole("button", { name: /^share$/i }).click();

      const banner = page.getByRole("alert").filter({ hasText: SHARE_FAILED });
      await expect(banner).toBeVisible();
      // The detail is what a user can read back over a phone — the only thing that separates
      // these three on a device nobody in this loop is holding.
      await expect(banner).toContainText(`${name}: ${message}`);
    });
  }

  test("clears the last failure when Share is tapped again", async ({ page }) => {
    await stubShare(page, { canShare: true });
    await openSheet(page);
    await armRejection(page, "AbortError", "Share failed");
    await page.getByRole("button", { name: /^share$/i }).click();
    await expect(page.getByText(SHARE_FAILED)).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as ShareWindow).__shareRejection = null;
    });
    await page.getByRole("button", { name: /^share$/i }).click();
    await expect(page.getByText(SHARE_FAILED)).toHaveCount(0);
  });
});

/**
 * SH-4. A failure that is reported below the fold is still a failure nobody was told about.
 *
 * §6.2 puts Share at the top of the handoff section and the banner after the six copy
 * buttons, the row hint and the QR note — on a phone that is several hundred pixels down a
 * sheet the user is not scrolled to, so the tap that fails changes nothing they can see. Same
 * class as F7, F8 and R3-F1, and the same fix those established: scroll the notice to where it
 * can be read, `block: "nearest"` so a screen tall enough to hold it does not move at all.
 *
 * Measured, not read off a class name (§6.1): the box against `main`'s scroll clip, and what
 * `elementFromPoint` returns at its centre.
 */
interface FoldMeasurement {
  message: string;
  bannerVisible: number;
  bannerHeight: number;
  bannerReachable: boolean;
  shareVisible: number;
  scroll: { top: number; client: number; height: number };
}

async function measureFold(page: Page): Promise<FoldMeasurement> {
  return page.evaluate((failed: string) => {
    const main = document.querySelector("main");
    const banner = Array.from(document.querySelectorAll("[role=alert]")).find((node) =>
      (node.textContent ?? "").includes(failed),
    );
    const share = Array.from(document.querySelectorAll("button")).find(
      (node) => (node.textContent ?? "").trim() === "Share",
    );
    if (!(main instanceof HTMLElement) || !(banner instanceof HTMLElement)) {
      throw new Error("no sheet, or no failure banner on it");
    }
    if (share === undefined) throw new Error("no Share button");
    const fold = main.getBoundingClientRect();
    const visibleIn = (el: Element) => {
      const box = el.getBoundingClientRect();
      return Math.round(
        Math.max(0, Math.min(box.bottom, fold.bottom) - Math.max(box.top, fold.top)),
      );
    };
    const box = banner.getBoundingClientRect();
    const under = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      message: banner.textContent ?? "",
      bannerVisible: visibleIn(banner),
      bannerHeight: Math.round(box.height),
      bannerReachable: under !== null && banner.contains(under),
      shareVisible: visibleIn(share),
      scroll: {
        top: Math.round(main.scrollTop),
        client: Math.round(main.clientHeight),
        height: Math.round(main.scrollHeight),
      },
    };
  }, SHARE_FAILED);
}

test.describe("SH-4: the failure is where it can be read", () => {
  for (const [label, width, height] of [
    ["a phone", 390, 844],
    ["§6.1's floor of a phone", 360, 640],
  ] as const) {
    test(`shows the whole banner on ${label}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await stubShare(page, { canShare: true });
      await openSheet(page);
      await armRejection(page, "AbortError", "Share failed");

      await page.getByRole("button", { name: /^share$/i }).click();
      await expect(page.getByRole("alert").filter({ hasText: SHARE_FAILED })).toBeVisible();

      const seen = await measureFold(page);
      // The whole banner, not a sliver: it carries §6.4's sentence and the engine's line
      // under it, and a user who can read neither has been told nothing at all (P7).
      expect(seen.bannerVisible, JSON.stringify(seen)).toBe(seen.bannerHeight);
      expect(seen.bannerReachable, JSON.stringify(seen)).toBe(true);
      expect(seen.message).toContain("AbortError: Share failed");
    });
  }
});

/**
 * SH-5. SH-1 changed the attachment to `.txt` / `text/plain` because Chromium refuses
 * `application/json` — and the Import screen went on asking, in its own words, for "a .json
 * file". So the app told a receiver that the file the app had just sent them was the wrong
 * kind. The picker admits it and `readFile` parses by content, so it always imported; only the
 * words were wrong.
 *
 * The shape the app sends is read off `sharedFile` here rather than typed in, so the question
 * stays the right one if Share's container ever changes again: whatever leaves by Share, the
 * screen that receives it must not name a different shape at the person holding the phone. And
 * Download JSON still writes a real `.json`, so the copy has to cover both without reciting
 * extensions.
 */
test.describe("SH-5: the Import screen does not name the wrong file", () => {
  test("asks for no file shape but the one Share actually sends", async ({ page }) => {
    await page.goto("/#/i");

    // The button the receiver taps, holding the file the app sent them.
    await expect(page.getByRole("button", { name: /^choose a file$/i })).toBeVisible();

    const words = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    const name = sharedFile(VIN).name;
    const sent = name.slice(name.lastIndexOf(".")).toLowerCase();
    // Every file extension this screen says out loud. Naming one is not wrong in itself —
    // naming one the app's own Share does not produce is what turned the receiver away.
    const named = (words.match(/\.[A-Za-z0-9]{2,5}\b/g) ?? []).filter(
      (ext) => ext.toLowerCase() !== sent,
    );
    expect(named, words).toEqual([]);
  });
});
