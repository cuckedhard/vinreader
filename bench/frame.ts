/**
 * §13.4 scan-robustness bench — **the frame the app's decoder is actually handed** (SB-2).
 *
 * `useScanner` calls `decodeFromStream`, and `@zxing/browser` draws the whole `<video>`
 * element onto its capture canvas at `videoWidth × videoHeight`. §6.3 asks the camera for
 * `{ width: { ideal: 1920 }, height: { ideal: 1080 } }`, so on a phone that honours the
 * constraint the decoder sees a 1920×1080 field with the symbol as a band across it — never
 * the tight crop this bench used to hand it, a ~1050 px symbol in a ~1100 px image.
 *
 * The difference is not cosmetic: measured on identical symbol pixels it is up to 35 pp
 * (code_128 severe 62.5% → 27.5%), and it is optimistic in the direction that matters, so
 * every §13.6 margin measured on the crop was a margin on an easier problem than the app
 * solves. This module is the one definition of that field, imported by `run.ts` — which
 * composites every frame before any instrument reads it — and by `frame-probe.ts`, which
 * measured the gap in the first place. One definition, so the bench and the probe that
 * justified it can never drift apart.
 *
 * **The symbol is never resampled.** `composite` centres the degraded PNG on a white field
 * at 1:1; the pixels ZXing reads inside the symbol's bounding box are byte-identical to the
 * ones the crop layout hands it. The only variable between the two layouts is the field
 * around the symbol, which is what makes the delta attributable.
 */

import type { Buffer } from "node:buffer";
import sharp from "sharp";

/**
 * §6.3's `ideal` capture size, which is what `@zxing/browser` sizes its capture canvas from.
 * A phone that gives less makes the symbol a *larger* fraction of the frame, so this is the
 * conservative choice among the sizes a camera might hand over.
 */
export const FRAME_WIDTH = 1920;
export const FRAME_HEIGHT = 1080;

/**
 * §6.1's guide box, as a fraction of the preview: `w-[90%] h-[22%]` in `CameraView.tsx:92`.
 * Exported so that any ROI experiment uses the box the user is actually aimed at rather than
 * a number someone liked. **Read SB-3 before cropping to it**: at 1080 px tall the drawn box
 * is a 238 px band, and a label-realistic Data Matrix or QR is ~480–500 px tall, so cropping
 * to the box *as drawn* takes 2D clean from 100%/95% to 0%/0%.
 */
export const GUIDE_WIDTH_FRACTION = 0.9;
export const GUIDE_HEIGHT_FRACTION = 0.22;

/**
 * The band SB-3 measured as the one that helps: same width, 40% of the height (432 px), tall
 * enough for a 2D symbol and for a ±15° roll on a 5.5:1 label.
 */
export const TALL_GUIDE_HEIGHT_FRACTION = 0.4;

/**
 * White, because a certification label's surround is white and alpha composites onto it,
 * never onto black. It is a model of a field of view and not a photograph of one: a real
 * jamb is a darker, textured surround, and a white field is the *easier* of the two for a
 * row-histogram binariser, so the framed numbers remain a ceiling and not a floor.
 */
const WHITE = { r: 255, g: 255, b: 255 };

export interface Size {
  width: number;
  height: number;
}

export async function sizeOf(png: Buffer): Promise<Size> {
  const meta = await sharp(png).metadata();
  const { width, height } = meta;
  if (width === undefined || height === undefined) {
    throw new Error("bench/frame: sharp reported a PNG with no dimensions");
  }
  return { width, height };
}

/** A framed frame, and how much of it the symbol fills. */
export interface Framed {
  png: Buffer;
  /** Symbol width over frame width — in effect, how far away the label is. */
  fill: number;
  size: Size;
}

/**
 * Centre `png`, unscaled, on a white `FRAME_WIDTH × FRAME_HEIGHT` field.
 *
 * A symbol too large for the field is an error rather than a silent clip or a resize: a
 * clipped symbol would be measured as a hard frame instead of a harness fault, and a resized
 * one would break the one property that makes the layouts comparable.
 */
export async function composite(png: Buffer, known?: Size): Promise<Framed> {
  const size = known ?? (await sizeOf(png));
  if (size.width > FRAME_WIDTH || size.height > FRAME_HEIGHT) {
    throw new Error(
      `bench/frame: a ${size.width}x${size.height} symbol does not fit a ` +
        `${FRAME_WIDTH}x${FRAME_HEIGHT} frame`,
    );
  }
  const framed = await sharp({
    create: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: 3, background: WHITE },
  })
    .composite([
      {
        input: png,
        left: Math.round((FRAME_WIDTH - size.width) / 2),
        top: Math.round((FRAME_HEIGHT - size.height) / 2),
      },
    ])
    .png()
    .toBuffer();
  return { png: framed, fill: size.width / FRAME_WIDTH, size };
}

/** A centred band of a framed frame, in the fractions §6.1's guide box uses (SB-3). */
export async function cropBand(frame: Buffer, heightFraction: number): Promise<Buffer> {
  const width = Math.round(FRAME_WIDTH * GUIDE_WIDTH_FRACTION);
  const height = Math.round(FRAME_HEIGHT * heightFraction);
  return await sharp(frame)
    .extract({
      left: Math.round((FRAME_WIDTH - width) / 2),
      top: Math.round((FRAME_HEIGHT - height) / 2),
      width,
      height,
    })
    .png()
    .toBuffer();
}
