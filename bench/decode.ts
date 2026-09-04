/**
 * §13.4 scan-robustness bench — the `rgb` decode path.
 *
 * **This is not the app's decoder.** It decodes a PNG in node through
 * `RGBLuminanceSource` → `HybridBinarizer` → `MultiFormatReader.decode`, which is a
 * different luminance source, a different `isRotateSupported()` answer and a different
 * entry point than `BrowserMultiFormatReader` uses on a canvas. It is kept, and named
 * `rgb`, as the *control*: `browser-entry.ts` runs the shipped path, and the report's delta
 * table is the difference between the two on identical frames — the size of the error every
 * bench number carried while this file was the only instrument (finding B2).
 *
 * The hints come from `src/lib/vin/symbologies.ts` — the same §4.6 module the scanner builds
 * its reader from, imported rather than copied so there is no second list to drift (§7 item
 * 5). Both paths share it, so the delta measures the *pixels-to-decoder* plumbing and
 * nothing else.
 *
 * A `NotFoundException` is the normal negative result — most degraded frames simply do not
 * decode — so it returns `{ text: null, ... }` instead of throwing. Checksum and format
 * failures are the same kind of answer ("this frame carries no readable symbol") and are
 * treated identically. Anything else is a real fault and comes back in `fault`, so the
 * runner reports it rather than silently scoring it as a miss.
 */

import type { Buffer } from "node:buffer";
import sharp from "sharp";
import {
  BarcodeFormat,
  BinaryBitmap,
  ChecksumException,
  DecodeHintType,
  FormatException,
  HybridBinarizer,
  MultiFormatReader,
  NotFoundException,
  RGBLuminanceSource,
} from "@zxing/library";
import type { Result } from "@zxing/library";
import { SCAN_FORMATS, buildScanHints, stripAimIdentifier } from "../src/lib/vin/symbologies";

export interface DecodeOutcome {
  /**
   * The label's own bytes, exactly as the app's scan path sees them: what the decoder read,
   * less the AIM symbology identifier ZXing prepends to its own result
   * (`stripAimIdentifier`, §4.6). Nothing else is normalised — §4.2 does the rest.
   * `null` when nothing decoded.
   */
  text: string | null;
  /**
   * Whether `stripAimIdentifier` actually removed a `]C1` (§4.6). Counted rather than
   * assumed: the app strips it in `readScanResult` and the bench strips it here, and a
   * count in the report is what would show if the two ever stopped agreeing. On the present
   * corpus it is zero — no rendered row carries a *leading* FNC1 — so the strip is inert
   * here and the rates below do not depend on it.
   */
  aimStripped: boolean;
  /** ZXing's `BarcodeFormat` name, e.g. `"CODE_39"`. `null` when nothing decoded. */
  format: string | null;
  /** Wall time of the ZXing pipeline in milliseconds — see `decodeImage`. */
  ms: number;
  /**
   * A decoder fault — neither a hit nor an honest miss, but the bench failing to measure the
   * frame at all. `null` on every ordinary outcome. Both decode paths report faults this way
   * so a single bad frame cannot take a whole batch down with it.
   */
  fault: string | null;
}

/**
 * The instruments this bench can read the corpus with. `canvas` is the app's; the other two
 * exist to bound it.
 */
export type DecodePath = "canvas" | "yuv" | "rgb";

/** Canonical order. The first selected path is the one the report's verdict comes from. */
export const DECODE_PATHS: readonly DecodePath[] = ["canvas", "yuv", "rgb"];

/** One line each, printed in the report header, so no run can misdescribe its own instrument. */
export const DECODE_PATH_NOTES: Readonly<Record<DecodePath, string>> = {
  canvas:
    "the app's path — Chromium, `BrowserMultiFormatReader.decodeFromCanvas`, " +
    "`HTMLCanvasElementLuminanceSource`, `decodeWithState`",
  yuv:
    "`canvas`, with the frame first put through a **modelled** BT.601 studio-swing I420 round " +
    "trip — the colour half of a camera capture, not a camera",
  rgb: "node, `RGBLuminanceSource` + `MultiFormatReader.decode` — the control, not the app",
};

/** Human-readable §4.6 list, for the report header. The app's list, in the app's order. */
export const BENCH_FORMAT_NAMES: readonly string[] = SCAN_FORMATS.map(
  (format) => BarcodeFormat[format],
);

const HINTS = buildScanHints();

/**
 * The non-format hints this run actually decoded with, named from the live map rather than
 * described in prose, so the report can never claim a configuration the run did not use.
 * The header hard-coded "TRY_HARDER" through R1–R4 and would have gone on saying exactly
 * that after §4.6 gained `ASSUME_GS1` — a bench whose header misstates its own hints is
 * how a decode rate gets attributed to the wrong program.
 */
export const BENCH_HINT_NAMES: readonly string[] = [...HINTS.keys()]
  .filter((hint) => hint !== DecodeHintType.POSSIBLE_FORMATS)
  .map((hint) => DecodeHintType[hint]);

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
 * Decode one PNG through the `rgb` control path, with the app's §4.6 hints.
 *
 * `ms` times the ZXing pipeline only — luminance packing, binarisation and the read — and
 * deliberately excludes sharp's PNG decode, because the app never decodes a PNG: it hands
 * ZXing pixels that already exist in a canvas. Timing the PNG parse would measure the
 * bench's own scaffolding and inflate every number in the report. `browser-entry.ts` draws
 * the same boundary around `decodeFromCanvas`, so the two paths' times compare.
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
    // The §4.6 strip, where `readScanResult` applies it: above the §4.9 carrier test and
    // above §4.2. `aimStripped` records every time it fires (see `DecodeOutcome`).
    const format = result.getBarcodeFormat();
    const raw = result.getText();
    const text = stripAimIdentifier(raw, format);
    return {
      text,
      aimStripped: text !== raw,
      format: BarcodeFormat[format],
      ms,
      fault: null,
    };
  } catch (error) {
    const ms = performance.now() - started;
    if (isNoRead(error)) {
      return { text: null, aimStripped: false, format: null, ms, fault: null };
    }
    return {
      text: null,
      aimStripped: false,
      format: null,
      ms,
      fault: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}
