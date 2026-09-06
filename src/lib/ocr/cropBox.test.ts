/**
 * The mapping from the box on screen to the pixels the engine reads.
 *
 * If this is wrong the app crops a band *next to* the one the user aligned, and the engine
 * reads a tyre pressure or a GVWR figure with a whitelist that makes it look exactly like
 * a paint code. Nothing downstream can catch that (N2), which is why the arithmetic is
 * pinned here rather than checked by eye against a preview.
 */
import { describe, expect, it } from "vitest";
import { PAINT_BOX_HEIGHT_FRACTION, PAINT_BOX_WIDTH_FRACTION } from "./constants";
import { PAINT_CROP_BOX, coverScale, displayedToSourceRect } from "./cropBox";

const FRAME = { width: 1920, height: 1080 };

describe("PAINT_CROP_BOX", () => {
  it("is a wide single line, and not §6.1's ~90% x 22% barcode band", () => {
    expect(PAINT_CROP_BOX.width).toBe(PAINT_BOX_WIDTH_FRACTION);
    expect(PAINT_CROP_BOX.height).toBe(PAINT_BOX_HEIGHT_FRACTION);
    // A line: much wider than it is tall, and well under the 22% band [SB-3] measured
    // taking data_matrix from 100% clean to 0%.
    expect(PAINT_CROP_BOX.width).toBeGreaterThan(4 * PAINT_CROP_BOX.height);
    expect(PAINT_CROP_BOX.height).toBeLessThan(0.22);
  });
});

describe("coverScale", () => {
  it("fills the element on whichever axis needs the most, which is what object-cover does", () => {
    // A 16:9 frame in a 4:3 element: the height decides, and the width overflows.
    expect(coverScale({ width: 400, height: 300 }, { width: 1920, height: 1080 })).toBeCloseTo(
      300 / 1080,
    );
    // A 4:3 frame in a 16:9 element: the width decides.
    expect(coverScale({ width: 1600, height: 900 }, { width: 640, height: 480 })).toBeCloseTo(
      1600 / 640,
    );
  });
});

describe("displayedToSourceRect", () => {
  it("maps a centred box to a centred crop when nothing is cropped by the fit", () => {
    // Element and frame share an aspect ratio, so object-cover is a plain 2x scale.
    const rect = displayedToSourceRect(
      { left: 96, top: 240, width: 768, height: 60 },
      { width: 960, height: 540 },
      FRAME,
    );
    expect(rect).toEqual({ left: 192, top: 480, width: 1536, height: 120 });
  });

  it("accounts for the frame object-cover hides off the sides", () => {
    // A 16:9 frame in a 3:4 element: cover scales by the height (800/1080) and the frame
    // is then 1422 px wide inside a 600 px element, so 411 px is hidden on each side.
    const displayed = { width: 600, height: 800 };
    const full = displayedToSourceRect(
      { left: 0, top: 0, width: 600, height: 800 },
      displayed,
      FRAME,
    );
    // The whole element shows only the middle ~42% of the frame's width, and all of its height.
    expect(full?.height).toBe(1080);
    expect(full?.width).toBeLessThan(FRAME.width * 0.43);
    expect(full?.width).toBeGreaterThan(FRAME.width * 0.41);
    // Centred: what is dropped on the left is dropped on the right.
    expect(full!.left + full!.width / 2).toBeCloseTo(FRAME.width / 2, 0);
  });

  it("is not a plain ratio: ignoring the cover offset lands on different pixels", () => {
    const displayed = { width: 600, height: 800 };
    const box = { left: 36, top: 380, width: 528, height: 48 };
    const rect = displayedToSourceRect(box, displayed, FRAME)!;
    // What the mapping would be if the element were assumed to show the whole frame —
    // the mistake this function exists to not make.
    const naive = Math.floor((box.left / displayed.width) * FRAME.width);
    expect(rect.left).not.toBe(naive);
    expect(Math.abs(rect.left - naive)).toBeGreaterThan(300);
  });

  it("rounds outward so a glyph is never clipped by half a pixel", () => {
    // 0.5 px of element maps to 1.6 px of frame here; both edges have to grow, not round.
    const rect = displayedToSourceRect(
      { left: 10.5, top: 20.5, width: 100.5, height: 30.5 },
      { width: 600, height: 337.5 },
      FRAME,
    )!;
    expect(rect.left).toBe(Math.floor(10.5 * (1920 / 600)));
    expect(rect.left + rect.width).toBe(Math.ceil(111 * (1920 / 600)));
  });

  it("clamps to the frame rather than sampling outside it", () => {
    const rect = displayedToSourceRect(
      { left: -400, top: -400, width: 4000, height: 4000 },
      { width: 960, height: 540 },
      FRAME,
    )!;
    expect(rect).toEqual({ left: 0, top: 0, width: 1920, height: 1080 });
  });

  it("still returns at least one pixel when the box is entirely off the frame", () => {
    const rect = displayedToSourceRect(
      { left: 5000, top: 5000, width: 10, height: 10 },
      { width: 960, height: 540 },
      FRAME,
    )!;
    expect(rect.width).toBeGreaterThanOrEqual(1);
    expect(rect.height).toBeGreaterThanOrEqual(1);
    expect(rect.left + rect.width).toBeLessThanOrEqual(FRAME.width);
    expect(rect.top + rect.height).toBeLessThanOrEqual(FRAME.height);
  });

  it("refuses a frame that has no size yet, which is a <video> for its first moments", () => {
    const box = { left: 0, top: 0, width: 10, height: 10 };
    expect(displayedToSourceRect(box, { width: 100, height: 100 }, { width: 0, height: 0 })).toBeNull();
    expect(displayedToSourceRect(box, { width: 0, height: 100 }, FRAME)).toBeNull();
    expect(displayedToSourceRect(box, { width: 100, height: 0 }, FRAME)).toBeNull();
    expect(displayedToSourceRect(box, { width: 100, height: 100 }, { width: 100, height: 0 })).toBeNull();
  });

  it("refuses a box with no size, and a box with no position", () => {
    const displayed = { width: 960, height: 540 };
    expect(
      displayedToSourceRect({ left: 0, top: 0, width: 0, height: 10 }, displayed, FRAME),
    ).toBeNull();
    expect(
      displayedToSourceRect({ left: 0, top: 0, width: 10, height: 0 }, displayed, FRAME),
    ).toBeNull();
    expect(
      displayedToSourceRect({ left: NaN, top: 0, width: 10, height: 10 }, displayed, FRAME),
    ).toBeNull();
    expect(
      displayedToSourceRect({ left: 0, top: Infinity, width: 10, height: 10 }, displayed, FRAME),
    ).toBeNull();
  });
});
