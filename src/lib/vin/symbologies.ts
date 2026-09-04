/**
 * §4.6 barcode symbologies — the one place the decoder's configuration lives.
 *
 * Pure (P3): no DOM, no React, no I/O. `@zxing/library` is imported only for the
 * `BarcodeFormat` and `DecodeHintType` enums, which are plain numbers, so the scanner and
 * the §13.4 bench can share this file instead of each keeping its own copy of the list
 * (§7 item 5: no constant is defined in more than one place). A bench that decoded with
 * different hints than the app ships would measure the wrong program.
 */

import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import type { Symbology } from "./types";

/** §4.6: these four formats, in this priority order. Nothing else in v1. */
export const SCAN_FORMATS: readonly BarcodeFormat[] = [
  BarcodeFormat.CODE_39,
  BarcodeFormat.CODE_128,
  BarcodeFormat.DATA_MATRIX,
  BarcodeFormat.QR_CODE,
];

/** §4.6: `POSSIBLE_FORMATS` in priority order plus `TRY_HARDER = true`, and nothing else. */
export function buildScanHints(): Map<DecodeHintType, unknown> {
  const hints = new Map<DecodeHintType, unknown>();
  // A fresh array per call: ZXing keeps the hint value it is handed and its
  // `possibleFormats` setter writes into it, so the shared list is never passed by
  // reference.
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [...SCAN_FORMATS]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  return hints;
}

/**
 * §4.6 → §4.10. `null` for anything else: a format outside the hints means the hint list
 * leaked, and the caller drops the read rather than inventing a symbology for it.
 */
export function toSymbology(format: BarcodeFormat): Symbology | null {
  switch (format) {
    case BarcodeFormat.CODE_39:
      return "code_39";
    case BarcodeFormat.CODE_128:
      return "code_128";
    case BarcodeFormat.DATA_MATRIX:
      return "data_matrix";
    case BarcodeFormat.QR_CODE:
      return "qr_code";
    default:
      return null;
  }
}
