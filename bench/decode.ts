/**
 * §13.4 scan-robustness bench — the decoder under test.
 *
 * ZXing has no DOM here: `@zxing/browser`'s readers all want a `<video>` or a `<canvas>`,
 * so this file drives the same core `@zxing/library` pipeline the browser wrapper drives,
 * straight from a PNG buffer. sharp decodes the PNG to raw pixels, those are packed into
 * the `0xRRGGBB` `Int32Array` that `RGBLuminanceSource` expects, and the rest —
 * `HybridBinarizer` → `BinaryBitmap` → `MultiFormatReader` — is byte-for-byte what the app
 * runs.
 *
 * The hints come from `src/lib/vin/symbologies.ts` — the same §4.6 module the scanner builds
 * its reader from, imported rather than copied so there is no second list to drift (§7 item
 * 5). A bench that decoded with different hints than the app ships would measure the wrong
 * program.
 *
 * A `NotFoundException` is the normal negative result — most degraded frames simply do not
 * decode — so it returns `{ text: null, format: null, ms }` instead of throwing. Checksum
 * and format failures are the same kind of answer ("this frame carries no readable symbol")
 * and are treated identically. Anything else is a real fault and propagates, so the runner
 * can report it rather than silently scoring it as a miss.
 */

import type { Buffer } from "node:buffer";
import sharp from "sharp";
import {
  BarcodeFormat,
  BinaryBitmap,
  ChecksumException,
  FormatException,
  HybridBinarizer,
  MultiFormatReader,
  NotFoundException,
  RGBLuminanceSource,
} from "@zxing/library";
import type { Result } from "@zxing/library";
import { SCAN_FORMATS, buildScanHints } from "../src/lib/vin/symbologies";

export interface DecodeOutcome {
  /** Exactly what the decoder read, unnormalised. `null` when nothing decoded. */
  text: string | null;
  /** ZXing's `BarcodeFormat` name, e.g. `"CODE_39"`. `null` when nothing decoded. */
  format: string | null;
  /** Wall time of the ZXing pipeline in milliseconds — see `decodeImage`. */
  ms: number;
}

/** Human-readable §4.6 list, for the report header. The app's list, in the app's order. */
export const BENCH_FORMAT_NAMES: readonly string[] = SCAN_FORMATS.map(
  (format) => BarcodeFormat[format],
);

const HINTS = buildScanHints();

/**
 * One reader for the whole run. `MultiFormatReader.decode` is fully synchronous and
 * re-applies the hints on every call, so nothing can interleave with it even though callers
 * are async — and reusing it keeps the timing numbers free of per-call allocation noise.
 */
const READER = new MultiFormatReader();

/** Alpha is composited onto the label's white surround, never onto black. */
const WHITE = { r: 255, g: 255, b: 255 };

/** ZXing's own names for "this frame carries no symbol I can read". */
const NO_READ_KINDS: ReadonlySet<string> = new Set([
  NotFoundException.kind,
  ChecksumException.kind,
  FormatException.kind,
]);

/**
 * A reader exception is an answer, not a fault: the frame carries no symbol this
 * configuration can read.
 *
 * `getKind()` is checked before `instanceof` deliberately. `@zxing/library` is shipped as
 * ES5-downlevelled classes over `ts-custom-error`, and its `Exception` prototype chain does
 * not survive that: `MultiFormatReader` itself logs "non-ReaderException from reader" for
 * every ordinary `NotFoundException` a sub-reader raises, because its own
 * `ex instanceof ReaderException` is false. Leaf `instanceof` happens to hold today, but a
 * gate must not rest on that — a broken check here would turn every honest miss into a
 * decoder fault and fail the bench for nothing. The static `kind` is the library's own
 * discriminator and is immune to it.
 */
function isNoRead(error: unknown): boolean {
  const kind = (error as { getKind?: () => string } | null)?.getKind;
  if (typeof kind === "function") return NO_READ_KINDS.has(kind.call(error));
  return (
    error instanceof NotFoundException ||
    error instanceof ChecksumException ||
    error instanceof FormatException
  );
}

/**
 * `MultiFormatReader` warns once per sub-reader per frame (see above), which is three or
 * four lines of noise for every image in a 3000-image run and buries the runner's progress.
 * The warnings say nothing the outcome does not: a Data Matrix reader declining a Code 39
 * image is the normal case. They are counted rather than merely dropped, so the report can
 * state how much was swallowed, and the patch is installed and removed around a single
 * synchronous `decode` call, so it can never leak into another task.
 */
const READER_NOISE = "MultiFormatReader: non-ReaderException from reader:";

let suppressed = 0;

/** How many ZXing per-reader warnings this process swallowed. Reported, never hidden. */
export function suppressedWarnings(): number {
  return suppressed;
}

function decodeQuietly(bitmap: BinaryBitmap): Result {
  const warn = console.warn;
  console.warn = (...args: unknown[]): void => {
    if (args.length > 0 && args[0] === READER_NOISE) {
      suppressed += 1;
      return;
    }
    warn(...args);
  };
  try {
    return READER.decode(bitmap, HINTS);
  } finally {
    console.warn = warn;
  }
}

/**
 * Raw pixels to the ARGB-style `Int32Array` `RGBLuminanceSource` documents. It derives
 * luminance itself with ZXing's green-favouring average, so packing the channels back
 * verbatim keeps this file out of the luminance business entirely.
 */
function packPixels(data: Uint8Array, width: number, height: number, channels: number): Int32Array {
  const pixels = new Int32Array(width * height);
  if (channels === 1) {
    for (let i = 0; i < pixels.length; i += 1) {
      const v = data[i];
      pixels[i] = (v << 16) | (v << 8) | v;
    }
    return pixels;
  }
  for (let i = 0; i < pixels.length; i += 1) {
    const at = i * channels;
    pixels[i] = (data[at] << 16) | (data[at + 1] << 8) | data[at + 2];
  }
  return pixels;
}

/**
 * Decode one PNG with the app's §4.6 configuration.
 *
 * `ms` times the ZXing pipeline only — luminance packing, binarisation and the read — and
 * deliberately excludes sharp's PNG decode, because the app never decodes a PNG: it hands
 * ZXing pixels that already exist in a canvas. Timing the PNG parse would measure the
 * bench's own scaffolding and inflate every number in the report.
 */
export async function decodeImage(png: Buffer): Promise<DecodeOutcome> {
  const { data, info } = await sharp(png)
    .flatten({ background: WHITE })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const started = performance.now();
  const pixels = packPixels(data, info.width, info.height, info.channels);
  const source = new RGBLuminanceSource(pixels, info.width, info.height);
  const bitmap = new BinaryBitmap(new HybridBinarizer(source));

  try {
    const result = decodeQuietly(bitmap);
    const ms = performance.now() - started;
    return { text: result.getText(), format: BarcodeFormat[result.getBarcodeFormat()], ms };
  } catch (error) {
    const ms = performance.now() - started;
    if (isNoRead(error)) return { text: null, format: null, ms };
    throw error;
  }
}
