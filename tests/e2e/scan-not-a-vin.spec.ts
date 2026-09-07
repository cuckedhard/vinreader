import { expect, test } from "@playwright/test";
import { writeQrY4m } from "./qr-video";

/**
 * [FR-2] The camera says what it read and why it is not a VIN.
 *
 * The field report: a DYNACRAFT (a division of PACCAR) component label on a 2013 Kenworth,
 * three Code 128 symbols, one field each, and not the federal certification label. The app
 * refused every one of them — correctly — and said nothing, so the mechanic photographed
 * the sticker and asked a person. The refusal was never the defect; the silence was.
 *
 * The video holds the part number off that sticker. A QR rather than the Code 128 it was
 * printed on, because this behaviour is symbology-independent — §4.2 sees the same
 * eighteen characters either way — and because `writeQrY4m` is the fake camera this suite
 * already has (§7 item 5).
 *
 * What must NOT happen is a strobe: the decode loop runs several times a second, and §6.4
 * rules that garbage keeps the scanner going. §6.3's two-read agreement is what separates
 * a coherent read from noise, and the last assertion here holds the message still for two
 * seconds of continuous decoding to prove it does not flicker — and it observes the banner
 * without auto-waiting, because Playwright's retrying assertions are built to look past
 * exactly the transience it is looking for.
 */

const PART_NUMBER = "R25-1251-200622120";
const WHY = "No 17 characters in a row here — the longest run is 9.";

// Three seconds of it, which Chromium loops for as long as a test keeps the camera open.
// Every frame is the same symbol, so the loop is indistinguishable from a phone held still.
const Y4M = writeQrY4m("not-a-vin", [[PART_NUMBER, 90]]);

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

test("[FR-2] a coherent read that is not a VIN is shown, with the reason", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/scan");

  const notice = page.getByRole("alert");
  await expect(notice).toContainText("Not a VIN yet", { timeout: 20_000 });
  // The string the app had in hand and would not show. This is the whole finding.
  await expect(notice).toContainText(PART_NUMBER);
  await expect(notice).toContainText(WHY);
  // Nothing about what it *is*: the app cannot see a part number or a pallet tag (N2).
  await expect(notice).not.toContainText(/part number/i);
  await expect(notice).not.toContainText(/sticker/i);

  // §6.4's scan states are not buried: the camera is still running and still says where to
  // point it, and the keyboard route is still on screen (N1 — a scan is never blocked).
  await expect(page.getByText("Point at the barcode on the door-jamb sticker.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Type VIN instead" })).toBeVisible();
  // Nothing was saved and nothing navigated.
  await expect(page).toHaveURL(/#\/scan$/);

  // §6.1: the read is set like a VIN, because it is read off the phone like one.
  const style = await notice.getByText(PART_NUMBER).evaluate((el) => {
    const css = getComputedStyle(el);
    return { size: parseFloat(css.fontSize), family: css.fontFamily.toLowerCase() };
  });
  expect(style.size).toBeGreaterThanOrEqual(28);
  expect(style.family).toContain("mono");
});

test("[FR-2] the banner is on screen on the smallest phone in the matrix", async ({ page }) => {
  // R3-F1: the machine stays `streaming` for a refused read, so this banner opens below a
  // full-height preview — and that is exactly how the carrier rejection shipped with 0
  // visible pixels at 360x640 while the camera worked perfectly. This banner is taller
  // still: it carries the read at §6.1's VIN size.
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/#/scan");

  const notice = page.getByRole("alert");
  await expect(notice).toContainText(PART_NUMBER, { timeout: 20_000 });

  const box = await notice.boundingBox();
  const fold = page.viewportSize()?.height ?? 0;
  expect(box).not.toBeNull();
  // Not merely in the DOM: the top of it and the reason under it are both above the fold.
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(fold);
  // And the camera is still streaming behind it (N1/P1) — nothing was stopped to make room.
  await expect(page.getByText("Point at the barcode on the door-jamb sticker.")).toBeVisible();
});

/**
 * What the banner did over an interval, written by a MutationObserver rather than read by
 * a poll — so a mount and an unmount that both fall between two polls are still on the
 * record, and so is one that happens inside a single task.
 */
interface StrobeProbe {
  /** Every *distinct* `count:text` state the alert passed through. Steady means length 1. */
  trace: string[];
  /** Alert elements added to and removed from the document while observing. */
  mounts: number;
  unmounts: number;
  /** The element that was on screen when observing started, kept to see whether it stays. */
  node: Element | null;
}

/** The same, read back into the test, with the node answered rather than shipped. */
type Strobe = Omit<StrobeProbe, "node"> & { connected: boolean };

declare global {
  interface Window {
    __vinStrobe?: StrobeProbe;
  }
}

test("[FR-2] the message holds still while the decoder keeps running", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/scan");

  const alerts = page.locator('[role="alert"]');
  await expect(alerts).toContainText(PART_NUMBER, { timeout: 20_000 });

  /*
   * Everything below observes the banner WITHOUT auto-waiting, and that is the whole
   * instrument.
   *
   * `expect(locator).toHaveCount(1)` and `locator.textContent()` retry until they succeed.
   * Against a banner that mounts and unmounts several times a second they land on an "on"
   * phase and report a message that held still — which is precisely the transience this
   * test exists to detect. The version of this test that used them stayed green against a
   * `scanMachine` strobing at 10 Hz: measured presence trace 0010101010…, all four tests in
   * this file passing. `count()` and `allTextContents()` return what is on screen at the
   * instant they are called, and the MutationObserver catches every transition between two
   * of those instants — including a same-task unmount and remount, which no sampling rate
   * can see.
   *
   * That the decoder really is still running through this window is the sibling specs' to
   * show, not this one's: `scan-not-a-vin-stale.spec.ts` has a later code replace this
   * banner, and the dismissal test below has a later frame decline to raise it again.
   * Neither can happen without frames still arriving.
   */
  await page.evaluate(() => {
    const read = () => {
      const nodes = document.querySelectorAll('[role="alert"]');
      return `${nodes.length}:${Array.from(nodes, (node) => node.textContent ?? "").join("|")}`;
    };
    const isAlert = (node: Node) =>
      node instanceof Element &&
      (node.matches('[role="alert"]') || node.querySelector('[role="alert"]') !== null);
    const probe: StrobeProbe = {
      trace: [read()],
      mounts: 0,
      unmounts: 0,
      node: document.querySelector('[role="alert"]'),
    };
    window.__vinStrobe = probe;
    new MutationObserver((records) => {
      for (const record of records) {
        probe.mounts += Array.from(record.addedNodes).filter(isAlert).length;
        probe.unmounts += Array.from(record.removedNodes).filter(isAlert).length;
      }
      const now = read();
      if (probe.trace[probe.trace.length - 1] !== now) probe.trace.push(now);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });

  // Two seconds of continuous decoding, sampled twenty times at 100 ms. A message per
  // refused frame would be unusable and would bury the §6.4 states that matter.
  const presence: number[] = [];
  const texts = new Set<string>();
  for (let i = 0; i < 20; i += 1) {
    presence.push(await alerts.count());
    texts.add((await alerts.allTextContents()).join("|"));
    await page.waitForTimeout(100);
  }

  // Joined rather than compared element-wise so a failure prints the trace itself — a
  // strobe reads 0101010… and a banner that went away and stayed away reads 1110000….
  expect(presence.join("")).toBe("1".repeat(20));
  expect([...texts]).toHaveLength(1);
  expect([...texts][0]).toContain(PART_NUMBER);
  expect([...texts][0]).toContain(WHY);

  const strobe = await page.evaluate((): Strobe => {
    const probe = window.__vinStrobe;
    if (probe === undefined) throw new Error("the observer was never installed");
    return {
      trace: probe.trace,
      mounts: probe.mounts,
      unmounts: probe.unmounts,
      connected: probe.node !== null && probe.node.isConnected,
    };
  });
  // Nothing happened between two samples either, and the banner the first frame put on
  // screen is the very node still there two seconds later.
  expect(strobe.trace).toHaveLength(1);
  expect(strobe.trace[0]).toContain(PART_NUMBER);
  expect(strobe.unmounts).toBe(0);
  expect(strobe.mounts).toBe(0);
  expect(strobe.connected).toBe(true);
});

test("[FR-2] Keep scanning answers this read, and the same code does not ask again", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/scan");

  const notice = page.getByRole("alert");
  await expect(notice).toContainText(PART_NUMBER, { timeout: 20_000 });

  // §6.1's floor, as a rendered box and against the token that defines it (§7 item 5).
  const keep = page.getByRole("button", { name: "Keep scanning" });
  const tap = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tap")),
  );
  expect(tap).toBeGreaterThan(0);
  expect((await keep.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(tap);

  await keep.click();
  await expect(notice).toHaveCount(0);

  // R3-F5: the realistic case is the same sticker still under the camera, so the tap has to
  // answer *that read* and not just the banner — otherwise the very next frame raises it
  // again and the button does nothing anyone can see.
  await page.waitForTimeout(2000);
  await expect(notice).toHaveCount(0);
  // The camera never stopped for any of this.
  await expect(page.getByText("Point at the barcode on the door-jamb sticker.")).toBeVisible();
});
