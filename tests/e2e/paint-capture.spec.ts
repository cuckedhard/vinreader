import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { encodePayload } from "../../src/lib/payload/codec";

/**
 * S5 layer 2 — the capture mode, end to end, against a synthetic certification label.
 *
 * The label is the hard case S5 addendum §5 describes rather than a clean word on an empty
 * field: the aimed line carries `PNT WA8555`, and the rows above and below carry a GVWR
 * figure, a tyre pressure and a date. Both halves of the design are only provable that way
 * — that the crop box is what stops those rows being read, and that nothing picks a token
 * out of the aimed line on the user's behalf.
 *
 * Synthetic, and it stays synthetic (§13.7): this proves the pipeline runs, never that a
 * scuffed sticker in a snowy door jamb reads.
 */
const Y4M = resolve(process.cwd(), "bench/fake-paint.y4m");
const VIN = "1HGCM82633A004352";
const CODE = "WA8555";
/** The other token on the aimed line. Nothing may prefer one of the two (§5). */
const NEIGHBOUR = "PNT";
/** Tokens on the rows the crop box exists to exclude. */
const OFF_THE_LINE = ["GVWR", "2722", "235", "0925", "TRUCK"];

const PAYLOAD = encodePayload({ v: 1, vin: VIN, y: "2003", mk: "HONDA", md: "Accord" });

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

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); // §6.1: one hand, a phone.
  await page.route("**/api/vehicles/DecodeVinValues/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        Count: 1,
        Results: [{ ErrorCode: "0", Make: "HONDA", Model: "Accord", ModelYear: "2003" }],
      }),
    }),
  );
});

/** A stored record to hang a paint code on, and the capture screen open over it. */
async function openCapture(page: Page) {
  await page.goto(`/#/i?d=${PAYLOAD}`);
  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));
  await page.getByRole("button", { name: "Read it with the camera" }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}/paint`));
}

/** What is actually on the record, read out of Dexie rather than off the screen. */
async function storedPaint(page: Page): Promise<string | null | undefined> {
  return page.evaluate(async (vin) => {
    const open = indexedDB.open("vinrelay");
    const handle: IDBDatabase = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
    const request = handle.transaction("vehicles", "readonly").objectStore("vehicles").get(vin);
    const row = await new Promise<{ paint?: string | null } | undefined>((res, rej) => {
      request.onsuccess = () => res(request.result);
      request.onerror = () => rej(request.error);
    });
    return row?.paint ?? null;
  }, VIN);
}

async function tokens(page: Page) {
  return page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    return {
      tap: parseFloat(css.getPropertyValue("--tap")),
      tapLg: parseFloat(css.getPropertyValue("--tap-lg")),
    };
  });
}

test("[§5] the crop box is a line, floored at a tap target, and not the barcode band", async ({
  page,
}) => {
  await openCapture(page);
  const { tap } = await tokens(page);

  const box = await page.getByTestId("paint-crop-box").boundingBox();
  const preview = await page.locator("video").boundingBox();
  expect(box).not.toBeNull();
  expect(preview).not.toBeNull();

  // A *line*: wide, and much wider than it is tall.
  expect(box!.width).toBeGreaterThan(preview!.width * 0.8);
  expect(box!.width / box!.height).toBeGreaterThan(4);

  // And a gloved hand can still put it on one: the fraction is floored at `--tap`,
  // measured as the box the browser laid out and not as the class that asked for it (F1-a).
  expect(box!.height).toBeGreaterThanOrEqual(tap);

  // That it is not §6.1's ~90% x 22% barcode guide is `cropBox.test.ts`'s to say, on the
  // fractions. It cannot be said here: at 22% of a 4:3 preview the rendered box is 58 px
  // and still five times wider than it is tall, so no measurement of *this* box separates
  // the two. What separates them is what reaches the engine, and that is the next test.
});

test("[§5] the copy names the box, never a place on the car", async ({ page }) => {
  await openCapture(page);
  // S5 addendum §3: "point at the door jamb" is wrong for a meaningful fraction of
  // vehicles — VW and Audi use the trunk or the spare-wheel well, GM legacy the glovebox.
  await expect(page.getByText("Put the box on the paint code.")).toBeVisible();
  const where = page.getByText(/The sticker is on the door jamb on some vehicles/);
  await expect(where).toBeVisible();
  await expect(where).toContainText("trunk");
  await expect(where).toContainText("glovebox");

  // The size under the button is the one the user is deciding about. 4,483,231 bytes is
  // 4.5 MB as a data plan counts them and 4.3 as a disk does, and the literal is written
  // out here rather than derived from the manifest: a test that computes the same number
  // the screen computes cannot notice either of them being wrong.
  await expect(page.getByText(/The first read downloads a .* reader/)).toContainText("4.5 MB");
});

test("[N2] it reads the label, offers what it read, and stores nothing until a person taps", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openCapture(page);
  const { tap, tapLg } = await tokens(page);

  await page.getByRole("button", { name: "Read the code" }).click();

  const candidates = page.getByTestId("paint-candidate");
  await expect(candidates.first()).toBeVisible({ timeout: 150_000 });

  // What the engine was actually handed: a line, not a frame. The aimed box is about 845
  // by 129 frame pixels, so the crop it read is six or seven times wider than it is tall;
  // the frame behind it is 16:9. This is the assertion that says the crop happened at all
  // — §5's whole finding is that full-frame OCR plus a pattern fabricates.
  const crop = page.getByTestId("paint-crop");
  await expect(crop).toBeVisible();
  const shape = await crop.evaluate((img) => {
    const image = img as HTMLImageElement;
    return image.naturalWidth / image.naturalHeight;
  });
  expect(shape).toBeGreaterThan(4);

  // The crop box is the only reason the rows above and below are not on offer. Every one
  // of these is a token on the same label, 90 or more frame rows outside the box.
  const offered = (await candidates.allInnerTexts()).join(" ");
  for (const stray of OFF_THE_LINE) {
    expect(offered, `${stray} is off the aimed line`).not.toContain(stray);
  }

  // The two tokens on the aimed line, both offered, neither chosen for the user (§5's
  // pattern step). A cross-manufacturer regex is what would pick one, and §5 measured that
  // it fabricates.
  const wanted = page.getByRole("button", { name: `Save ${CODE}` });
  await expect(wanted).toBeVisible();
  await expect(page.getByRole("button", { name: `Save ${NEIGHBOUR}` })).toBeVisible();
  await expect(page.getByText("It read these. Pick the one on the sticker.")).toBeVisible();

  // §6.1: every one of them is a 56 px target, measured as laid out.
  for (const name of [`Save ${CODE}`, `Save ${NEIGHBOUR}`]) {
    const box = await page.getByRole("button", { name }).boundingBox();
    expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(tapLg);
    expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(tap);
  }

  // §5 and N2, the whole point of the slice: a paint code has no check digit, no grammar
  // and no downstream lookup, so nothing can ever contradict a wrong one. Five frames have
  // agreed and the record still carries nothing.
  expect(await storedPaint(page)).toBeNull();

  await wanted.click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}$`));
  await expect(page.getByLabel("Paint code")).toHaveValue(CODE);

  // Written, not merely displayed.
  await page.reload();
  await expect(page.getByLabel("Paint code")).toHaveValue(CODE);
  expect(await storedPaint(page)).toBe(CODE);
});

test("[§5] the candidates are equal weight, and none of them is dressed as the answer", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openCapture(page);
  await page.getByRole("button", { name: "Read the code" }).click();
  const candidates = page.getByTestId("paint-candidate");
  await expect(candidates.first()).toBeVisible({ timeout: 150_000 });
  await expect(candidates).toHaveCount(2);

  // §5: "equal-weight ≥56 px buttons, nothing preselected". Painted, not declared — the
  // class list is not the evidence, the pixels are. Styling one of them as the primary is
  // a guess wearing the clothes of a decision, and N2 says nothing downstream catches it.
  const painted = await candidates.evaluateAll((nodes) =>
    nodes.map((node) => {
      const style = getComputedStyle(node);
      return [style.backgroundColor, style.borderColor, style.color, style.fontSize].join("|");
    }),
  );
  expect(new Set(painted).size, painted.join(" vs ")).toBe(1);
});

test("[§5] a character is corrected by tapping it, and the correction is undoable", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openCapture(page);
  const { tapLg } = await tokens(page);
  await page.getByRole("button", { name: "Read the code" }).click();
  await expect(page.getByTestId("paint-candidate").first()).toBeVisible({ timeout: 150_000 });

  // §5: "Correction is a row of per-character ≥56 px buttons — tap a character, get its
  // confusion set. No caret, no long-press." The row is the winner, one button per
  // character, measured as the browser laid them out.
  const characters = page.getByTestId("paint-char");
  await expect(characters).toHaveCount(CODE.length);
  expect((await characters.allInnerTexts()).join("")).toBe(CODE);
  for (let index = 0; index < CODE.length; index += 1) {
    const box = await characters.nth(index).boundingBox();
    expect(box?.height ?? 0, `character ${index + 1} height`).toBeGreaterThanOrEqual(tapLg);
    expect(box?.width ?? 0, `character ${index + 1} width`).toBeGreaterThanOrEqual(tapLg);
  }

  // A `W` has no lookalike in S5 addendum §5's table. It stays in the row — a gap would
  // read as a character that cannot be wrong — and it is not tappable.
  await expect(page.getByRole("button", { name: "Character 1, W" })).toBeDisabled();

  // `8` does: the set is offered *including the 8 already there*, which is what makes the
  // first tap reversible without a second control.
  await page.getByRole("button", { name: "Character 3, 8" }).click();
  const swaps = page.getByTestId("paint-swap");
  await expect(swaps).toHaveCount(2);
  expect((await swaps.allInnerTexts()).sort()).toEqual(["8", "B"]);
  for (const option of ["8", "B"]) {
    const box = await page.getByRole("button", { name: `Character 3 is ${option}` }).boundingBox();
    expect(box?.height ?? 0, option).toBeGreaterThanOrEqual(tapLg);
    expect(box?.width ?? 0, option).toBeGreaterThanOrEqual(tapLg);
  }

  await page.getByRole("button", { name: "Character 3 is B" }).click();

  // What the user built is now the one control, with the value inside it (§5), and the
  // other token off the line is gone: the question it asked has been answered.
  await expect(page.getByRole("button", { name: "Save WAB555" })).toBeVisible();
  await expect(page.getByRole("button", { name: `Save ${NEIGHBOUR}` })).toHaveCount(0);
  // N2: a correction is not a save either. Nothing has been written.
  expect(await storedPaint(page)).toBeNull();

  // Undo: the character the engine read is in its own set, so tapping it back restores the
  // whole offer rather than leaving the user with a string they cannot get out of.
  await page.getByRole("button", { name: "Character 3, B" }).click();
  await page.getByRole("button", { name: "Character 3 is 8" }).click();
  await expect(page.getByRole("button", { name: `Save ${CODE}` })).toBeVisible();
  await expect(page.getByRole("button", { name: `Save ${NEIGHBOUR}` })).toBeVisible();

  // And a correction the user does keep is what gets stored — the characters they tapped,
  // not the ones the engine read.
  await page.getByRole("button", { name: "Character 3, 8" }).click();
  await page.getByRole("button", { name: "Character 3 is B" }).click();
  const found = await new AxeBuilder({ page }).analyze();
  expect(
    found.violations
      .filter((violation) => violation.impact === "critical" || violation.impact === "serious")
      .map((violation) => violation.id),
  ).toEqual([]);

  await page.getByRole("button", { name: "Save WAB555" }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}$`));
  expect(await storedPaint(page)).toBe("WAB555");
});

test("[§5] the typed escape is on screen before anything is read, and it is empty", async ({
  page,
}) => {
  await openCapture(page);
  const field = page.getByLabel("Or type the paint code");
  await expect(field).toBeVisible();
  // A field pre-filled with the engine's guess, with a Save beside it, is auto-accept with
  // extra steps (§5). It is empty because nothing has been proposed, and it stays empty
  // when something is.
  await expect(field).toHaveValue("");

  await field.fill("NH-731P");
  await page.getByRole("button", { name: "Save what I typed" }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}$`));
  expect(await storedPaint(page)).toBe("NH-731P");
});

test("[§4] a device that cannot run the engine is told, and its camera is left alone", async ({
  page,
}) => {
  // §1: iOS Lockdown Mode disables WebAssembly outright, and this build pins the SIMD core
  // and preprocesses on an OffscreenCanvas in a worker. Any of those missing is a device
  // that must be told before 4.4 MB is spent — and must not be asked for a camera to show
  // a preview nothing can read from.
  await page.addInitScript(() => {
    const asked: string[] = [];
    (window as unknown as { __asked: string[] }).__asked = asked;
    const original = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
    if (navigator.mediaDevices !== undefined) {
      navigator.mediaDevices.getUserMedia = (constraints) => {
        asked.push("getUserMedia");
        return original!(constraints);
      };
    }
    Reflect.deleteProperty(globalThis, "OffscreenCanvas");
  });
  await openCapture(page);

  await expect(page.getByText("This browser can't run the reader. Type the code instead.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Read the code" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __asked: string[] }).__asked)).toEqual(
    [],
  );

  // The route is still open, and it is the primary one here (§6.4).
  const typed = page.getByLabel("Or type the paint code");
  await typed.fill("LC9X");
  await page.getByRole("button", { name: "Save what I typed" }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}$`));
  expect(await storedPaint(page)).toBe("LC9X");
});

test("[§6.3] a camera that will not start says so, and the screen does not argue with it", async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException("denied", "NotAllowedError"));
  });
  await openCapture(page);

  await expect(page.getByText("The camera didn't start here. You can still type the code.")).toBeVisible();
  // §6.3's rule: the status line never says something the banner below it contradicts.
  // "Starting camera…" over "The camera didn't start" is the screen arguing with itself,
  // and the sentence the user acts on is whichever they read first.
  await expect(page.getByText("Starting camera…")).toHaveCount(0);
  await expect(page.getByText("Put the box on the paint code.")).toHaveCount(0);

  // The route out is the typed field, and it carries the primary weight here (§6.4).
  const typed = page.getByLabel("Or type the paint code");
  await typed.fill("1F7");
  await page.getByRole("button", { name: "Save what I typed" }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}$`));
  expect(await storedPaint(page)).toBe("1F7");
});

test("[§4] backgrounding puts the camera down, and coming back picks it up", async ({ page }) => {
  await openCapture(page);
  const streaming = () => page.evaluate(() => document.querySelector("video")?.srcObject !== null);
  await expect.poll(streaming).toBe(true);

  // §4: iOS gives about seven seconds of grace and then suspends the page. `engine.ts`
  // already aborts a read on the way out; a camera left streaming behind a locked screen is
  // a light left on and a battery spent on frames nobody is looking at.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(streaming).toBe(false);
  // And it *stays* down. A camera that is torn down and immediately re-acquired reads as a
  // moment of `null` to a poll, which is why the absence is asserted a second later too.
  await page.waitForTimeout(1000);
  expect(await streaming()).toBe(false);

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(streaming).toBe(true);
});

test("[F13] the capture screen is entered by a heading, and axe is clean on it", async ({
  page,
}) => {
  await openCapture(page);
  const found = await new AxeBuilder({ page }).analyze();
  expect(await page.locator("h1").count()).toBe(1);
  expect(
    found.violations
      .filter((violation) => violation.impact === "critical" || violation.impact === "serious")
      .map((violation) => violation.id),
  ).toEqual([]);
});
