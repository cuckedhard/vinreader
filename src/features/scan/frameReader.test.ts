/**
 * R6-SA-1 — §4.6's `TRY_HARDER` 90° retry, proved on the app's own per-frame call.
 *
 * `@zxing/browser` 0.2.1's `HTMLCanvasElementLuminanceSource` answers `isRotateSupported()`
 * with `true` and then throws `Error: Could not create a Canvas element.` out of `rotate()`,
 * because its constructor never assigns `tempCanvasElement` and `getTempCanvasElement()`
 * tests `null === this.tempCanvasElement` against `undefined`. `OneDReader.decode` takes the
 * rotated branch on every horizontal miss when `TRY_HARDER` is set, so the throw escaped into
 * `MultiFormatReader`'s per-reader catch as a `console.warn` and a 1D symbol held at 90° in
 * the frame never read.
 *
 * These tests are about the frame, not about the barcode: the symbol is rendered from
 * `@zxing/library`'s **own** Code 39 tables (§7 item 5 — no second copy of a symbology
 * table), then rotated a quarter turn clockwise so that the bars run horizontally, which is
 * exactly the frame a label read sideways produces. The control is the point of the whole
 * file: the same pixels, the same reader and the same §4.6 hints through
 * `RGBLuminanceSource` — which answers `isRotateSupported()` with `false` — must miss. If
 * the rotation ever stops happening, the two assertions disagree and this file goes red.
 */

import {
  BinaryBitmap,
  BarcodeFormat,
  Code39Reader,
  HybridBinarizer,
  MultiFormatReader,
  NotFoundException,
  RGBLuminanceSource,
} from "@zxing/library";
import { describe, expect, it } from "vitest";

import { buildScanHints } from "../../lib/vin/symbologies";
import {
  FrameLuminanceSource,
  ROI_HEIGHT_FRACTION,
  ROI_WIDTH_FRACTION,
  ScanFrameReader,
  readFrame,
  scanRegion,
} from "./frameReader";
import type { FrameRect, RgbaFrame } from "./frameReader";

/** §4.11's fixture VIN. */
const VIN = "1HGCM82633A004352";

/**
 * `Code39Reader`'s encoding tables, read off the library rather than restated. They are
 * `private static readonly` to TypeScript and ordinary statics at runtime; a symbology table
 * copied into a test is a second definition of a constant (§7 item 5) and would drift.
 */
const CODE_39 = Code39Reader as unknown as {
  ALPHABET_STRING: string;
  CHARACTER_ENCODINGS: number[];
  ASTERISK_ENCODING: number;
};

/** Module widths, in pixels. 3:1 is the ratio a door-jamb label is printed at. */
const NARROW = 2;
const WIDE = 6;
/** §4.6 needs a horizontal quiet zone; the bar height is arbitrary and generous. */
const QUIET = 24;
const BAR_HEIGHT = 48;

const BLACK = 0;
const WHITE = 255;

/** Element widths for `*text*`, nine per character plus the narrow inter-character gap. */
function code39Elements(text: string): number[] {
  const widths: number[] = [];
  for (const char of `*${text}*`) {
    const index = CODE_39.ALPHABET_STRING.indexOf(char);
    const pattern = char === "*" ? CODE_39.ASTERISK_ENCODING : CODE_39.CHARACTER_ENCODINGS[index];
    if (char !== "*" && index < 0) throw new Error(`not a Code 39 character: ${char}`);
    // The nine least significant bits, most significant first: 1 is a wide element.
    for (let i = 0; i < 9; i += 1) {
      widths.push(((pattern >> (8 - i)) & 1) === 1 ? WIDE : NARROW);
    }
    widths.push(NARROW);
  }
  return widths;
}

interface Gray {
  luminance: Uint8ClampedArray;
  width: number;
  height: number;
}

/** A horizontal Code 39 symbol on white, as luminance. */
function code39Image(text: string): Gray {
  const elements = code39Elements(text);
  const width = QUIET * 2 + elements.reduce((sum, w) => sum + w, 0);
  const row = new Uint8ClampedArray(width).fill(WHITE);
  let x = QUIET;
  for (let i = 0; i < elements.length; i += 1) {
    // Nine elements per character alternate bar, space, …, starting with a bar; the tenth is
    // the inter-character gap and is white, which the parity already gives.
    if (i % 2 === 0) row.fill(BLACK, x, x + elements[i]);
    x += elements[i];
  }
  const luminance = new Uint8ClampedArray(width * BAR_HEIGHT);
  for (let y = 0; y < BAR_HEIGHT; y += 1) luminance.set(row, y * width);
  return { luminance, width, height: BAR_HEIGHT };
}

/** A quarter turn clockwise — the frame a label held sideways produces. */
function rotateClockwise(image: Gray): Gray {
  const { luminance, width, height } = image;
  const rotated = new Uint8ClampedArray(luminance.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // dest is `height` wide: (x, y) -> (height - 1 - y, x)
      rotated[x * height + (height - 1 - y)] = luminance[y * width + x];
    }
  }
  return { luminance: rotated, width: height, height: width };
}

/** Grey RGBA, which is what a camera frame drawn to a canvas hands `getImageData`. */
function toRgba(image: Gray): RgbaFrame {
  const data = new Uint8ClampedArray(image.width * image.height * 4);
  for (let i = 0; i < image.luminance.length; i += 1) {
    data[i * 4] = image.luminance[i];
    data[i * 4 + 1] = image.luminance[i];
    data[i * 4 + 2] = image.luminance[i];
    data[i * 4 + 3] = 255;
  }
  return { data, width: image.width, height: image.height };
}

/**
 * A canvas with no DOM behind it: the two calls `readFrame` makes, and nothing else. The
 * `willReadFrequently` option is recorded so the test can prove it is asked for.
 */
function fakeCanvas(image: RgbaFrame, options: { throwOnOptions?: boolean } = {}) {
  const asked: unknown[] = [];
  const reads: FrameRect[] = [];
  return {
    asked,
    /** Every rectangle the reader asked for, in order — which pass looked where (SB-3). */
    reads,
    canvas: {
      width: image.width,
      height: image.height,
      getContext(_id: "2d", settings?: { willReadFrequently?: boolean }) {
        asked.push(settings);
        if (options.throwOnOptions === true && settings !== undefined) {
          throw new Error("this browser refuses the settings argument");
        }
        return {
          getImageData: (sx: number, sy: number, sw: number, sh: number): RgbaFrame => {
            reads.push({ left: sx, top: sy, width: sw, height: sh });
            const data = new Uint8ClampedArray(sw * sh * 4);
            for (let y = 0; y < sh; y += 1) {
              const from = ((sy + y) * image.width + sx) * 4;
              data.set(image.data.subarray(from, from + sw * 4), y * sw * 4);
            }
            return { data, width: sw, height: sh };
          },
        };
      },
    },
  };
}

/** The symbol centred on a white field of its own, the way a frame carries a label. */
function onWhite(image: Gray, width: number, height: number): Gray {
  const luminance = new Uint8ClampedArray(width * height).fill(WHITE);
  const left = Math.round((width - image.width) / 2);
  const top = Math.round((height - image.height) / 2);
  for (let y = 0; y < image.height; y += 1) {
    luminance.set(
      image.luminance.subarray(y * image.width, (y + 1) * image.width),
      (top + y) * width + left,
    );
  }
  return { luminance, width, height };
}

/** The §4.6 reader, built the way `useScanner` builds it. */
function reader(): ScanFrameReader {
  return new ScanFrameReader(buildScanHints());
}

describe("[R6-SA-1] a 1D symbol at 90° in the frame", () => {
  const upright = code39Image(VIN);
  const sideways = rotateClockwise(upright);

  it("reads through the app's per-frame call, which is what §4.6's TRY_HARDER promises", () => {
    const { canvas } = fakeCanvas(toRgba(sideways));

    const result = reader().decodeFromCanvas(canvas as unknown as HTMLCanvasElement);

    expect(result.getText()).toBe(VIN);
    expect(result.getBarcodeFormat()).toBe(BarcodeFormat.CODE_39);
  });

  it("misses on a luminance source that cannot rotate — the same pixels, the same hints", () => {
    // The control. `RGBLuminanceSource` answers isRotateSupported() with false, so
    // OneDReader never takes the retry branch and the frame reads as nothing at all. This is
    // what the app did, through a source that claimed it could rotate and then threw.
    const source = new RGBLuminanceSource(sideways.luminance, sideways.width, sideways.height);
    const bitmap = new BinaryBitmap(new HybridBinarizer(source));
    const multi = new MultiFormatReader();
    multi.setHints(buildScanHints());

    expect(() => multi.decodeWithState(bitmap)).toThrow(NotFoundException);
  });

  it("still reads the same symbol the right way up, so the frame is the only variable", () => {
    const { canvas } = fakeCanvas(toRgba(upright));

    expect(
      reader()
        .decodeFromCanvas(canvas as unknown as HTMLCanvasElement)
        .getText(),
    ).toBe(VIN);
  });
});

describe("FrameLuminanceSource — the rotation itself", () => {
  /**
   * Three columns, two rows, every pixel distinct, so a transpose in the wrong direction is
   * a different array rather than a plausible one.
   *
   *   1 2 3        3 6
   *   4 5 6   ->   2 5   (counter-clockwise: the right-hand column goes to the top)
   *                1 4
   */
  const source = new FrameLuminanceSource(new Uint8ClampedArray([1, 2, 3, 4, 5, 6]), 3, 2);

  it("rotates counter-clockwise, pixel for pixel", () => {
    const rotated = source.rotateCounterClockwise();

    expect(rotated.getWidth()).toBe(2);
    expect(rotated.getHeight()).toBe(3);
    expect([...rotated.getMatrix()]).toEqual([3, 6, 2, 5, 1, 4]);
  });

  it("says it can rotate, and then does — the pair R6-SA-1 found disagreeing", () => {
    expect(source.isRotateSupported()).toBe(true);
    expect(() => source.rotateCounterClockwise()).not.toThrow();
  });

  it("comes back to itself after four quarter turns", () => {
    const round = source
      .rotateCounterClockwise()
      .rotateCounterClockwise()
      .rotateCounterClockwise()
      .rotateCounterClockwise();

    expect(round.getWidth()).toBe(3);
    expect(round.getHeight()).toBe(2);
    expect([...round.getMatrix()]).toEqual([...source.getMatrix()]);
  });

  it("hands back rows, with and without a caller's buffer", () => {
    expect([...source.getRow(1)]).toEqual([4, 5, 6]);
    const row = new Uint8ClampedArray(3);
    expect(source.getRow(0, row)).toBe(row);
    expect([...row]).toEqual([1, 2, 3]);
    // A buffer that is too small is replaced rather than overflowed.
    expect([...source.getRow(0, new Uint8ClampedArray(1))]).toEqual([1, 2, 3]);
  });

  it("refuses a row outside the image rather than reading someone else's pixels", () => {
    expect(() => source.getRow(-1)).toThrow();
    expect(() => source.getRow(2)).toThrow();
  });

  it("crops to a sub-rectangle, because it says it can", () => {
    expect(source.isCropSupported()).toBe(true);
    const cropped = source.crop(1, 0, 2, 2);

    expect(cropped.getWidth()).toBe(2);
    expect(cropped.getHeight()).toBe(2);
    expect([...cropped.getMatrix()]).toEqual([2, 3, 5, 6]);
  });

  it("inverts", () => {
    expect([...source.invert().getMatrix()]).toEqual([254, 253, 252, 251, 250, 249]);
  });

  it("refuses the 45° rotation it does not implement, rather than claiming it", () => {
    // Recorded rather than incidental: nothing in @zxing/library calls this — only
    // BinaryBitmap exposes it, and no reader on the §4.6 list uses it — so implementing a
    // resampler here would be unreachable code. The 90° rotation is the one OneDReader takes.
    expect(() => source.rotateCounterClockwise45()).toThrow();
  });
});

describe("readFrame — the pixels come off the canvas the app draws", () => {
  const image = toRgba(code39Image(VIN));

  it("asks for a software-backed context, which is what the binarizer reads", () => {
    const { canvas, asked } = fakeCanvas(image);

    readFrame(canvas);

    expect(asked[0]).toEqual({ willReadFrequently: true });
  });

  it("falls back for a browser that refuses the settings argument", () => {
    const { canvas, asked } = fakeCanvas(image, { throwOnOptions: true });

    const frame = readFrame(canvas);

    expect(asked).toEqual([{ willReadFrequently: true }, undefined]);
    expect(frame.width).toBe(image.width);
  });

  it("fails loudly when there is no 2d context at all", () => {
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => null,
    };

    expect(() => readFrame(canvas)).toThrow(/2d context/);
  });
});

describe("[SB-3] §9-S1's ROI band — the decoder looks where the guide box points", () => {
  const symbol = code39Image(VIN);

  it("takes a centred band, 90% x 40%, from the frame §6.3 asks the camera for", () => {
    // 1920x1080 is §6.3's `ideal`, and what @zxing/browser sizes its capture canvas to.
    expect(scanRegion(1920, 1080)).toEqual({ left: 96, top: 324, width: 1728, height: 432 });
    expect(ROI_WIDTH_FRACTION).toBe(0.9);
    expect(ROI_HEIGHT_FRACTION).toBe(0.4);
  });

  it("contains §6.1's drawn guide box in both preview aspects, which is why 40% and not 22%", () => {
    // §6.1 draws `w-[90%] h-[22%]` over an `object-cover` preview, so the box maps onto the
    // frame through the preview's aspect. Portrait 3:4 shows the middle 42.2% of a 16:9
    // frame; landscape 16:9 shows all of it. The band must contain the box in both.
    const band = scanRegion(1920, 1080);
    if (band === null) throw new Error("1920x1080 has a band");
    for (const previewAspect of [3 / 4, 1920 / 1080]) {
      const visibleWidth = Math.min(1920, 1080 * previewAspect);
      const visibleHeight = Math.min(1080, 1920 / previewAspect);
      const boxWidth = visibleWidth * 0.9;
      const boxHeight = visibleHeight * 0.22;

      expect(boxWidth).toBeLessThanOrEqual(band.width);
      expect(boxHeight).toBeLessThanOrEqual(band.height);
    }
  });

  it("refuses a band a frame is too small to give, rather than a zero-pixel read", () => {
    // getImageData throws on a zero width or height, and a scan must never end on a frame
    // that arrives before the video has a size (N1).
    expect(scanRegion(0, 0)).toBeNull();
    expect(scanRegion(1920, 1)).toBeNull();
    expect(scanRegion(0, 1080)).toBeNull();
    // One pixel each way is a band, and a legal read: the guard is against zero, not small.
    expect(scanRegion(4, 2)).toEqual({ left: 0, top: 1, width: 4, height: 1 });
  });

  it("decodes a label inside the band without ever reading the rest of the frame", () => {
    const framed = onWhite(symbol, 800, 400);
    const { canvas, reads } = fakeCanvas(toRgba(framed));

    const result = reader().decodeFromCanvas(canvas as unknown as HTMLCanvasElement);

    expect(result.getText()).toBe(VIN);
    // One read, and it is the band: the 320,000 pixels outside it were never binarised.
    expect(reads).toEqual([{ left: 40, top: 120, width: 720, height: 160 }]);
  });

  it("still reads a label the band clips, because the band is a first look and not a fence", () => {
    // The §9-S3 case, and the field one: a handoff QR held close, or a label aimed wide,
    // overflows a 90% x 40% band. Cropping *instead of* the frame would lose it — and would
    // be a regression in a shipped slice, which N1 and §7 item 3 both forbid.
    const framed = onWhite(symbol, 660, 400);
    const { canvas, reads } = fakeCanvas(toRgba(framed));

    const result = reader().decodeFromCanvas(canvas as unknown as HTMLCanvasElement);

    expect(result.getText()).toBe(VIN);
    expect(reads).toEqual([
      { left: 33, top: 120, width: 594, height: 160 },
      { left: 0, top: 0, width: 660, height: 400 },
    ]);
  });

  it("reports the frame's own miss, not the band's, when neither finds anything", () => {
    const blank = onWhite({ luminance: new Uint8ClampedArray(0), width: 0, height: 0 }, 400, 300);
    const { canvas, reads } = fakeCanvas(toRgba(blank));

    expect(() => reader().decodeFromCanvas(canvas as unknown as HTMLCanvasElement)).toThrow(
      NotFoundException,
    );
    expect(reads).toHaveLength(2);
  });
});
