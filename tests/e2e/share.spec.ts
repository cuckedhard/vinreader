import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { encodePayload } from "../../src/lib/payload/codec";
import { isShareableFile } from "../../src/features/sheet/shareFile";

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
