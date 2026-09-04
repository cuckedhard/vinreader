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

/**
 * §4.6: `POSSIBLE_FORMATS` in priority order, `TRY_HARDER = true`, and `ASSUME_GS1 = true`.
 *
 * **Why `ASSUME_GS1` is on** (R5, and §4.6 is amended to match). §4.2 refuses an
 * undelimited multi-field payload, and justifies it on the grounds that real delimited
 * labels split into runs. That argument depends on the field separator surviving the
 * decoder. It does not, by default: a Code 128 carrying alphanumeric field data is encoded
 * in Code Set B, where ASCII GS (0x1D) is not in the character set at all, so label
 * printers separate fields with FNC1 — standard for GS1-128, common for MH10.8.2 over
 * Code 128. `@zxing/library`'s `Code128Reader` converts FNC1 to a character **only** when
 * this hint is set (its three `convertFNC1` branches, one per code set); otherwise the
 * `CODE_FNC_1` case falls through emitting nothing and the separator is silently dropped.
 * The two fields then arrive concatenated, §4.2 sees one long run, and R4-A's whole-run
 * rule refuses a correctly-delimited label as if it were undelimited.
 *
 * With the hint, per GS1 5.4.7.5 as ZXing implements it, every FNC1 *after* the first
 * character emits ASCII 29 (GS) — which §4.2 step 2 already splits on. That is the whole
 * of the fix, and it is the shape MH10.8.2-over-Code-128 actually prints. Measured, same
 * images, hints with and without the flag:
 *
 * ```
 *   VIN <FNC1> 1P-field                    NO_VIN -> VIN      fixed
 *   I+VIN <FNC1> 1P-field                  NO_VIN -> VIN      fixed
 *   <FNC1> 9N-field <FNC1> VIN             NO_VIN -> VIN      fixed
 *   <FNC1> VIN            (single field)   VIN -> NO_VIN      REGRESSED, see below
 *   <FNC1> VIN <FNC1> 1P-field             NO_VIN -> NO_VIN   unchanged
 *   plain VIN                              VIN -> VIN         unchanged
 * ```
 *
 * **The bound it opened, and how it is closed.** A *leading* FNC1 additionally emits the
 * AIM symbology identifier `]C1` (GS1 5.4.3.7 / 5.4.6.4) with no separator after it, so
 * `]` splits under §4.2 step 2 but `C1` fuses onto the front of the first field: a
 * leading-FNC1 message whose first field is the VIN read as the 19-character run
 * `C1` + VIN, three windows, refused by R4-A. `]C1` is not label content — no printer put
 * it there, ZXing wrote it to describe the encoding — so `stripAimIdentifier` below removes
 * it from a CODE_128 result before §4.2 ever sees the text, and the trade is no longer a
 * trade:
 *
 * ```
 *   <FNC1> VIN            (single field)   NO_VIN -> VIN      the regression, closed
 *   <FNC1> VIN <FNC1> 1P-field             NO_VIN -> VIN      closed with it
 * ```
 *
 * The hint reaches nothing else. `ASSUME_GS1` is read in exactly one file in
 * `@zxing/library` — `Code128Reader` — so CODE_39, DATA_MATRIX and QR_CODE decode
 * byte-for-byte as before (verified by source and by the §13.4 bench), and a Code 128
 * carrying no FNC1 (the plain VIN label) has no `CODE_FNC_1` code for the branch to act on.
 */
export function buildScanHints(): Map<DecodeHintType, unknown> {
  const hints = new Map<DecodeHintType, unknown>();
  // A fresh array per call: ZXing keeps the hint value it is handed and its
  // `possibleFormats` setter writes into it, so the shared list is never passed by
  // reference.
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [...SCAN_FORMATS]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  hints.set(DecodeHintType.ASSUME_GS1, true);
  // NOT set, at any value: `ASSUME_CODE_39_CHECK_DIGIT`. `MultiFormatOneDReader` tests it
  // with `hints.get(...) !== undefined`, so even setting it to `false` turns it on, and
  // once on, `Code39Reader` treats the last character of EVERY Code 39 read as a mod-43
  // check character — throwing `ChecksumException` on the ~42/43 of ordinary 17-character
  // VIN labels where it does not match, and truncating the VIN to 16 characters on the
  // rest. See §4.2's "Known limit" for the check-character case it would have served.
  return hints;
}

/**
 * The one AIM symbology identifier `@zxing/library` 0.23.0 emits, from `Code128Reader`'s
 * three `convertFNC1` branches: `']C1'`, written when — and only when — `ASSUME_GS1` is set
 * and FNC1 is the first codeword after the start code (`result.length === 0`), per GS1
 * 5.4.3.7 / 5.4.6.4.
 *
 * Exported so the test can pin the literal and the §13.4 bench can name what it strips
 * (§7 item 5).
 */
export const CODE_128_GS1_IDENTIFIER = "]C1";

/**
 * Remove the AIM symbology identifier ZXing prepended to its own result, leaving the bytes
 * the label actually carries.
 *
 * An AIM identifier is `]`, a character naming the symbology, and a modifier digit. It is
 * decoder metadata, not label data, and handing it to §4.2 was never right: `]` is not a
 * §4.1 character so step 2 splits on it, but the two characters behind it fuse onto the
 * front of the first field and lengthen its run. That is exactly the R5 regression — a
 * leading-FNC1 Code 128 carrying only the VIN arrived as `C1` + VIN, a 19-character run
 * with three windows, and R4-A's whole-run rule refused it.
 *
 * **Why `]C1`, from CODE_128, and nothing else.** The strip is deliberately as narrow as
 * the decoder this app ships. AIM defines identifiers for every symbology — `]A0` for Code
 * 39, `]d1` for GS1 Data Matrix, `]Q1` for GS1 QR — but `@zxing/library` 0.23.0 emits none
 * of them: `']C1'` in `Code128Reader` is the only AIM identifier string anywhere in the
 * library (its `Result` objects carry no symbology-identifier metadata either, so there is
 * nothing else to consult). A leading `]C1` on a CODE_39, DATA_MATRIX or QR_CODE read is
 * therefore something a printer encoded, and removing it would eat label data — so the
 * strip is keyed on the reported format, and a wider regex is not written. For the same
 * reason it takes a whole-prefix match and not a "leading `]` plus two characters": `]`
 * followed by real content, which already reads correctly today because step 2 splits it
 * off, must keep reading correctly.
 *
 * The identifier is a prefix by construction (ZXing writes it only into an empty result),
 * so exactly one copy is removed and only at index 0; a second `]C1` was printed on the
 * label.
 *
 * **The bound, which is a property of ZXing 0.23.0 and not of this function.** A Code 128
 * that really encodes the characters `]C1` at the start of its message decodes to the same
 * string as a leading-FNC1 label whose message follows the identifier, and 0.23.0 keeps no
 * metadata that separates them, so those three characters are removed from it too. That
 * can only shorten the first run — nothing before the prefix can merge into it — so §4.2
 * still reads whatever field the label carries, at its own boundaries, and no window can
 * straddle a boundary it could not straddle before. The strip cannot invent a VIN; at
 * worst it reads the label as GS1-128 when the printer meant `]C1` literally.
 *
 * **Here and not in §4.2 step 1**, beside the `*` that is stripped there for the same
 * reason, on purpose: `extractVin` also serves typed entry and pasted import text, where
 * nothing prepended anything and `]C1` is just characters a human supplied. Only a read
 * that came out of the decoder can carry the decoder's metadata, so only that path strips
 * it — and §4.2's constant is untouched.
 *
 * Pure (P3): a string and a number in, a string out.
 */
export function stripAimIdentifier(text: string, format: BarcodeFormat): string {
  if (format !== BarcodeFormat.CODE_128) return text;
  if (!text.startsWith(CODE_128_GS1_IDENTIFIER)) return text;
  return text.slice(CODE_128_GS1_IDENTIFIER.length);
}

/**
 * §4.6 / ISO/IEC 16388 Code 39 alphabet, in value order: index in this string **is** the
 * character's mod-43 value. Verbatim `Code39Reader.ALPHABET_STRING` from `@zxing/library`,
 * which is the decoder this app ships, so the two can never disagree.
 */
const CODE_39_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%";

/**
 * The optional Code 39 mod-43 check character over `data`: sum the value of every data
 * character, take it mod 43, and read the character back out of the same table.
 *
 * Returns `null` when any character is outside the Code 39 alphabet, because then the
 * string is not a Code 39 payload and no check character is defined over it.
 *
 * This is arithmetic about the *symbology*, not about the VIN — §4.3's mod-11 check digit
 * is a different check over a different alphabet and the two never meet. It lives here
 * because §4.6 is the one place decoder facts are allowed to live (§7 item 5): the §13.4
 * bench renders its `code_39_check` row with this function, so the row it measures is the
 * arithmetic a label printer would actually emit rather than a second copy of the table.
 *
 * Not used to strip anything: see §4.2's "Known limit" for why a read carrying this
 * character is refused rather than normalised.
 */
export function code39CheckChar(data: string): string | null {
  let total = 0;
  for (const char of data) {
    const value = CODE_39_ALPHABET.indexOf(char);
    if (value < 0) return null;
    total += value;
  }
  return CODE_39_ALPHABET.charAt(total % 43);
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
