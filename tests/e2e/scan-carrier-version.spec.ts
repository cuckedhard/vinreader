import { expect, test } from "@playwright/test";
import { writeQrY4m } from "./qr-video";

/**
 * §13.2 adversary, round 2 of `harden S1`: "payloads with the wrong version" reaching the
 * scanner.
 *
 * §9-S3 / D14: `useScanner` tests every decode for a §4.9 carrier BEFORE `extractVin`, and
 * hands a match to `ScanScreen.handleCarrier`. That handler is:
 *
 *     try { payload = parseCarrier(raw); } catch { return; }
 *
 * `parseCarrier` throws `PayloadError("version", …)` for a payload whose `v` is not 1 —
 * the message is already written, in English, for exactly this moment — and the scanner
 * drops it on the floor. The QR is still in front of the camera, so the decode repeats
 * every 100 ms and is discarded every 100 ms: the receiving phone shows "Point at the
 * barcode on the door-jamb sticker." forever and never says why.
 *
 * P6: "Every cross-device format carries `v`. Unknown major version → clear rejection
 * message, never a crash." P7: "No silent catch-and-ignore." §6.2: the same payload pasted
 * into `/#/i` renders that message; the camera route must not be quieter than the paste
 * route.
 */

/** A §4.9 URL carrier — the form a QR uses — whose payload declares version 2. */
const BODY = Buffer.from(
  JSON.stringify({ v: 2, vin: "1HGCM82633A004352", mk: "HONDA", md: "Accord" }),
  "utf8",
)
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");
const CARRIER = `https://vinrelay.example/#/i?d=${BODY}`;

const Y4M = writeQrY4m("carrier-v2", [[CARRIER, 8]]);

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

/** The paste route already does the right thing; this pins the behaviour being compared to. */
test("[R2-02] the import route names the version it cannot read", async ({ page }) => {
  await page.goto(`/#/i?d=${BODY}`);
  await expect(page.getByText(/version 2/i)).toBeVisible({ timeout: 10_000 });
});

test("[R2-02] a scanned carrier the app cannot read is not swallowed", async ({ page }) => {
  await page.goto("/#/scan");

  // The scanner recognises this as a §4.9 carrier (that is what stops `extractVin` from
  // fabricating a VIN out of the base64url body), so it is the scanner's to report.
  await expect(
    page.getByRole("alert"),
    "P6/P7: an unreadable §4.9 carrier was dropped with no message",
  ).toBeVisible({ timeout: 20_000 });

  // Whatever is shown, it must not be a fabricated read and must not have written anything.
  await expect(page).not.toHaveURL(/#\/v\//);
  const rows = await page.evaluate(async () => {
    const open = indexedDB.open("vinrelay");
    const dbh: IDBDatabase = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
    if (!dbh.objectStoreNames.contains("vehicles")) return 0;
    const req = dbh.transaction("vehicles", "readonly").objectStore("vehicles").getAll();
    const all: unknown[] = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result as unknown[]);
      req.onerror = () => rej(req.error);
    });
    return all.length;
  });
  expect(rows).toBe(0);
});

/**
 * [R3-F1] The rejection has to be *on the screen*, not merely in the document.
 *
 * The test above passed while the banner had zero visible pixels: the machine stays
 * `streaming` for a refused carrier, so the preview keeps its full height and pushes the
 * banner past the fold, and Playwright's `isVisible()` — which asks about layout, not about
 * an ancestor's scroll clip — said `true` anyway. Measured at 360×640: `main.clientHeight`
 * 583, the alert 594→766, **0 visible pixels**, "Keep scanning" 0 of 48, and
 * `elementFromPoint` at the fold returning the scan section behind it. All the user saw was
 * the live QR under "Point at the barcode…", which is the silent refusal R2-02 was raised to
 * end (P7).
 *
 * So this measures the clip, not the layout, and it measures the phone that shows the fault.
 */
test("[R3-F1] the rejection is on screen on a small phone, with its way out", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 }); // §6.1's floor of a phone.
  await page.goto("/#/scan");
  await expect(page.getByRole("alert")).toBeVisible({ timeout: 20_000 });

  const seen = await page.evaluate(() => {
    const main = document.querySelector("main");
    const alert = document.querySelector("[role=alert]");
    if (!(main instanceof HTMLElement) || !(alert instanceof HTMLElement)) {
      throw new Error("no scan screen");
    }
    const fold = main.getBoundingClientRect();
    const visibleIn = (el: Element) => {
      const box = el.getBoundingClientRect();
      return Math.max(0, Math.min(box.bottom, fold.bottom) - Math.max(box.top, fold.top));
    };
    const keep = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Keep scanning",
    );
    if (keep === undefined) throw new Error("no way out of the rejection");
    const box = keep.getBoundingClientRect();
    const under = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      message: alert.textContent ?? "",
      alertVisible: Math.round(visibleIn(alert)),
      alertHeight: Math.round(alert.getBoundingClientRect().height),
      keepVisible: Math.round(visibleIn(keep)),
      keepHeight: Math.round(box.height),
      keepReachable: keep.contains(under),
    };
  });

  // The whole banner, not a sliver of it: this is the only thing on the screen that says why.
  expect(seen.message).toContain("version 2");
  expect(seen.alertVisible).toBe(seen.alertHeight);
  // §6.4's way out is a target a thumb can hit, which means the thumb has to be able to
  // land on it (§6.1).
  expect(seen.keepVisible).toBe(seen.keepHeight);
  expect(seen.keepReachable).toBe(true);
});


/**
 * [R3-F5] "Keep scanning" has to be a way forward, and it was not.
 *
 * The realistic case is the other phone still holding the code up. Dismissing the banner
 * only cleared the state that renders it, so the very next decode of the same QR raised it
 * again — measured at 629 ms after the tap, with nothing having changed. The only exits
 * were "Type VIN instead" or walking away, which is the opposite of what the button says.
 *
 * The dismissal is now about *that code*: the raw text the decoder read. A different code,
 * or a trip to the keyboard and back, raises again — nothing is suppressed that the user
 * has not already answered (P7).
 */
test("[R3-F5] Keep scanning ends the rejection for the code it was about", async ({ page }) => {
  await page.goto("/#/scan");
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Keep scanning" }).click();
  await expect(alert).toHaveCount(0);

  // The same QR is still in front of the camera and still decoding several times a second.
  // Six seconds is ten times the 629 ms it used to take to come back.
  await page.waitForTimeout(6_000);
  await expect(alert, "the dismissed code came back on its own").toHaveCount(0);

  // Not a permanent silence: the way out of the camera and back is a fresh look at the
  // scene, so the same code is reported again.
  await page.getByRole("button", { name: /type vin instead/i }).click();
  await page.getByRole("button", { name: "Scan with the camera" }).click();
  await expect(alert).toBeVisible({ timeout: 20_000 });
});

