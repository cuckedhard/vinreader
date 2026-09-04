/**
 * §13.2 adversary tests for §4.2 extraction as the S1 scanner uses it, round 1 of
 * `harden S1`.
 *
 * The tests marked [A-01] were written to pin a §4.2 false accept: a stray legal
 * character in front of the VIN made the offset-0 window validate by chance, and the
 * scanner confirmed a 17-character string nobody printed. Zach resolved it (ledger Z1)
 * by requiring the chosen window to be the only distinct VIN that validates, so they now
 * assert the hazard is CLOSED. They are the regression guard for it.
 *
 * The tests marked [R2-F] pinned a SECOND straddle that Z1's rule could not reach: an
 * identifier carrying no check digit (§4.3) never competes, so the one window that
 * validated was a straddle and step 4(a) returned it as fact. Zach resolved it (ledger
 * Z6) by requiring the winning window to sit in a run the check digit can speak for —
 * one in which every window carries a check digit — so they now assert the hazard is
 * CLOSED, and they are the regression guard for it.
 */

import { describe, expect, it } from "vitest";

import { checkDigitApplies, expectedCheckDigit, isCheckDigitValid } from "./checkDigit";
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

/**
 * [R2-F] CLOSED. These tests pinned a §4.2 false accept and now guard against its return.
 *
 * Z1 closed the straddle for identifiers that carry a check digit, because a real VIN
 * validates and therefore competes — two distinct valid VINs make the run ambiguous and
 * step 4(a) refuses. An off-highway machine PIN carries no ISO 3779 check digit at all
 * (§4.3 `checkDigitApplies`, §4.7 puts those vehicles in scope), so it could never enter
 * that contest: exactly one window validated, that window was not the identifier, and
 * step 4(a) returned it as fact with `checkDigitValid: true`.
 *
 * Zach resolved it (ledger Z6) by finishing the sentence §4.2's own "Known limit" prose
 * already wrote — "an identifier carrying no check digit [yields NO_VIN] unless it is a
 * run of its own". Step 4(a) now settles a run only when every window in it carries a
 * check digit and can therefore be refuted by one; a run holding an untested window is
 * ambiguous between a printed identifier and a chance-validating overlap, and N2 refuses
 * it. A run of its own still reads, through step 4(b).
 */
describe("[R2-F] §4.2 refuses a run in which an untested window could be the identifier (Z6)", () => {
  // Position 9 is "C", so §4.3 says this identifier carries no check digit at all.
  const PIN = "JCB4CX00CJ2345678";

  it("carries no check digit, so it can never win step 4(a) on its own merits", () => {
    expect(checkDigitApplies(PIN)).toBe(false);
    expect(isCheckDigitValid(PIN)).toBe(false);
    // Alone, it is a run of its own: exactly one window, so step 4(b) returns it. §4.3
    // exists so this vehicle is not told its read is wrong, and it still is not.
    expect(extractVin(PIN)).toEqual({ vin: PIN, raw: PIN, checkDigitValid: false });
  });

  it("is refused, not replaced, as soon as another field shares its run", () => {
    expect(extractVin(`PIN ${PIN}`)).toBeNull();
    // `NJCB4CX00CJ234567` is the window that used to come back marked check-digit-valid.
    // It still passes §4.3 — that is why nothing downstream could ever have caught it —
    // so what changed is that the run is refused, not that the window stopped validating.
    expect(isCheckDigitValid("NJCB4CX00CJ234567")).toBe(true);
    for (const raw of [`SN ${PIN}`, `UNIT 42 ${PIN}`, `${PIN} 01`, `PIN ${PIN} USA`]) {
      expect(extractVin(raw), raw).toBeNull();
    }
    // A separator instead of a space leaves the PIN a run of its own, and it reads.
    expect(extractVin(`PIN: ${PIN}`)).toEqual({
      vin: PIN,
      raw: `PIN: ${PIN}`,
      checkDigitValid: false,
    });
  });

  it("fabricates none now: 0 of 2,000 prefixed, 0 of 5,000 prefixed and suffixed", () => {
    // The same deterministic generator that measured the defect, so the before and after
    // are the same population and the ledger's number is reproducible from the suite.
    // "X" excluded at position 9: it is a legal check character, so a PIN carrying one
    // would belong to the class Z1 already closed.
    const NO_CHECK = ALPHABET.replace(/[0-9X]/g, "");
    const PREFIXES = ["PIN ", "UNIT B ", "SN ", "P/N ", "ID: ", "A ", "MDL 4CX "];
    const SUFFIXES = [" 01", " USA", " REV C", " 2019", " B", " KG 4200", " CAT"];

    const measure = (seed0: number, n: number, suffixed: boolean) => {
      let seed = seed0;
      const rng = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      const pick = <T>(from: readonly T[]) => from[Math.floor(rng() * from.length)]!;
      const pickChar = (s: string) => s[Math.floor(rng() * s.length)]!;
      let fabricated = 0;
      let read = 0;
      for (let i = 0; i < n; i += 1) {
        let id = "";
        for (let j = 0; j < 17; j += 1) id += j === 8 ? pickChar(NO_CHECK) : pickChar(ALPHABET);
        const raw = pick(PREFIXES) + id + (suffixed ? pick(SUFFIXES) : "");
        const got = extractVin(raw);
        if (got === null) continue;
        if (got.vin === id) read += 1;
        else fabricated += 1;
      }
      return { fabricated, read };
    };

    // §13.6 criterion 4 is zero false accepts, so this asserts the count, not a ceiling.
    // Before Z6 the same two draws gave 103 and 673 fabrications (5.2% and 13.5%) — a
    // field printed after the identifier as well as before roughly doubles the rate,
    // because every extra character adds another window and another one-in-eleven chance.
    const prefixed = measure(0x2c6b, 2000, false);
    expect(prefixed.fabricated).toBe(0);
    expect(measure(0x5aff, 5000, true).fabricated).toBe(0);
    // And the cost of that is nil on this population: the 307 identifiers that read before
    // — the ones a separator left in a run of their own — all still read. The 103 became
    // refusals, not wrong answers, which is the trade N2 asks for.
    expect(prefixed.read).toBe(307);
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
    // §4.2 step 1 strips the space before step 2 splits, so this is ONE run and the VIN
    // shares it with 100,000 windows that carry no check digit: refused, not mined (Z6).
    expect(extractVin(`${"A".repeat(100_000)} ${VIN}`)).toBeNull();
    // A separator makes the VIN a run of its own and it still reads out of a payload this
    // size, so the refusal above is the Z6 rule rather than the scan giving up.
    expect(extractVin(`${"A".repeat(100_000)}-${VIN}`)?.vin).toBe(VIN);
  });

  it("keeps raw byte-for-byte however hostile it was", () => {
    const raw = `  ‏*${VIN}*‎  `;
    expect(extractVin(raw)?.raw).toBe(raw);
  });
});
