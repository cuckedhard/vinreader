/**
 * The crop box: where on the frame the engine is allowed to look.
 *
 * This is the whole engineering problem of layer 2, and S5 addendum §5 states the finding
 * that decides it. A door-jamb label is dense with tyre pressures, GVWR, dates and the
 * digits under a barcode. Full-frame OCR plus a cross-manufacturer regex **fabricates**:
 * Ford's two letters (`UG`) and GM's four digits (`8555`) cannot be told apart from a PSI
 * or a date token on the same sticker by any pattern, and N2 says a paint code has no
 * check digit, no grammar and no downstream lookup, so a fabricated one is never
 * contradicted by anything. Template matching per manufacturer is the other way to lose:
 * it goes stale every model year and fails silently.
 *
 * So the box is aligned by the person holding the phone, and it is a generous single
 * *line* — wide enough to cover a code and nothing above or below it, tall enough for a
 * gloved hand to put it on one. What is inside it is what the engine reads.
 *
 * **This is not §6.1's barcode guide box.** That one is ~90% × 22% because its target is a
 * 1D barcode, and [SB-3] measured what happens when a band of that shape is handed to a
 * decoder: 238 px of frame, and `data_matrix` fell from 100% clean to 0%. Different job,
 * different box, and the two must not be shared or "unified" later.
 *
 * Pure: sizes and rectangles in, a rectangle out. Nothing here touches a canvas, an
 * element or a stream.
 */
import { PAINT_BOX_HEIGHT_FRACTION, PAINT_BOX_WIDTH_FRACTION } from "./constants";

export interface Size {
  width: number;
  height: number;
}

/** A rectangle in whatever space its arguments were in; never a mix of two. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The box as a share of the preview, before CSS floors its height at `--tap`.
 *
 * These are the nominal fractions and not the measurement anything crops by: the rendered
 * box is read back from the element at capture time, because a `min-height` that wins the
 * cascade would otherwise crop a band the user never aimed with (F1-a's lesson, applied
 * before it can happen again).
 */
export const PAINT_CROP_BOX = {
  width: PAINT_BOX_WIDTH_FRACTION,
  height: PAINT_BOX_HEIGHT_FRACTION,
} as const;

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * The scale `object-fit: cover` paints the frame at: the larger of the two ratios, so the
 * element is filled and the overflow is cropped evenly on the axis that has any.
 */
export function coverScale(displayed: Size, source: Size): number {
  return Math.max(displayed.width / source.width, displayed.height / source.height);
}

/**
 * The box the user aligned, in element pixels, expressed in frame pixels.
 *
 * The preview is `object-cover`, so the element shows a centred crop of the frame and the
 * mapping is not a plain ratio — getting it wrong crops a band next to the one on screen,
 * which is the failure mode that reads a tyre pressure and calls it a paint code (N2).
 *
 * Rounded outward, then clamped inside the frame: a crop one pixel short of the box is a
 * glyph clipped down its edge, and `drawImage` with a source rectangle that leaves the
 * frame samples transparent black. `null` is returned rather than a guess wherever any
 * input is degenerate — a frame with no dimensions yet is the ordinary state of a `<video>`
 * for the first moments of a stream.
 */
export function displayedToSourceRect(box: Rect, displayed: Size, source: Size): Rect | null {
  if (!positive(displayed.width) || !positive(displayed.height)) return null;
  if (!positive(source.width) || !positive(source.height)) return null;
  if (!positive(box.width) || !positive(box.height)) return null;
  if (!Number.isFinite(box.left) || !Number.isFinite(box.top)) return null;

  const scale = coverScale(displayed, source);
  const offsetX = (displayed.width - source.width * scale) / 2;
  const offsetY = (displayed.height - source.height * scale) / 2;

  const left = clamp(Math.floor((box.left - offsetX) / scale), 0, source.width - 1);
  const top = clamp(Math.floor((box.top - offsetY) / scale), 0, source.height - 1);
  const right = clamp(Math.ceil((box.left + box.width - offsetX) / scale), left + 1, source.width);
  const bottom = clamp(
    Math.ceil((box.top + box.height - offsetY) / scale),
    top + 1,
    source.height,
  );

  return { left, top, width: right - left, height: bottom - top };
}
