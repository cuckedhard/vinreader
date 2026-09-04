/**
 * §13.2 adversary tests for §4.2 extraction as the S1 scanner uses it, round 2 of
 * `harden S1`.
 *
 * ROUND 1 CONTEXT. Ledger Z1 closed a §4.2 false accept by rewriting step 4(a): a VIN is
 * returned only when exactly one *distinct* window has a valid check digit. That works
 * because a real VIN validates and therefore COMPETES with the windows that straddle it —
 * two distinct valid VINs make the run ambiguous and 4(a) refuses.
 *
 * THIS FILE IS THE OTHER HALF. Uniqueness only defeats the straddle when the printed
 * identifier ALSO validates. When it does not, the straddling window is the *only*
 * check-digit-valid window in the run, `valid.length` is 1, and step 4(a) used to return
 * it with `checkDigitValid: true` — a 17-character string nobody printed, marked valid,
 * so D03 never held it, the §6.3 mismatch banner never appeared, and §6.1's "Got it ✓"
 * fired on it.
 *
 * Two populations reach that branch on real labels, and §4.3 and §4.7 both name them:
 *   1. identifiers that carry no ISO 3779 check digit at all (`checkDigitApplies` false) —
 *      off-highway machine PINs and many non-North-American VINs, explicitly in scope.
 *      **CLOSED by ledger Z6.**
 *   2. an ordinary North-American VIN misread in one character away from position 9 —
 *      the exact case §6.3's two-read rule and the mismatch banner exist for.
 *      **STILL OPEN**, and still characterised, in the second describe below.
 *
 * Z6, AS SHIPPED. Zach ruled on population 1, and §4.2 step 4(a) now reads: a check-digit-
 * valid window may be returned only if it occurs in a run where EVERY grammar-valid window
 * satisfies §4.3 `checkDigitApplies`. A window whose position 9 is a letter was never
 * tested by the check digit, so failing it does not refute it. A run holding one is
 * ambiguous between "a VIN with a stray neighbour" and "a printed no-check-digit
 * identifier plus a chance-validating overlap"; the bytes cannot say which, so N2 refuses
 * the run. The scope is the RUN and not the payload, deliberately — a window in another
 * run cannot overlap this one — and an identifier that is a run of its own still reads,
 * through step 4(b), with `checkDigitValid: false` and no banner (§4.3).
 *
 * WHAT THESE TESTS ARE NOW. They were written as characterisation: they asserted the
 * hazard as it stood so that it stayed executable and went red the moment §4.2 was
 * corrected, exactly as `[A-01]` did before Zach ruled on Z1. That moment has come. The
 * population-1 tests assert the CLOSURE and are the regression guard for it; each keeps,
 * in its comment, the value it used to return, because that record is what makes a
 * regression legible the day one arrives. Population 2's test is unflipped, because
 * nothing has closed it.
 */

import { describe, expect, it } from "vitest";

import { checkDigitApplies, isCheckDigitValid } from "./checkDigit";
import { extractVin } from "./extractVin";

/** A JCB backhoe PIN. Position 9 is `C`, so §4.3 says it carries no check digit at all. */
const PIN = "JCB4CX00CJ2345678";

/** The §4.11 fixture VIN with its last character changed: grammar-valid, check digit wrong. */
const MISREAD = "1HGCM82633A004353";

const ALPHABET = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";

describe("[R2-01] §4.2 refuses a run holding a window the check digit never tested (Z6)", () => {
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
   * "covered cases" list contemplates — becomes one run: `PNJCB4CX00CJ2345678`, 19
   * characters, three windows. `PIN` ends in `N`, a §4.1 character, so window 1 is `N` +
   * the first 16 characters of the PIN, and it passes §4.3 by chance.
   *
   * Window 2 is the PIN itself, and its position 9 is `C`. Under Z6 that one untested
   * window unsettles the whole run: the check digit cannot say whether the printed
   * identifier is the PIN or the window that validated, so §4.2 returns NO_VIN and the
   * user rescans or types (§4.2 "Known limit", which this now implements).
   */
  it("refuses a two-field off-highway label rather than returning the straddling window", () => {
    const raw = `PIN ${PIN}`;
    // WAS: { vin: "NJCB4CX00CJ234567", raw, checkDigitValid: true } — the ledger Z6
    // reproduction, and the identifier printed on the machine was not what came back.
    expect(extractVin(raw)).toBeNull();
    // What changed is the run, not the window. The fabrication still passes §4.3 — which
    // is exactly why nothing downstream could ever have caught it: D03 wrote it through,
    // §6.3's two-read rule agreed because a 2D code decodes identically every frame, and
    // the record was beeped and shown as fact.
    expect(isCheckDigitValid("NJCB4CX00CJ234567")).toBe(true);
    // And the refusal is the Z6 rule rather than the scan giving up on a hard payload: a
    // separator leaves the PIN a run of its own and step 4(b) still returns it, with no
    // banner — §4.3 promises this vehicle is not told its read is wrong, and it is not.
    expect(extractVin(`PIN: ${PIN}`)).toEqual({
      vin: PIN,
      raw: `PIN: ${PIN}`,
      checkDigitValid: false,
    });
  });

  it("does the same for other ordinary field labels in front of the same PIN", () => {
    // Every one of these used to return a check-digit-valid window that was not the PIN.
    // `S/N ` earns its place: the `/` splits, so the run is only `N` + the PIN — two
    // windows — and Z6 refuses even a two-window run when one window is untested.
    for (const raw of [`SN ${PIN}`, `S/N ${PIN}`, `UNIT 42 ${PIN}`]) {
      expect(extractVin(raw), raw).toBeNull();
    }
    // A Caterpillar PIN behind a model field goes the same way. WAS:
    // { vin: "320DCAT0320DCKGF1", checkDigitValid: true }. The run is
    // `MODEL320DCAT0320DCKGF12345`: ten windows, six of them untested — including
    // `CAT0320DCKGF12345`, the number stamped on the machine, whose position 9 is `C`.
    const cat = "MODEL 320D CAT0320DCKGF12345";
    expect(extractVin(cat)).toBeNull();
    expect(isCheckDigitValid("320DCAT0320DCKGF1")).toBe(true);
  });

  it("refuses every legal single character in front of the PIN, not just the four that won", () => {
    const fabricated: string[] = [];
    const returned: string[] = [];
    for (const c of ALPHABET) {
      const got = extractVin(`${c}${PIN}`);
      if (got !== null) returned.push(c);
      if (got !== null && got.vin !== PIN && got.checkDigitValid) fabricated.push(c);
    }
    // WAS ["E", "N", "V", "5"]: four of the thirty-three §4.1 characters, the
    // one-in-eleven-ish rate §4.2's own rationale quotes — and, unlike [A-01], not halved
    // by Z1's uniqueness, because the PIN itself never validates and never competes.
    expect(fabricated).toEqual([]);
    // Nothing is returned at all now, not even a refused-then-recovered PIN: the run is
    // <c> + PIN, two windows, and the second is the untested PIN, so whatever the first
    // window does the run cannot be settled. Step 4(b) does not rescue it either — that
    // step needs exactly one window, and there are two.
    expect(returned).toEqual([]);
    // The four straddles still pass §4.3. The run stopped being settleable; the check
    // digit did not stop matching. If that inverts, §4.2 has been widened again.
    for (const c of ["E", "N", "V", "5"]) {
      expect(isCheckDigitValid(c + PIN.slice(0, 16)), c).toBe(true);
    }
  });

  /**
   * The rate, measured rather than asserted from the rationale. Deterministic LCG, the
   * same shape as the round-1 generator and byte-identical to the one that measured the
   * defect — same seed, same draw order — so before and after describe the same
   * population and the ledger's numbers stay reproducible from the suite.
   *
   * The identifier is NOT stamped with `expectedCheckDigit`, which is what made this
   * generator the complement of round 1's: it draws all 17 characters freely and keeps
   * only the identifiers that do not validate. That mixes the two populations, so the
   * measurement splits them on §4.3 `checkDigitApplies`:
   *
   *   `untested` — position 9 a letter other than X, so no ISO 3779 check digit exists.
   *                This is the Z6 population, and it is now zero.
   *   `misread`  — position 9 a digit or X with the check digit simply wrong. Z6 does not
   *                reach it and was never meant to: every window in such a run can be
   *                asked, so the run IS settleable and step 4(a) settles it — on a window
   *                that is a straddle. That is the residue, and it is the open hazard the
   *                second describe below characterises directly.
   *
   * One honest caveat about the sample: this LCG's state multiply overflows 2^53, so the
   * stream cycles every 10,466 states and 3,000 draws are only 708 distinct payloads
   * (478 untested, 230 misread). The rates below are trial-weighted over that sample.
   */
  it("fabricates nothing out of the Z6 population, and bounds the misread residue", () => {
    let seed = 20260904;
    const rng = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = () => ALPHABET[Math.floor(rng() * ALPHABET.length)];
    let considered = 0;
    let fabricated = 0;
    const untested = { considered: 0, fabricated: 0 };
    const misread = { considered: 0, fabricated: 0 };
    for (let i = 0; i < 3000; i += 1) {
      let identifier = "";
      for (let j = 0; j < 17; j += 1) identifier += pick();
      // Only the population this finding is about: identifiers that do not validate.
      if (isCheckDigitValid(identifier)) continue;
      considered += 1;
      const bucket = checkDigitApplies(identifier) ? misread : untested;
      bucket.considered += 1;
      let prefix = "";
      for (let j = 0; j < 2 + Math.floor(rng() * 5); j += 1) prefix += pick();
      const got = extractVin(`${prefix} ${identifier}`);
      if (got !== null && got.vin !== identifier && got.checkDigitValid) {
        fabricated += 1;
        bucket.fabricated += 1;
      }
    }
    // Guard the generator itself, so no ceiling below can pass by measuring nothing.
    expect(considered).toBeGreaterThan(2500);
    expect(untested.considered).toBeGreaterThan(1500);
    expect(misread.considered).toBeGreaterThan(500);

    // The Z6 population. An equality, not a ceiling: §13.6 criterion 4 is zero false
    // accepts, and a rule that refuses every unsettleable run has no reason to leak one.
    // WAS 168 of 1,942 — 8.65% of the very vehicles §4.3 was written to protect.
    expect(untested.fabricated).toBe(0);

    // The residue: misread North-American VINs, 13 of 973 trials (1.34%) today, down from
    // 117 (12.02%). A ceiling and not the number, because the number must be free to fall
    // to zero if §4.2 is ever narrowed again — a floor under a defect becomes a ceiling on
    // a residue. It is far enough under the pre-Z6 rate that a regression trips it, and
    // `untested.fabricated` above catches a regression that only revives population 1.
    expect(misread.fabricated / misread.considered).toBeLessThan(0.03);
    // Overall: 0.45% today, was 9.78%. Nothing in this generator is ever read correctly,
    // before or after — the prefix always joins the run — so Z6's whole effect here is
    // 272 fabrications turned into refusals, which is the trade N2 asks for.
    expect(fabricated / considered).toBeLessThan(0.01);
  });
});

/**
 * [R2-01 residue] STILL OPEN, and deliberately not flipped.
 *
 * Z6 closed the run that cannot be asked. This is the run that can: an ordinary
 * North-American VIN, misread in one character, with a stray §4.1-legal character beside
 * it. Position 9 is a digit in both windows, so §4.3 speaks for the whole run, the run is
 * settleable, and step 4(a) settles it — on the straddle, because the misread identifier
 * is the one window that fails. Z1 cannot reach it either: a misread does not validate,
 * so it never competes.
 *
 * §6.3's two-read rule does not help — a 2D symbol decodes identically every frame, and a
 * 1D misread that repeats is exactly what the check digit is supposed to catch. This test
 * therefore keeps asserting the hazard, and it goes red the day someone closes it. That
 * is what a characterisation test is for.
 */
describe("[R2-01 residue] §4.2 still fabricates a VIN out of a misread North-American VIN", () => {
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
});
