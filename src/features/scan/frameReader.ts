/**
 * The frame the scanner hands ZXing, and the luminance source it reads it through.
 *
 * **Why this file exists (R6-SA-1).** §4.6 sets `TRY_HARDER = true`, and half of it was
 * inert in the running app. `@zxing/browser` 0.2.1 builds its bitmap from
 * `HTMLCanvasElementLuminanceSource`, whose constructor never assigns `tempCanvasElement`;
 * `getTempCanvasElement()` then tests `null === this.tempCanvasElement` against `undefined`,
 * returns `undefined`, and `rotate()` throws `Error: Could not create a Canvas element.`
 * (`common/HTMLCanvasElementLuminanceSource.js:111-125`). `isRotateSupported()` answers
 * `true` regardless (:98), so `OneDReader.decode` took the 90° retry branch on every
 * horizontal miss (`core/oned/OneDReader.js:44-47`) and the throw — not a `ReaderException`
 * — escaped into `MultiFormatReader.decodeInternal`'s per-reader catch, which `console.warn`s
 * and moves on. Net: a 1D symbol at 90°/270° in the frame never read, and every miss frame
 * logged. §9-S1 permits a decode optimisation inside this slice, and this is the smallest
 * one that makes the §4.6 hint mean what it says: a luminance source that can genuinely
 * rotate, on the same `decodeWithState` call the app already made.
 *
 * **And the ROI band (SB-3).** §9-S1 allows the frame to be cropped to the guide box before
 * decoding. The band is taken *first* and the whole frame *second*, never instead of it, so
 * no symbol that decodes today can stop decoding because the user aimed wide or held a
 * §9-S3 handoff QR close enough to overflow the band. See `ROI_WIDTH_FRACTION`.
 *
 * `ScanFrameReader` overrides one instance method, `decodeFromCanvas`, which is the call
 * `BrowserCodeReader.prototype.scan` makes on every frame
 * (`readers/BrowserCodeReader.js:1119-1120`). Everything else — the hints, the binarizer,
 * `decodeWithState`, the scan loop, the capture canvas — is untouched.
 *
 * No React and no app state: this is the decoder boundary, and the §13.4 bench imports it so
 * that what the bench measures stays the app's decode path (SB-2, §7 item 5).
 */

import { BrowserMultiFormatReader } from "@zxing/browser";
import {
  BinaryBitmap,
  HybridBinarizer,
  IllegalArgumentException,
  InvertedLuminanceSource,
  LuminanceSource,
} from "@zxing/library";
import type { Result } from "@zxing/library";

/** The three fields this reads off `getImageData`, so a test can supply a frame with no DOM. */
export interface RgbaFrame {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** The two calls this makes on a canvas. `HTMLCanvasElement` satisfies it. */
export interface FrameCanvas {
  readonly width: number;
  readonly height: number;
  getContext(
    id: "2d",
    settings?: { willReadFrequently?: boolean },
  ): { getImageData(sx: number, sy: number, sw: number, sh: number): RgbaFrame } | null;
}

/** A sub-rectangle of a frame, in frame pixels. */
export interface FrameRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * §9-S1's ROI band: "crop the video frame to the guide box on a canvas before decoding
 * (optimization is allowed inside this slice; report it)". Reported in SB-3 and SB-10.
 *
 * **Width is §6.1's, height is not, and that is the whole finding.** §6.1 draws the guide box
 * at `w-[90%] h-[22%]` (`CameraView.tsx`), and cropping to the box *as drawn* is catastrophic
 * for 2D: at 1080 px tall it is a 238 px band, a label-realistic Data Matrix or QR is
 * ~480–500 px tall, and `data_matrix` clean goes 100% → **0%**, `qr_code` clean 95% → **0%**
 * (SB-3). The 40% band is the one that was measured to help — `code_128` severe +6.0 pp,
 * `code_39` +4.0, `code_39_i` +5.0 over 800 frames per layout, 33 frames recovered and **0
 * lost** (SB-10) — and it contains the drawn box rather than replacing it, so §6.1's constant
 * is untouched and the box the user aims at is inside the region the decoder reads first.
 *
 * The containment is arithmetic, not assertion. The preview is `object-cover`, so the frame
 * is cropped to the preview's aspect before the box is drawn over it. On a 390×844 phone the
 * preview is 3:4 and shows the middle 42% of a 1920×1080 frame, so the drawn box maps to
 * 38% × 22% of the frame — well inside 90% × 40%. In landscape the preview is 16:9 and the
 * box maps to the full 90% × 11%, which is the band's own width. There is no layout where
 * the box escapes the band.
 */
export const ROI_WIDTH_FRACTION = 0.9;
export const ROI_HEIGHT_FRACTION = 0.4;

/**
 * The band to look in first, or `null` for a frame too small to give one — a crop of zero
 * width or height is what `getImageData` throws on, and a frame that arrives before the
 * video has a size must not be the thing that ends a scan (N1).
 */
export function scanRegion(width: number, height: number): FrameRect | null {
  const bandWidth = Math.round(width * ROI_WIDTH_FRACTION);
  const bandHeight = Math.round(height * ROI_HEIGHT_FRACTION);
  if (bandWidth < 1 || bandHeight < 1) return null;
  return {
    left: Math.round((width - bandWidth) / 2),
    top: Math.round((height - bandHeight) / 2),
    width: bandWidth,
    height: bandHeight,
  };
}

/**
 * RGBA to luminance, byte for byte what `HTMLCanvasElementLuminanceSource.toGrayscaleBuffer`
 * computes — the weights are ZXing's own approximation of BT.601
 * (`(306R + 601G + 117B + 512) >> 10`), and a fully transparent pixel is white because it is
 * the "paper" of an alpha-carrying image.
 *
 * Restated here rather than imported because the class that owns it is the one being
 * replaced, and it is a static private of a library class. Keeping the arithmetic identical
 * is the point: the buffer this produces is the buffer the app decoded before, so the only
 * behavioural change from R6-SA-1 is that the rotated retry now happens.
 */
export function toLuminance(image: RgbaFrame): Uint8ClampedArray {
  const { data, width, height } = image;
  const luminance = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; j < luminance.length; i += 4, j += 1) {
    luminance[j] =
      data[i + 3] === 0
        ? 0xff
        : (306 * data[i] + 601 * data[i + 1] + 117 * data[i + 2] + 0x200) >> 10;
  }
  return luminance;
}

/**
 * A luminance source over a grayscale buffer that can rotate and crop, both by array
 * arithmetic — no second canvas, so nothing here can fail the way the source it replaces
 * does, and none of it depends on a DOM.
 */
export class FrameLuminanceSource extends LuminanceSource {
  private readonly luminance: Uint8ClampedArray;

  constructor(luminance: Uint8ClampedArray, width: number, height: number) {
    super(width, height);
    this.luminance = luminance;
  }

  static fromImage(image: RgbaFrame): FrameLuminanceSource {
    return new FrameLuminanceSource(toLuminance(image), image.width, image.height);
  }

  getRow(y: number, row?: Uint8ClampedArray): Uint8ClampedArray {
    if (y < 0 || y >= this.getHeight()) {
      throw new IllegalArgumentException(`Requested row is outside the image: ${y}`);
    }
    const width = this.getWidth();
    const start = y * width;
    // ZXing's contract: the caller's buffer is filled when it is big enough, and ignored
    // when it is not — "always use the returned object".
    if (row === undefined || row.length < width) {
      return this.luminance.slice(start, start + width);
    }
    row.set(this.luminance.slice(start, start + width));
    return row;
  }

  getMatrix(): Uint8ClampedArray {
    return this.luminance;
  }

  override isCropSupported(): boolean {
    return true;
  }

  override crop(left: number, top: number, width: number, height: number): LuminanceSource {
    const cropped = new Uint8ClampedArray(width * height);
    for (let y = 0; y < height; y += 1) {
      const from = (top + y) * this.getWidth() + left;
      cropped.set(this.luminance.subarray(from, from + width), y * width);
    }
    return new FrameLuminanceSource(cropped, width, height);
  }

  override isRotateSupported(): boolean {
    return true;
  }

  /**
   * A quarter turn counter-clockwise, which is what `OneDReader` asks for under §4.6's
   * `TRY_HARDER`: the right-hand column of the source becomes the top row of the result, so
   * `dest(x, y) = src(width - 1 - y, x)`.
   */
  override rotateCounterClockwise(): LuminanceSource {
    const width = this.getWidth();
    const height = this.getHeight();
    const rotated = new Uint8ClampedArray(this.luminance.length);
    for (let y = 0; y < width; y += 1) {
      for (let x = 0; x < height; x += 1) {
        rotated[y * height + x] = this.luminance[x * width + (width - 1 - y)];
      }
    }
    return new FrameLuminanceSource(rotated, height, width);
  }

  invert(): LuminanceSource {
    return new InvertedLuminanceSource(this);
  }
}

/**
 * The frame's pixels, off the canvas `@zxing/browser` drew the video onto.
 *
 * `willReadFrequently` selects a software-backed canvas — the same thing `@zxing/browser`
 * asks for on the capture canvas and inside its own luminance source — and it is asked for
 * in a `try` for the same reason the library does: a browser that refuses the settings
 * argument must degrade to a working scan rather than end it (P7).
 */
export function readFrame(canvas: FrameCanvas, region?: FrameRect): RgbaFrame {
  let context;
  try {
    context = canvas.getContext("2d", { willReadFrequently: true });
  } catch {
    context = canvas.getContext("2d");
  }
  if (context === null || context === undefined) {
    throw new Error("The scan frame has no 2d context to read.");
  }
  const rect = region ?? { left: 0, top: 0, width: canvas.width, height: canvas.height };
  return context.getImageData(rect.left, rect.top, rect.width, rect.height);
}

/** The binary bitmap one frame becomes, through a source that can do what it claims. */
export function frameBitmap(canvas: FrameCanvas, region?: FrameRect): BinaryBitmap {
  const image = readFrame(canvas, region);
  return new BinaryBitmap(new HybridBinarizer(FrameLuminanceSource.fromImage(image)));
}

/**
 * The app's reader: `BrowserMultiFormatReader` with §4.6's hints, reading each frame through
 * `FrameLuminanceSource` instead of `HTMLCanvasElementLuminanceSource` (R6-SA-1), and
 * looking inside §6.1's guide box before it looks at the whole frame (SB-3).
 *
 * `decodeBitmap` is not touched, so the decode is still `MultiFormatReader.decodeWithState`
 * with the constructor's hints — the whole change is what the bitmap is built over.
 */
export class ScanFrameReader extends BrowserMultiFormatReader {
  override decodeFromCanvas(canvas: HTMLCanvasElement): Result {
    const region = scanRegion(canvas.width, canvas.height);
    if (region !== null) {
      try {
        return this.decodeBitmap(frameBitmap(canvas, region));
      } catch {
        // Nothing is swallowed here: the band is a first look, and the frame below reports
        // whatever it finds — a `Result`, or the same NotFoundException the caller would
        // have seen anyway (P7). Catching everything rather than only the reader exceptions
        // is deliberate: a fault peculiar to the band (a getImageData that a browser
        // refuses on a sub-rectangle, say) must not be the thing that ends a working scan
        // loop, and if it is not peculiar to the band the full frame raises it too.
      }
    }
    return this.decodeBitmap(frameBitmap(canvas));
  }
}
