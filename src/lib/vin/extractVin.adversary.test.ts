/**
 * §13.2 adversary tests for §4.2 extraction as the S1 scanner uses it, round 1 of
 * `harden S1`.
 *
 * The tests marked [A-01] were written to pin a §4.2 false accept: a stray legal
 * character in front of the VIN made the offset-0 window validate by chance, and the
 * scanner confirmed a 17-character string nobody printed. Zach resolved it (ledger Z1)
 * by requiring the chosen window to be the only distinct VIN that validates, so they now
 * assert the hazard is CLOSED. They are the regression guard for it.
 */

import { describe, expect, it } from "vitest";

import { expectedCheckDigit } from "./checkDigit";
import { extractVin } from "./extractVin";

const VIN = "1HGCM82633A004352";
const ALPHABET = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";

describe("[A-01] §4.2 refuses a run that holds more than one plausible VIN", () => {
  /**
   * §4.2 step 4a ranks a window "aligned to a run's start" above every later window.
   * One stray §4.1-legal character in front of the VIN shifts the run by one, and the
   * offset-0 window passes the check digit about one time in thirty-three — so the scanner
   * confirms a 17-character string that is not on the label, with
   * `checkDigitValid: true`. Nothing downstream can tell it from a real read.
   */
  it("returns NO_VIN rather than a straddling window, for every legal leading character", () => {
    expect(extractVin(`B${VIN}`)).toBeNull();
    // B, K, S and 2 were the four that produced a check-digit-VALID wrong VIN. Now none
    // of the 33 does: either the run is ambiguous, or nothing validates at all.
    for (const c of ALPHABET) {
      const got = extractVin(`${c}${VIN}`);
      expect(got === null || got.vin === VIN).toBe(true);
    }
  });

  /**
   * §4.2 step 1 strips whitespace *before* step 2 splits into runs (D05, deliberate),
   * so a multi-field label — a Code 128 carrying `<unit> <VIN>`, or a 2D code with
   * space-separated text — is concatenated into a single run and the same straddling
   * window wins.
   */
  it("does the same when whitespace joined a neighbouring field to the VIN", () => {
    expect(extractVin(`B ${VIN}`)).toBeNull();
    // A realistic two-field label: "UNIT B" then the VIN. This one returned
    // `TB1HGCM82633A0043` marked check-digit-valid — a VIN nobody printed, saved as fact.
    expect(extractVin(`UNIT B\n${VIN}`)).toBeNull();
    expect(extractVin(`2\t${VIN}`)).toBeNull();
  });

  it("never returns a wrong VIN across random single-field-plus-VIN payloads", () => {
    // Deterministic LCG: the rate is a measurement, not a flake.
    let seed = 12345;
    const rng = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = () => ALPHABET[Math.floor(rng() * ALPHABET.length)];
    let wrong = 0;
    const N = 2000;
    for (let i = 0; i < N; i += 1) {
      let body = "";
      for (let j = 0; j < 17; j += 1) body += pick();
      const vin = body.slice(0, 8) + expectedCheckDigit(body) + body.slice(9);
      let prefix = "";
      for (let j = 0; j < 2 + Math.floor(rng() * 5); j += 1) prefix += pick();
      const result = extractVin(`${prefix} ${vin}`);
      if (result !== null && result.vin !== vin) wrong += 1;
    }
    // Was 1-6% before Z1. A wrong VIN accepted is §13.6 criterion 4, so the bar is zero,
    // not "low": an ambiguous run is refused rather than resolved to the likelier guess.
    expect(wrong).toBe(0);
  });

  /**
   * §4.2 step 1 says "Uppercase", and `String.prototype.toUpperCase` maps several
   * non-ASCII characters *into* the §4.1 alphabet: U+017F LATIN SMALL LETTER LONG S
   * becomes `S`, U+00DF becomes `SS`, the `ﬅ` ligature becomes `ST`. A 2D code
   * carrying UTF-8 text can therefore grow a run and trigger the straddle above.
   */
  it("is not fooled when toUpperCase manufactures §4.1 characters out of non-ASCII text", () => {
    // U+017F uppercases to a bare ASCII "S", a §4.1 character, so the run grows by one
    // and the offset-0 window validates. It used to be returned as "S1HGCM82633A00435".
    expect(extractVin(`ſ${VIN}`)).toBeNull();
    // U+FB05 uppercases to "ST": two characters, and this VIN's straddle fails the check
    // digit, so the run holds exactly one plausible VIN and it still reads.
    expect(extractVin(`ﬅ${VIN}`)?.vin).toBe(VIN);
  });
});

describe("adversary — hostile text that must stay NO_VIN", () => {
  it.each([
    ["a combining mark inside the VIN", "1HGCM82633A00435́2"],
    ["a NUL byte inside the VIN", "1HGCM826\u000033A004352"],
    ["fullwidth digits and letters", "１ＨＧCM82633A004352"],
    ["a Turkish dotless i, which uppercases to the excluded I", "ıHGCM82633A004352"],
    ["the Kelvin sign, which is not an ASCII K", "1HGCM82633A00435K"],
    ["sixteen characters", "1HGCM82633A00435"],
    ["an empty string", ""],
  ])("returns NO_VIN for %s", (_name, raw) => {
    expect(extractVin(raw)).toBeNull();
  });

  it("survives an oversized decode without throwing or degrading superlinearly", () => {
    // A QR tops out near 3 kB, but a pasted or crafted payload is unbounded; the
    // window scan must stay linear and must not throw.
    for (const n of [3_000, 300_000]) {
      expect(extractVin("A".repeat(n))).toBeNull();
    }
    expect(extractVin(`${"A".repeat(100_000)} ${VIN}`)).not.toBeNull();
  });

  it("keeps raw byte-for-byte however hostile it was", () => {
    const raw = `  ‏*${VIN}*‎  `;
    expect(extractVin(raw)?.raw).toBe(raw);
  });
});
