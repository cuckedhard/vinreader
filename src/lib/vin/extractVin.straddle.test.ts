/**
 * §13.2 adversary tests for §4.2 extraction as the S1 scanner uses it, round 2 of
 * `harden S1`.
 *
 * ROUND 1 CONTEXT. Ledger Z1 closed a §4.2 false accept by rewriting step 4(a): a VIN is
 * returned only when exactly one *distinct* window has a valid check digit. The ledger
 * records "0 of 2,000 random `<field> <VIN>` payloads" after the change, and
 * `extractVin.adversary.test.ts` pins that with a generator that stamps every fixture with
 * `expectedCheckDigit`, i.e. every identifier it builds carries a VALID check digit.
 *
 * THIS FILE IS THE OTHER HALF, AND IT IS STILL OPEN. Uniqueness only defeats the straddle
 * when the printed identifier ALSO validates, because then two distinct windows validate
 * and the run is refused. When the printed identifier's own check digit does NOT validate,
 * the straddling window is the *only* check-digit-valid window in the run, `valid.length`
 * is 1, and §4.2 step 4(a) returns it with `checkDigitValid: true` — a 17-character string
 * nobody printed, marked valid, so D03 never holds it, the §6.3 mismatch banner never
 * appears, and §6.1's "Got it ✓" fires on it.
 *
 * Two populations reach that branch on real labels, and §4.3 and §4.7 both name them:
 *   1. identifiers that carry no ISO 3779 check digit at all (`checkDigitApplies` false) —
 *      off-highway machine PINs and many non-North-American VINs, explicitly in scope; and
 *   2. an ordinary North-American VIN misread in one character away from position 9 —
 *      the exact case §6.3's two-read rule and the mismatch banner exist for.
 *
 * §4.2 is a §4 constant. CLAUDE.md rule 2 and §13.6 forbid an agent changing it, so these
 * are CHARACTERISATION tests: they assert the hazard as it stands today, exactly as the
 * `[A-01]` tests did before Zach ruled on Z1. They go red the moment §4.2 changes, which
 * is when someone should be reading them.
 */

import { describe, expect, it } from "vitest";

import { checkDigitApplies, isCheckDigitValid } from "./checkDigit";
import { extractVin } from "./extractVin";

/** A JCB backhoe PIN. Position 9 is `C`, so §4.3 says it carries no check digit at all. */
const PIN = "JCB4CX00CJ2345678";

/** The §4.11 fixture VIN with its last character changed: grammar-valid, check digit wrong. */
const MISREAD = "1HGCM82633A004353";

const ALPHABET = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";

describe("[R2-01] §4.2 still fabricates a VIN when the printed identifier does not validate", () => {
  it("reads the bare identifiers correctly, so the run really is the only difference", () => {
    // §4.3 / D17: no check digit here, so step 4(b) locates it as a run of its own.
    expect(checkDigitApplies(PIN)).toBe(false);
    expect(extractVin(PIN)).toEqual({ vin: PIN, raw: PIN, checkDigitValid: false });

    expect(isCheckDigitValid(MISREAD)).toBe(false);
    expect(checkDigitApplies(MISREAD)).toBe(true);
    expect(extractVin(MISREAD)).toEqual({ vin: MISREAD, raw: MISREAD, checkDigitValid: false });
  });

  /**
   * §4.2 step 1 strips whitespace BEFORE step 2 splits into runs, so a Data Matrix or
   * Code 128 carrying `PIN <identifier>` — the ANSI-style two-field label §4.2's own
   * "covered cases" list contemplates — becomes one run. `PIN` ends in `N`, a §4.1
   * character, and the offset-0 window `N` + the first 16 characters of the PIN passes
   * §4.3 by chance. It is the only validating window, so step 4(a) returns it as fact.
   */
  it("returns a straddling window for a two-field off-highway label", () => {
    const raw = `PIN ${PIN}`;
    const got = extractVin(raw);
    // Documented as the CURRENT behaviour, not the desired one.
    expect(got).toEqual({ vin: "NJCB4CX00CJ234567", raw, checkDigitValid: true });
    // The identifier that is actually printed on the machine is not what came back.
    expect(got?.vin).not.toBe(PIN);
    // And nothing downstream can catch it: §4.3 genuinely validates the fabrication, so
    // D03 writes it straight through and §6.3 never shows the mismatch banner.
    expect(isCheckDigitValid(got!.vin)).toBe(true);
  });

  it("does the same for other ordinary field labels in front of the same PIN", () => {
    for (const raw of [`SN ${PIN}`, `S/N ${PIN}`, `UNIT 42 ${PIN}`]) {
      const got = extractVin(raw);
      expect(got, raw).not.toBeNull();
      expect(got!.checkDigitValid, raw).toBe(true);
      expect(got!.vin, raw).not.toBe(PIN);
    }
    // A Caterpillar PIN behind a model field goes the same way.
    const cat = "MODEL 320D CAT0320DCKGF12345";
    expect(extractVin(cat)).toEqual({ vin: "320DCAT0320DCKGF1", raw: cat, checkDigitValid: true });
  });

  it("returns a straddling window for a single legal character in front of the PIN", () => {
    const fabricated: string[] = [];
    for (const c of ALPHABET) {
      const got = extractVin(`${c}${PIN}`);
      if (got !== null && got.vin !== PIN && got.checkDigitValid) fabricated.push(c);
    }
    // Four of the thirty-three §4.1 characters, the same one-in-eleven-ish rate §4.2's own
    // rationale paragraph quotes — and here the rate is not halved by uniqueness, because
    // the PIN itself never validates.
    expect(fabricated).toEqual(["E", "N", "V", "5"]);
  });

  /**
   * The second population: a real North-American VIN misread in one character. §6.3's
   * two-read rule does not help — a 2D symbol decodes identically every frame, and a 1D
   * misread that repeats is exactly what the check digit is supposed to catch.
   */
  it("returns a straddling window for a misread North-American VIN", () => {
    expect(extractVin(`B${MISREAD}`)).toEqual({
      vin: "B1HGCM82633A00435",
      raw: `B${MISREAD}`,
      checkDigitValid: true,
    });
    const fabricated = ALPHABET.split("").filter((c) => {
      const got = extractVin(`${c}${MISREAD}`);
      return got !== null && got.vin !== MISREAD && got.checkDigitValid;
    });
    expect(fabricated).toEqual(["B", "K", "S", "2"]);
  });

  /**
   * The rate, measured rather than asserted from the rationale. Deterministic LCG, the
   * same shape as the round-1 generator — with one change: the identifier is NOT stamped
   * with `expectedCheckDigit`, so it stands for a misread or a PIN rather than a clean
   * North-American read.
   */
  it("fabricates a check-digit-valid VIN for a measurable share of such payloads", () => {
    let seed = 20260904;
    const rng = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = () => ALPHABET[Math.floor(rng() * ALPHABET.length)];
    let considered = 0;
    let fabricated = 0;
    for (let i = 0; i < 3000; i += 1) {
      let identifier = "";
      for (let j = 0; j < 17; j += 1) identifier += pick();
      // Only the population this finding is about: identifiers that do not validate.
      if (isCheckDigitValid(identifier)) continue;
      considered += 1;
      let prefix = "";
      for (let j = 0; j < 2 + Math.floor(rng() * 5); j += 1) prefix += pick();
      const got = extractVin(`${prefix} ${identifier}`);
      if (got !== null && got.vin !== identifier && got.checkDigitValid) fabricated += 1;
    }
    // §13.6 criterion 4 wants zero false accepts. This is the measurement that says the
    // round-1 resolution did not reach zero for this population; it is pinned, not
    // approved. Roughly 6% today.
    expect(considered).toBeGreaterThan(2500);
    expect(fabricated / considered).toBeGreaterThan(0.02);
  });
});
