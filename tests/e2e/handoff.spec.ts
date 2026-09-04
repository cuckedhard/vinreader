import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { encodePayload } from "../../src/lib/payload/codec";

const VIN = "1HGCM82633A004352";

/** Built with the real §4.9 codec, so the test cannot drift from the implementation. */
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

async function stubVpic(page: Page) {
  await page.route("**/api/vehicles/DecodeVinValues/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        Count: 1,
        Message: "synthetic",
        SearchCriteria: null,
        Results: [{ ErrorCode: "0", Make: "HONDA", Model: "Accord", ModelYear: "2003" }],
      }),
    }),
  );
}

test.beforeEach(async ({ page }) => stubVpic(page));

test("imports a payload URL after showing what it will import", async ({ page }) => {
  await page.goto(`/#/i?d=${PAYLOAD}`);

  // §6.4: preview then confirm. Nothing is written until Import.
  await expect(page.getByText("1HG CM826 3 3 A 004352")).toBeVisible();
  await expect(page.getByRole("button", { name: /^import$/i })).toBeVisible();

  await page.getByRole("link", { name: "History" }).click();
  await expect(page.getByText("1HG CM826 3 3 A 004352")).toHaveCount(0);

  await page.goto(`/#/i?d=${PAYLOAD}`);
  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));

  // The payload's own unit and notes came across, not just the VIN.
  await expect(page.getByLabel("Unit")).toHaveValue("UNIT-42");
  await expect(page.getByRole("textbox", { name: "Notes" })).toHaveValue("Rear light out");
});

test("rejects a corrupt payload without stranding the user", async ({ page }) => {
  await page.goto("/#/i?d=not-a-real-payload");
  await expect(page.getByRole("button", { name: /^import$/i })).toHaveCount(0);
  // P7: a failure is stated, and the paste box is still there to try again.
  await expect(page.locator("textarea, input[type=text]").first()).toBeVisible();
});

test("names the version when a payload is from a newer format", async ({ page }) => {
  const future = encodePayload({ v: 1, vin: VIN });
  // Re-encode with v:2 by hand: the codec refuses to build one, which is the point.
  const bytes = Buffer.from(future.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
  const v2 = Buffer.from(bytes.replace('"v":1', '"v":2'))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await page.goto(`/#/i?d=${v2}`);
  await expect(page.getByText(/2/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^import$/i })).toHaveCount(0);
});

test("exports every saved record as a JSON bundle and as CSV", async ({ page }) => {
  await page.goto(`/#/i?d=${PAYLOAD}`);
  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));

  await page.getByRole("link", { name: "History" }).click();

  const jsonDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: /export json/i }).click();
  const json = await jsonDownload;
  const bundle = JSON.parse(
    await (await json.createReadStream())!.toArray().then((c) => c.join("")),
  );
  expect(bundle.app).toBe("vin-relay");
  expect(bundle.v).toBe(1);
  expect(bundle.vehicles).toHaveLength(1);
  expect(bundle.vehicles[0].vin).toBe(VIN);

  const csvDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: /export csv/i }).click();
  const csv = await csvDownload;
  const text = await (await csv.createReadStream())!.toArray().then((c) => c.join(""));
  const [header, first] = text.split("\r\n");
  expect(header).toBe(
    "vin,year,make,model,trim,body,engine,fuel,drive,gvwr,plant,unit,notes," +
      "firstScannedAt,lastScannedAt,scanCount,decodeStatus",
  );
  expect(first).toContain(VIN);
});

/**
 * §9-S3's phone-to-phone handoff is "show QR, scan QR", so the *shown* code has to be whole on
 * the screen of a phone and drawn at the resolution of that screen. Both halves are geometry no
 * other instrument in this repo can see: vitest runs in `node` with no DOM, and the desktop
 * project runs at devicePixelRatio 1, where a bug in the CSS-box-vs-backing-store relationship
 * is invisible by construction.
 *
 * What this replaces: `expect(box.width).toBeGreaterThan(150)`, with the comment "a QR that
 * renders at zero size is not a QR". It could only ever fail if the code vanished. It passed at
 * 711 CSS px on a 320 px viewport — a code clipped by the screen edge on both sides, which does
 * not decode — through three rounds of hardening (R4-H).
 *
 * So assert the properties that make the code usable, not a floor it cannot fall through:
 *  1. it is square, and whole inside both the viewport and the overlay that owns it;
 *  2. its backing store is the CSS box times the device pixel ratio — a code drawn at CSS
 *     resolution on a 3x screen is mush, so "make it fit" must not be done by dropping the
 *     multiply;
 *  3. the way out is on screen without scrolling and is a §6.1-sized target;
 *  4. and all of that survives a resize, which re-runs the draw.
 */

/** Mirrors the cap in `pixelRatio()` in `src/ui/QrView.tsx`. Two places, on purpose: if the cap
 *  moves there, this fails here, and moving it becomes a decision instead of a silent drift. */
const PIXEL_RATIO_CAP = 3;

/** §6.1: "Targets: ≥ 48 px everything". Close is not on the ≥ 56 px list; it measures 56. */
const TAP_FLOOR = 48;

interface QrGeometry {
  dpr: number;
  viewport: { w: number; h: number };
  /** `canvas.width` / `canvas.height` — the backing store, in device pixels. */
  backing: { w: number; h: number };
  /** The painted CSS box, which is what the other phone's camera sees. */
  canvas: { x: number; y: number; w: number; h: number };
  overlay: { x: number; y: number; w: number; h: number };
  close: { x: number; y: number; w: number; h: number };
  /** What is actually on top at the centre of each: a control nothing can hit is not a control. */
  topAtCanvasCentre: string;
  topAtCloseCentre: string;
}

async function qrGeometry(page: Page): Promise<QrGeometry> {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const overlay = document.querySelector<HTMLElement>('dialog, [role="dialog"]');
    const close = [...document.querySelectorAll<HTMLElement>("button")].find(
      (node) => node.textContent?.trim() === "Close",
    );
    if (canvas === null || overlay === null || close === undefined) {
      throw new Error("the QR overlay, its canvas and its Close button all have to be present");
    }
    const box = (node: Element) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const topAt = (r: { x: number; y: number; w: number; h: number }, target: Element) => {
      const hit = document.elementFromPoint(r.x + r.w / 2, r.y + r.h / 2);
      if (hit === null) return "nothing — the centre of it is off screen";
      if (hit === target || target.contains(hit)) return "itself";
      return `${hit.tagName.toLowerCase()} "${(hit.textContent ?? "").trim().slice(0, 24)}"`;
    };
    const canvasBox = box(canvas);
    const closeBox = box(close);
    return {
      dpr: window.devicePixelRatio,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      backing: { w: canvas.width, h: canvas.height },
      canvas: canvasBox,
      overlay: box(overlay),
      close: closeBox,
      topAtCanvasCentre: topAt(canvasBox, canvas),
      topAtCloseCentre: topAt(closeBox, close),
    };
  });
}

/**
 * Retries: the draw finishes in an effect, and after a resize in the effect the resize
 * schedules. Every state this waits through is a state the user never sees — the library sizes
 * the canvas and the component puts the box back within the same microtask checkpoint, so no
 * frame is painted in between.
 */
async function expectAScannableQr(page: Page) {
  await expect(async () => {
    const g = await qrGeometry(page);

    // 1. Square, and whole inside the screen and inside the overlay that owns it.
    expect(g.canvas.w, `the code is square: ${JSON.stringify(g)}`).toBe(g.canvas.h);
    expect(g.canvas.x, `code left edge vs viewport: ${JSON.stringify(g)}`).toBeGreaterThanOrEqual(
      0,
    );
    expect(g.canvas.y, `code top edge vs viewport: ${JSON.stringify(g)}`).toBeGreaterThanOrEqual(0);
    expect(
      g.canvas.x + g.canvas.w,
      `code right edge vs viewport: ${JSON.stringify(g)}`,
    ).toBeLessThanOrEqual(g.viewport.w);
    expect(
      g.canvas.y + g.canvas.h,
      `code bottom edge vs viewport: ${JSON.stringify(g)}`,
    ).toBeLessThanOrEqual(g.viewport.h);
    expect(g.canvas.x).toBeGreaterThanOrEqual(g.overlay.x);
    expect(g.canvas.y).toBeGreaterThanOrEqual(g.overlay.y);
    expect(g.canvas.x + g.canvas.w).toBeLessThanOrEqual(g.overlay.x + g.overlay.w);
    expect(g.canvas.y + g.canvas.h).toBeLessThanOrEqual(g.overlay.y + g.overlay.h);
    expect(g.topAtCanvasCentre).toBe("itself");

    // 2. Device resolution, at the CSS size the component asked for. Equality both ways: too
    //    small is a blurry code, and "the CSS box is the pixel size" is the R4-H overflow.
    const scale = Math.min(g.dpr, PIXEL_RATIO_CAP);
    expect(
      g.backing,
      `backing store vs ${g.canvas.w} CSS px at ${g.dpr}x: ${JSON.stringify(g)}`,
    ).toEqual({
      w: Math.round(g.canvas.w * scale),
      h: Math.round(g.canvas.h * scale),
    });

    // 3. The way out (N5: a button, never a gesture) is on screen without scrolling for it.
    expect(g.close.h, `Close height: ${JSON.stringify(g)}`).toBeGreaterThanOrEqual(TAP_FLOOR);
    expect(g.close.w).toBeGreaterThanOrEqual(TAP_FLOOR);
    expect(g.close.y).toBeGreaterThanOrEqual(0);
    expect(
      g.close.y + g.close.h,
      `Close bottom vs the fold: ${JSON.stringify(g)}`,
    ).toBeLessThanOrEqual(g.viewport.h);
    expect(g.topAtCloseCentre).toBe("itself");
  }).toPass({ timeout: 10_000 });
}

test("shows a scannable QR for the record", async ({ page }) => {
  await page.goto(`/#/i?d=${PAYLOAD}`);
  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));

  await page.getByRole("button", { name: /qr code/i }).click();
  await expect(page.locator("canvas")).toBeVisible();
  await expectAScannableQr(page);

  // 4. Redraw on resize is the other path that can put a pixel-sized box on screen: the
  //    library re-runs and writes its inline size again, after React has already written the
  //    new one. Narrow the window so the code actually changes size on every profile — a
  //    resize that computes the same size never re-renders and so proves nothing.
  //
  //    Deliberately still portrait. The overlay sizes the code off the *shorter* side of the
  //    viewport, and when that side is the height it does not reserve room for its own caption
  //    and Close button: at 1024 x 576 (DPR 1) Close lands at y = 588.5 on a 576 px viewport.
  //    That is a separate finding, reported, not this guard's subject — and not something to
  //    launder by never resizing.
  const before = await qrGeometry(page);
  await page.setViewportSize({
    width: Math.round(Math.min(before.viewport.w, before.viewport.h) * 0.8),
    height: before.viewport.h,
  });
  await expectAScannableQr(page);
});
