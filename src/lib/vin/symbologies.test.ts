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

import { extractVin } from "./extractVin";
import {
  CODE_128_GS1_IDENTIFIER,
  SCAN_FORMATS,
  buildScanHints,
  code39CheckChar,
  stripAimIdentifier,
  toSymbology,
} from "./symbologies";
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
    expect([...hints.keys()]).toEqual([
      DecodeHintType.POSSIBLE_FORMATS,
      DecodeHintType.TRY_HARDER,
      DecodeHintType.ASSUME_GS1,
    ]);
    expect(names(hints.get(DecodeHintType.POSSIBLE_FORMATS) as BarcodeFormat[])).toEqual(
      SPEC_FORMATS,
    );
    expect(hints.get(DecodeHintType.TRY_HARDER)).toBe(true);
  });

  /**
   * §4.6, R5. `Code128Reader` reads this one as `=== true`, not as "present", so the value
   * is as load-bearing as the key: with anything else there, every FNC1 field separator is
   * dropped and a delimited label arrives as one undelimited run (§4.2).
   */
  it("sets ASSUME_GS1 to boolean true, which is what Code128Reader tests for", () => {
    expect(buildScanHints().get(DecodeHintType.ASSUME_GS1)).toBe(true);
  });

  /**
   * The one hint that must stay absent. `MultiFormatOneDReader` enables the Code 39 check
   * character on `hints.get(...) !== undefined`, so setting it to `false` would enable it
   * just as surely as `true` — and then `Code39Reader` treats the last character of every
   * Code 39 read as a mod-43 check, which throws `ChecksumException` on ~42/43 of ordinary
   * 17-character VIN labels and truncates the VIN on the rest (§4.2 "Known limit").
   */
  it("never sets ASSUME_CODE_39_CHECK_DIGIT, at any value", () => {
    expect(buildScanHints().has(DecodeHintType.ASSUME_CODE_39_CHECK_DIGIT)).toBe(false);
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

/**
 * §4.6 / §4.2. The AIM symbology identifier ZXing prepends to its OWN result, stripped
 * before §4.2 ever sees the text.
 *
 * This is the R5 regression `ASSUME_GS1` opened: a Code 128 carrying a leading FNC1 comes
 * back as `]C1` + the message, `]` splits under §4.2 step 2 and `C1` fuses onto the front
 * of the first field, so a label carrying only the VIN arrives as a 19-character run and
 * R4-A refuses it. `]C1` is not label content — no printer encoded it, ZXing wrote it to
 * describe the encoding — so it is removed at the decoder boundary.
 *
 * The values below are pinned to what `@zxing/library` 0.23.0 can actually emit, verified
 * against its source: `']C1'` in `Code128Reader`'s three `convertFNC1` branches is the only
 * AIM identifier anywhere in the library. Anything else that looks like one is content.
 */
describe("stripAimIdentifier", () => {
  const VIN = "1HGCM82633A004352";
  const GS = String.fromCharCode(29);

  /**
   * The regressed shape, end to end at the string level: exactly the bytes
   * `Code128Reader` produces for a leading-FNC1 Code 128 carrying only the VIN
   * (reproduced through bwip-js and the §13.4 bench decoder), and exactly what §4.2 makes
   * of them with and without the strip.
   */
  it("closes the leading-FNC1 regression: ]C1 + VIN reaches §4.2 as the VIN", () => {
    const zxingText = `${CODE_128_GS1_IDENTIFIER}${VIN}`;

    // Unstripped, this is the 19-character run "C1" + VIN: three windows, so R4-A refuses
    // the one that passes the check digit because it is not the whole run.
    expect(extractVin(zxingText)).toBeNull();

    const stripped = stripAimIdentifier(zxingText, BarcodeFormat.CODE_128);
    expect(stripped).toBe(VIN);
    expect(extractVin(stripped)).toEqual({
      vin: VIN,
      raw: VIN,
      checkDigitValid: true,
    });
  });

  it("is ]C1 and nothing else: the one identifier @zxing/library emits", () => {
    expect(CODE_128_GS1_IDENTIFIER).toBe("]C1");
  });

  /**
   * Every subsequent FNC1 is ASCII 29 (GS1 5.4.7.5), which §4.2 step 2 already splits on.
   * The strip must not disturb it, or a multi-field label loses its delimiters again.
   */
  it("removes the prefix only, leaving the GS field separators intact", () => {
    expect(
      stripAimIdentifier(
        `${CODE_128_GS1_IDENTIFIER}9N123456789${GS}${VIN}`,
        BarcodeFormat.CODE_128,
      ),
    ).toBe(`9N123456789${GS}${VIN}`);
    expect(
      stripAimIdentifier(`${CODE_128_GS1_IDENTIFIER}${VIN}${GS}1P84203911`, BarcodeFormat.CODE_128),
    ).toBe(`${VIN}${GS}1P84203911`);
  });

  it("leaves a Code 128 read that carries no identifier byte-for-byte alone", () => {
    expect(stripAimIdentifier(VIN, BarcodeFormat.CODE_128)).toBe(VIN);
    expect(stripAimIdentifier(`${VIN}${GS}1P84203911`, BarcodeFormat.CODE_128)).toBe(
      `${VIN}${GS}1P84203911`,
    );
    expect(stripAimIdentifier("", BarcodeFormat.CODE_128)).toBe("");
  });

  /**
   * A `]` a printer really encoded is content. `Code128Reader` writes `]C1` only into an
   * empty result, so an identifier is a whole prefix and never anything else: a `]` not
   * followed by `C1`, and the other symbologies' identifiers (which this library never
   * emits at all), are label data and stay.
   *
   * `]C` + a VIN beginning with `1` is deliberately absent from this list, because it is
   * byte-identical to the identifier + that VIN without its first character and no rule
   * over the string can separate them — see the bound in `stripAimIdentifier`. The
   * §4.11 fixture used here begins with `W`.
   */
  it("never eats a leading ] that is not the identifier", () => {
    const OTHER_VIN = "WVWZZZ1JZ1W123456";
    expect(stripAimIdentifier(`]${VIN}`, BarcodeFormat.CODE_128)).toBe(`]${VIN}`);
    expect(stripAimIdentifier(`]C${OTHER_VIN}`, BarcodeFormat.CODE_128)).toBe(`]C${OTHER_VIN}`);
    expect(stripAimIdentifier(`]Q1${VIN}`, BarcodeFormat.CODE_128)).toBe(`]Q1${VIN}`);
    expect(stripAimIdentifier(`]d1${VIN}`, BarcodeFormat.CODE_128)).toBe(`]d1${VIN}`);
    expect(stripAimIdentifier(`]A0${VIN}`, BarcodeFormat.CODE_128)).toBe(`]A0${VIN}`);
    expect(stripAimIdentifier(`]C2${VIN}`, BarcodeFormat.CODE_128)).toBe(`]C2${VIN}`);
    expect(stripAimIdentifier(`]E0${VIN}`, BarcodeFormat.CODE_128)).toBe(`]E0${VIN}`);
  });

  it("strips one identifier, not a run of them: the second ]C1 is content", () => {
    // ZXing writes the identifier once, on an empty result. A second copy was printed.
    expect(
      stripAimIdentifier(
        `${CODE_128_GS1_IDENTIFIER}${CODE_128_GS1_IDENTIFIER}${VIN}`,
        BarcodeFormat.CODE_128,
      ),
    ).toBe(`${CODE_128_GS1_IDENTIFIER}${VIN}`);
    expect(stripAimIdentifier(`${VIN}${CODE_128_GS1_IDENTIFIER}`, BarcodeFormat.CODE_128)).toBe(
      `${VIN}${CODE_128_GS1_IDENTIFIER}`,
    );
  });

  /**
   * The strip is keyed on the reported symbology because that is what makes it safe.
   * `]C1` from CODE_39, DATA_MATRIX or QR_CODE cannot be an identifier — `Code128Reader`
   * is the only reader in `@zxing/library` that writes one — so there it is exactly what
   * a printer encoded, and removing it would eat label data.
   */
  it("strips nothing from the other three §4.6 formats, where ]C1 is content", () => {
    for (const format of SCAN_FORMATS.filter((f) => f !== BarcodeFormat.CODE_128)) {
      const text = `${CODE_128_GS1_IDENTIFIER}${VIN}`;
      expect(stripAimIdentifier(text, format), BarcodeFormat[format]).toBe(text);
    }
  });

  it("strips nothing from a format outside §4.6", () => {
    const text = `${CODE_128_GS1_IDENTIFIER}${VIN}`;
    expect(stripAimIdentifier(text, BarcodeFormat.EAN_13)).toBe(text);
  });
});

/**
 * §4.6 Code 39 mod-43 check character. The §13.4 `code_39_check` bench row is rendered
 * with this function, so an error here would silently make that row measure a symbol no
 * label printer would ever produce.
 */
describe("code39CheckChar", () => {
  /**
   * ISO/IEC 16388 value order: digits 0-9 are 0-9, A-Z are 10-35, then `- . <space> $ / + %`
   * are 36-42. Pinned one character at a time, because a single transposition in the table
   * shifts every value above it and the sum would still look plausible.
   */
  it("assigns the ISO/IEC 16388 value to every character in the alphabet", () => {
    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%";
    expect(alphabet).toHaveLength(43);
    for (let value = 0; value < alphabet.length; value += 1) {
      // A single character sums to its own value, so the check character it produces is
      // the character the table holds at that value: an identity over the whole alphabet.
      expect(code39CheckChar(alphabet[value]), `value of ${alphabet[value]}`).toBe(alphabet[value]);
    }
  });

  it("wraps at 43, not at 36 or 44", () => {
    // %% = 42 + 42 = 84; 84 mod 43 = 41 = "+".
    expect(code39CheckChar("%%")).toBe("+");
    // Z% = 35 + 42 = 77; 77 mod 43 = 34 = "Y".
    expect(code39CheckChar("Z%")).toBe("Y");
    // "+%" = 41 + 42 = 83 -> 83 mod 43 = 40 = "/".
    expect(code39CheckChar("+%")).toBe("/");
  });

  it("gives 0 for the empty string, the mod-43 identity", () => {
    expect(code39CheckChar("")).toBe("0");
  });

  /**
   * Worked by hand from §4.3's fixture VIN, digit by digit, so the expected value does not
   * come from the code under test:
   *   1 H  G  C  M  8  2  6  3  3  A  0  0  4  3  5  2
   *   1 17 16 12 22 8  2  6  3  3 10  0  0  4  3  5  2  = 114;  114 mod 43 = 28 = "S".
   */
  it("matches a hand-computed sum for the §4.11 fixture VIN", () => {
    expect(code39CheckChar("1HGCM82633A004352")).toBe("S");
  });

  it("is null for anything outside the Code 39 alphabet", () => {
    // Lowercase, which Code 39 cannot encode without extended mode, and ASCII GS.
    expect(code39CheckChar("1hgcm82633a004352")).toBeNull();
    expect(code39CheckChar(`1HGCM82633A004352${String.fromCharCode(29)}`)).toBeNull();
    expect(code39CheckChar("*1HGCM82633A004352*")).toBeNull();
  });
});
