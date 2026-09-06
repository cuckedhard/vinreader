/**
 * Rectify → grayscale → bicubic upscale. In that order, and nothing else.
 *
 * Each step is S5 addendum §3's measurement rather than a preference, and one step that
 * is conspicuously absent is the reason this file has a comment at all:
 *
 * - **Rectify from the box.** The user aligned a line; the crop is that line's rectangle
 *   in frame pixels (`cropBox.ts`), drawn 1:1 into a canvas of its own. Nothing outside
 *   the box reaches the engine, which is what makes a `tessedit_char_whitelist` safe: on a
 *   full frame the whitelist would happily turn a GVWR row into letters and digits.
 * - **Grayscale.** BT.601 luma. Tesseract 4/5 recognise on grayscale and their models were
 *   trained on it, so this is the format the engine wants rather than a transformation of
 *   it, and doing it here is also what makes the ink band measurable below.
 * - **Bicubic upscale.** Resolution is the single biggest accuracy driver in every study
 *   the addendum found. The factor is chosen from the ink actually in the crop, not
 *   guessed from the box, and it never goes below 1: downscaling a crop that is already
 *   sharp throws away the only thing that was going right.
 *
 * **No binarisation.** It is the step everyone adds and it is documented as
 * counterproductive here: the LSTM models were trained on grayscale, and thresholding
 * ahead of them destroys the edge information they use. The ink band *is* measured with a
 * threshold — that measurement picks a scale factor and never touches a pixel the engine
 * sees.
 *
 * **No OpenCV.js.** 8.1 MB of WASM, on top of an engine that is already larger than the
 * app, for the few dozen lines below.
 *
 * Not pure — it draws — but every drawing surface arrives as an argument, so the whole
 * pipeline runs identically on an `OffscreenCanvas` in a worker and on a fake canvas in a
 * node test.
 */
import type { Rect } from "./cropBox";
import {
  OCR_DEFAULT_GLYPH_FRACTION,
  OCR_INK_BAND_MAX_SHARE,
  OCR_INK_LEVEL,
  OCR_INK_MIN_CONTRAST,
  OCR_INK_ROW_SHARE,
  OCR_MAX_CROP_PIXELS,
  OCR_MAX_UPSCALE,
  OCR_TARGET_GLYPH_PX,
} from "./constants";
import { OcrError } from "./types";

export interface ImageDataLike {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** The four calls this file makes on a 2D context, and no more. */
export interface Context2DLike {
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: "low" | "medium" | "high";
  drawImage(
    image: unknown,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): ImageDataLike;
  putImageData(image: ImageDataLike, dx: number, dy: number): void;
}

export interface CanvasLike {
  width: number;
  height: number;
  getContext(contextId: "2d"): Context2DLike | null;
}

export type CanvasFactory = (width: number, height: number) => CanvasLike;

export interface PreprocessDeps {
  createCanvas: CanvasFactory;
  /** The processed canvas, encoded. tesseract.js takes a `Blob` and decodes it worker-side. */
  encode: (canvas: CanvasLike) => Promise<Blob>;
}

/** Where the line of text sits in the crop, and whether that was measured or assumed. */
export interface InkBand {
  top: number;
  height: number;
  measured: boolean;
}

export interface PreprocessedCrop {
  blob: Blob;
  width: number;
  height: number;
  /** What the crop was multiplied by; 1 means it was already big enough. */
  scale: number;
  band: InkBand;
}

/** BT.601 luma, one byte per pixel, from RGBA. */
export function lumaOf(rgba: Uint8ClampedArray): Uint8Array {
  const pixels = Math.floor(rgba.length / 4);
  const luma = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    const at = i * 4;
    luma[i] = Math.round(0.299 * rgba[at] + 0.587 * rgba[at + 1] + 0.114 * rgba[at + 2]);
  }
  return luma;
}

/** The same buffer, painted grey. Opaque, because a crop with alpha in it is a crop of nothing. */
export function paintLuma(rgba: Uint8ClampedArray, luma: Uint8Array): void {
  for (let i = 0; i < luma.length; i += 1) {
    const at = i * 4;
    const value = luma[i];
    rgba[at] = value;
    rgba[at + 1] = value;
    rgba[at + 2] = value;
    rgba[at + 3] = 255;
  }
}

/**
 * The rows the line of text occupies, found by its own ink rather than by assuming a
 * share of the box.
 *
 * The background is the crop's modal level — a sticker is mostly sticker — so this works
 * on dark ink over a light label and on light ink over a dark one without being told
 * which. "Ink" is any pixel far enough from that level, where "far enough" is a share of
 * the largest deviation actually present, so a flat crop in bad light is not thresholded
 * against a grey that suits a studio.
 *
 * `measured: false` is a refusal, not a zero: a crop with almost no contrast, or one that
 * is ink from edge to edge, has no line in it to measure and the caller falls back to
 * assuming a share of the crop (P7 — the caller can see which happened).
 */
export function measureInkBand(luma: Uint8Array, width: number, height: number): InkBand {
  const assumed: InkBand = { top: 0, height, measured: false };
  if (width <= 0 || height <= 0 || luma.length < width * height) return assumed;

  const histogram = new Uint32Array(256);
  for (let i = 0; i < width * height; i += 1) histogram[luma[i]] += 1;
  let background = 0;
  for (let level = 1; level < 256; level += 1) {
    if (histogram[level] > histogram[background]) background = level;
  }

  let spread = 0;
  for (let level = 0; level < 256; level += 1) {
    if (histogram[level] > 0) spread = Math.max(spread, Math.abs(level - background));
  }
  if (spread < OCR_INK_MIN_CONTRAST) return assumed;

  const threshold = spread * OCR_INK_LEVEL;
  const rows = new Uint32Array(height);
  let peak = 0;
  let peakRow = 0;
  for (let y = 0; y < height; y += 1) {
    let count = 0;
    const start = y * width;
    for (let x = 0; x < width; x += 1) {
      if (Math.abs(luma[start + x] - background) >= threshold) count += 1;
    }
    rows[y] = count;
    if (count > peak) {
      peak = count;
      peakRow = y;
    }
  }
  // No `peak === 0` case: the contrast check above passed, so at least one pixel deviates
  // by `spread`, which is twice the threshold. A guard here would be a branch no input can
  // reach and no test could ever drive.
  const floor = peak * OCR_INK_ROW_SHARE;
  let top = peakRow;
  while (top > 0 && rows[top - 1] >= floor) top -= 1;
  let bottom = peakRow;
  while (bottom + 1 < height && rows[bottom + 1] >= floor) bottom += 1;

  const band = bottom - top + 1;
  // Ink from edge to edge is a photograph of something, not a line on a sticker.
  if (band >= height * OCR_INK_BAND_MAX_SHARE) return assumed;
  return { top, height: band, measured: true };
}

/** The factor that puts a glyph in the 20–30 px band. Never below 1: nothing is downscaled. */
export function upscaleFactor(band: InkBand, cropHeight: number): number {
  const glyph = band.measured ? band.height : cropHeight * OCR_DEFAULT_GLYPH_FRACTION;
  if (!(glyph > 0)) return 1;
  return Math.min(Math.max(OCR_TARGET_GLYPH_PX / glyph, 1), OCR_MAX_UPSCALE);
}

/** The same factor, held under the pixel ceiling. A crop already over it is left alone. */
export function capScale(scale: number, width: number, height: number): number {
  const area = width * height;
  if (!(area > 0)) return 1;
  return Math.max(1, Math.min(scale, Math.sqrt(OCR_MAX_CROP_PIXELS / area)));
}

function context(canvas: CanvasLike): Context2DLike {
  const ctx = canvas.getContext("2d");
  // P7: a canvas that hands back no context is not something to carry on past. It would
  // reach the engine as an empty image and come back as an empty proposal.
  if (ctx === null) throw new OcrError("engine_failed", "no 2d context for the crop");
  return ctx;
}

/**
 * One frame, cropped to the box the user aligned and prepared for the engine.
 *
 * `frame` is anything `drawImage` accepts — an `ImageBitmap` off the preview in practice.
 * It is typed as `unknown` here because the union differs between a window and a worker
 * and this file runs in both.
 */
export async function preprocessCrop(
  frame: unknown,
  rect: Rect,
  deps: PreprocessDeps,
): Promise<PreprocessedCrop> {
  const flat = deps.createCanvas(rect.width, rect.height);
  const flatCtx = context(flat);
  flatCtx.imageSmoothingEnabled = true;
  flatCtx.imageSmoothingQuality = "high";
  flatCtx.drawImage(
    frame,
    rect.left,
    rect.top,
    rect.width,
    rect.height,
    0,
    0,
    rect.width,
    rect.height,
  );

  const image = flatCtx.getImageData(0, 0, rect.width, rect.height);
  const luma = lumaOf(image.data);
  paintLuma(image.data, luma);
  flatCtx.putImageData(image, 0, 0);

  const band = measureInkBand(luma, image.width, image.height);
  const scale = capScale(upscaleFactor(band, image.height), image.width, image.height);
  if (scale === 1) {
    return { blob: await deps.encode(flat), width: image.width, height: image.height, scale, band };
  }

  const width = Math.round(image.width * scale);
  const height = Math.round(image.height * scale);
  const big = deps.createCanvas(width, height);
  const bigCtx = context(big);
  bigCtx.imageSmoothingEnabled = true;
  bigCtx.imageSmoothingQuality = "high";
  bigCtx.drawImage(flat, 0, 0, image.width, image.height, 0, 0, width, height);
  return { blob: await deps.encode(big), width, height, scale, band };
}
