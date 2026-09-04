/**
 * §4.6, pinned. §7 item 5 asks that every §4 constant be covered by a test; the four
 * symbologies, their priority order and `TRY_HARDER` were the one §4 constant in the S1
 * scope that had none — and, being duplicated between the app and the bench, could drift
 * apart with every gate still green (A-05).
 *
 * This pins the values by calling the code, not by reading its source. The §4.6 values
 * themselves are untouchable: the test records them, it does not decide them.
 */

import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import { describe, expect, it } from "vitest";

import { SCAN_FORMATS, buildScanHints, toSymbology } from "./symbologies";
import type { Symbology } from "./types";

/** §4.6, verbatim: "CODE_39, CODE_128, DATA_MATRIX, QR_CODE", in that priority order. */
const SPEC_FORMATS = ["CODE_39", "CODE_128", "DATA_MATRIX", "QR_CODE"];

/** §4.10 `Symbology`, the four camera members, in the same order. */
const SPEC_SYMBOLOGIES: Symbology[] = ["code_39", "code_128", "data_matrix", "qr_code"];

/** Numeric members only: the enum object also carries ZXing's reverse-mapped names. */
const ALL_FORMATS = Object.values(BarcodeFormat).filter(
  (value): value is BarcodeFormat => typeof value === "number",
);

function names(formats: readonly BarcodeFormat[]): string[] {
  return formats.map((format) => BarcodeFormat[format]);
}

describe("§4.6 symbologies", () => {
  it("enables exactly the four §4.6 formats, in §4.6 priority order", () => {
    expect(names(SCAN_FORMATS)).toEqual(SPEC_FORMATS);
  });

  it("builds the §4.6 hints and nothing else", () => {
    const hints = buildScanHints();
    expect([...hints.keys()]).toEqual([DecodeHintType.POSSIBLE_FORMATS, DecodeHintType.TRY_HARDER]);
    expect(names(hints.get(DecodeHintType.POSSIBLE_FORMATS) as BarcodeFormat[])).toEqual(
      SPEC_FORMATS,
    );
    expect(hints.get(DecodeHintType.TRY_HARDER)).toBe(true);
  });

  it("hands out a copy of the list, so a reader cannot mutate the constant", () => {
    const first = buildScanHints().get(DecodeHintType.POSSIBLE_FORMATS);
    expect(first).not.toBe(SCAN_FORMATS);
    expect(first).not.toBe(buildScanHints().get(DecodeHintType.POSSIBLE_FORMATS));
  });

  it("maps every enabled format to its §4.10 symbology", () => {
    // A format enabled in the hints but missing here would decode and then be dropped.
    expect(SCAN_FORMATS.map((format) => toSymbology(format))).toEqual(SPEC_SYMBOLOGIES);
  });

  it("maps nothing outside §4.6", () => {
    const outside = ALL_FORMATS.filter((format) => !SCAN_FORMATS.includes(format));
    expect(outside.length).toBeGreaterThan(0);
    for (const format of outside) {
      expect(toSymbology(format), `${BarcodeFormat[format]} is not a §4.6 format`).toBeNull();
    }
  });
});
