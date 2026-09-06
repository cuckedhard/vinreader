/**
 * Rectify → grayscale → bicubic upscale, and the step that must never appear.
 *
 * Two of these have no other check anywhere. Nothing downstream can tell that the crop
 * came from the wrong rectangle, and nothing can tell that the image was binarised before
 * the engine saw it — both come back as a paint code that reads exactly like a right one
 * (N2). So both are pinned here, on pixels.
 */
import { describe, expect, it } from "vitest";
import {
  OCR_INK_MIN_CONTRAST,
  OCR_MAX_CROP_PIXELS,
  OCR_MAX_UPSCALE,
  OCR_TARGET_GLYPH_PX,
} from "./constants";
import {
  capScale,
  lumaOf,
  measureInkBand,
  paintLuma,
  preprocessCrop,
  upscaleFactor,
  type CanvasLike,
  type PreprocessDeps,
} from "./preprocess";
import { FakeCanvas, fill, grayOf, solid, type Pixels } from "./preprocess.testutil";
import { OcrError } from "./types";

/** Records every canvas the pipeline made, so the test can read what was drawn. */
function deps(): PreprocessDeps & { canvases: FakeCanvas[] } {
  const canvases: FakeCanvas[] = [];
  return {
    canvases,
    createCanvas: (width, height) => {
      const canvas = new FakeCanvas(width, height);
      canvases.push(canvas);
      return canvas;
    },
    encode: async (canvas: CanvasLike) => new Blob([`${canvas.width}x${canvas.height}`]),
  };
}

/** A grayscale field with a horizontal band of ink in it. */
function band(width: number, height: number, top: number, thickness: number, ink = 20): Uint8Array {
  const image = fill(
    solid(width, height, [220, 220, 220]),
    { left: 0, top, width, height: thickness },
    [ink, ink, ink],
  );
  return grayOf(image);
}

describe("lumaOf", () => {
  it("is BT.601, weighted the way the eye is", () => {
    const pixels = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
    expect([...lumaOf(pixels)]).toEqual([76, 150, 29]);
  });

  it("is one byte per pixel, not one per channel", () => {
    expect(lumaOf(new Uint8ClampedArray(40)).length).toBe(10);
  });
});

describe("paintLuma", () => {
  it("writes the grey back over all three channels, opaque", () => {
    const rgba = new Uint8ClampedArray([10, 200, 30, 0, 1, 2, 3, 7]);
    paintLuma(rgba, new Uint8Array([128, 64]));
    expect([...rgba]).toEqual([128, 128, 128, 255, 64, 64, 64, 255]);
  });
});

describe("measureInkBand", () => {
  it("finds the line, and only the line", () => {
    expect(measureInkBand(band(100, 60, 20, 12), 100, 60)).toEqual({
      top: 20,
      height: 12,
      measured: true,
    });
  });

  it("finds light ink on a dark label the same way", () => {
    const inverted = grayOf(
      fill(solid(100, 60, [20, 20, 20]), { left: 0, top: 30, width: 100, height: 8 }, [
        240, 240, 240,
      ]),
    );
    expect(measureInkBand(inverted, 100, 60)).toEqual({ top: 30, height: 8, measured: true });
  });

  it("refuses a crop with no contrast rather than measuring noise", () => {
    const flat = band(100, 60, 20, 12, 220 - (OCR_INK_MIN_CONTRAST - 2));
    expect(measureInkBand(flat, 100, 60)).toEqual({ top: 0, height: 60, measured: false });
  });

  it("refuses a crop that is ink from edge to edge", () => {
    // Vertical stripes: plenty of contrast, and every row is as busy as every other, so
    // the band grows to the whole crop. That is a photograph of something, not a line on
    // a sticker, and scaling by it would scale by the crop height.
    const striped = solid(100, 60, [220, 220, 220]);
    for (let x = 0; x < 100; x += 5) {
      fill(striped, { left: x, top: 0, width: 2, height: 60 }, [20, 20, 20]);
    }
    expect(measureInkBand(grayOf(striped), 100, 60)).toEqual({
      top: 0,
      height: 60,
      measured: false,
    });
  });

  it("refuses a buffer shorter than the crop it was said to describe", () => {
    // Half a crop. The missing half reads as zeroes, which become the modal level, which
    // turns the label itself into "ink" — a measured band of pure arithmetic. The engine
    // would then be handed a scale factor derived from a buffer that was never there.
    const truncated = band(100, 60, 20, 12).slice(0, 100 * 30);
    expect(measureInkBand(truncated, 100, 60)).toEqual({ top: 0, height: 60, measured: false });
    expect(measureInkBand(new Uint8Array(0), 0, 0).measured).toBe(false);
  });
});

describe("upscaleFactor", () => {
  it("scales a measured band to the 20–30 px glyph the engine wants", () => {
    expect(upscaleFactor({ top: 0, height: 10, measured: true }, 100)).toBeCloseTo(
      OCR_TARGET_GLYPH_PX / 10,
    );
  });

  it("never downscales a crop that is already sharp", () => {
    expect(upscaleFactor({ top: 0, height: 200, measured: true }, 400)).toBe(1);
  });

  it("stops at the ceiling rather than inventing edges", () => {
    expect(upscaleFactor({ top: 0, height: 1, measured: true }, 100)).toBe(OCR_MAX_UPSCALE);
  });

  it("falls back to a share of the crop when the band could not be measured", () => {
    const assumed = upscaleFactor({ top: 0, height: 40, measured: false }, 40);
    // Not the band's own height: the fallback reads the crop, which is what `measured`
    // being false means.
    expect(assumed).toBeGreaterThan(1);
    expect(assumed).not.toBe(upscaleFactor({ top: 0, height: 40, measured: true }, 40));
  });

  it("does not divide by a band of nothing", () => {
    expect(upscaleFactor({ top: 0, height: 0, measured: true }, 100)).toBe(1);
  });
});

describe("capScale", () => {
  it("holds the result under the pixel ceiling", () => {
    const width = 2000;
    const height = 400;
    const scale = capScale(4, width, height);
    expect(scale * width * scale * height).toBeLessThanOrEqual(OCR_MAX_CROP_PIXELS + 1);
    expect(scale).toBeLessThan(4);
  });

  it("leaves a scale that already fits alone, and never returns less than 1", () => {
    expect(capScale(2, 100, 50)).toBe(2);
    expect(capScale(4, 4000, 4000)).toBe(1);
    expect(capScale(1, 0, 0)).toBe(1);
  });
});

describe("preprocessCrop", () => {
  /** A frame with the paint code's line in one place and a decoy row in another. */
  function frame(): Pixels {
    const image = solid(200, 120, [230, 230, 230]);
    fill(image, { left: 0, top: 50, width: 200, height: 10 }, [10, 10, 10]); // the aimed line
    fill(image, { left: 0, top: 90, width: 200, height: 10 }, [200, 40, 40]); // a decoy row
    return image;
  }

  const LINE = { left: 20, top: 44, width: 160, height: 22 };

  it("reads the rectangle it was given and nothing outside it", async () => {
    const d = deps();
    const result = await preprocessCrop(frame(), LINE, d);
    const flat = d.canvases[0]!;
    expect([flat.width, flat.height]).toEqual([LINE.width, LINE.height]);
    // Row 6 of the crop is frame row 50 — the aimed line. Row 0 is the label above it.
    expect(flat.at(0, 6)[0]).toBeLessThan(60);
    expect(flat.at(0, 0)[0]).toBeGreaterThan(180);
    // The decoy row at frame y=90 is 46 px below the crop and never reaches any canvas.
    for (const canvas of d.canvases) {
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          const [red, green] = canvas.at(x, y);
          expect(red === 200 && green === 40).toBe(false);
        }
      }
    }
    expect(result.band.measured).toBe(true);
  });

  it("hands the engine grey, not colour", async () => {
    const d = deps();
    const coloured = fill(solid(80, 40, [200, 30, 30]), { left: 0, top: 18, width: 80, height: 4 }, [
      20, 90, 200,
    ]);
    await preprocessCrop(coloured, { left: 0, top: 0, width: 80, height: 40 }, d);
    for (const canvas of d.canvases) {
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          const [red, green, blue, alpha] = canvas.at(x, y);
          expect([green, blue, alpha]).toEqual([red, red, 255]);
        }
      }
    }
  });

  /**
   * The step that must never be added. Tesseract 4/5 recognise on grayscale and their
   * models were trained on it; thresholding ahead of them is documented as
   * counterproductive, and it is invisible afterwards — the engine returns a confident
   * wrong string either way.
   */
  it("does not binarise: the greys between ink and label survive", async () => {
    const d = deps();
    const ramp = solid(64, 32, [255, 255, 255]);
    for (let x = 0; x < 64; x += 1) {
      fill(ramp, { left: x, top: 8, width: 1, height: 16 }, [x * 4, x * 4, x * 4]);
    }
    await preprocessCrop(ramp, { left: 0, top: 0, width: 64, height: 32 }, d);
    const levels = d.canvases[d.canvases.length - 1]!.levels();
    expect(levels.length).toBeGreaterThan(8);
    expect(levels.some((level) => level > 20 && level < 235)).toBe(true);
  });

  it("upscales a crop whose glyphs are too small, and says by how much", async () => {
    const d = deps();
    const small = fill(solid(60, 24, [235, 235, 235]), { left: 0, top: 8, width: 60, height: 8 }, [
      15, 15, 15,
    ]);
    const result = await preprocessCrop(small, { left: 0, top: 0, width: 60, height: 24 }, d);
    expect(result.scale).toBeCloseTo(OCR_TARGET_GLYPH_PX / 8);
    expect(result.width).toBe(Math.round(60 * result.scale));
    expect(result.height).toBe(Math.round(24 * result.scale));
    expect(d.canvases).toHaveLength(2);
    expect([d.canvases[1]!.width, d.canvases[1]!.height]).toEqual([result.width, result.height]);
    // High-quality resampling on both surfaces: this is the "bicubic" in the pipeline.
    expect(d.canvases[0]!.quality).toContain("high");
    expect(d.canvases[1]!.quality).toContain("high");
    expect(d.canvases[1]!.smoothing).toContain(true);
  });

  it("makes no second canvas when the crop is already big enough", async () => {
    const d = deps();
    const big = fill(solid(120, 200, [235, 235, 235]), { left: 0, top: 40, width: 120, height: 60 }, [
      15, 15, 15,
    ]);
    const result = await preprocessCrop(big, { left: 0, top: 0, width: 120, height: 200 }, d);
    expect(result.scale).toBe(1);
    expect(d.canvases).toHaveLength(1);
    expect(result.width).toBe(120);
  });

  it("fails loudly when a canvas hands back no context", async () => {
    const d = deps();
    await expect(
      preprocessCrop(frame(), LINE, { ...d, createCanvas: (w, h) => new FakeCanvas(w, h, true) }),
    ).rejects.toBeInstanceOf(OcrError);
  });
});
