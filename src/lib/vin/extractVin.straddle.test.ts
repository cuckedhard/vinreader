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
 *      **CLOSED by ledger R4-A**, and guarded in the last describe below.
 *
 * Z6, AND THEN R4-A. Zach ruled on population 1 first, and step 4(a) required the winning
 * window to sit in a run where EVERY grammar-valid window satisfies §4.3
 * `checkDigitApplies`: a window whose position 9 is a letter was never tested, so failing
 * the check digit does not refute it, and a run holding one is ambiguous between "a VIN
 * with a stray neighbour" and "a printed no-check-digit identifier plus a chance-
 * validating overlap".
 *
 * That rule could not reach population 2 by construction — every window of a misread
 * North-American VIN's run carries a check digit, so the run IS settleable and 4(a)
 * settled it, on the straddle. Closing it needed §4.11 to change, because
 * `1HGCM82633A0043521` (a good VIN with a stray trailing character, which §4.11 required
 * to resolve) is the same 18-character two-window run as `B1HGCM82633A004353` (a misread
 * VIN with a stray leading character). §4.11 now says both are NO_VIN, and step 4(a) reads:
 * **a check-digit-valid window may be returned only when it is the whole run.** That
 * implies Z6's rule — a window that passes §4.3 has a digit or `X` at position 9, so a run
 * that is exactly one such window is a run every window of which is testable — so Z6's
 * rule is gone from `extractVin.ts` and its population is guarded through this one. Scope
 * is still the RUN and not the payload: a window in another run cannot overlap this one,
 * so §4.2's JSON and delimited-text cases still read. An identifier that is a run of its
 * own still reads through step 4(b), with `checkDigitValid: false` and no banner (§4.3).
 *
 * WHAT THESE TESTS ARE NOW. They were written as characterisation: they asserted the
 * hazard as it stood so that it stayed executable and went red the moment §4.2 was
 * corrected, exactly as `[A-01]` did before Zach ruled on Z1. Both moments have come, so
 * every describe below asserts a CLOSURE and is the regression guard for it; each keeps,
 * in its comment, the value its input used to return, because that record is what makes a
 * regression legible the day one arrives.
 */

import { describe, expect, it } from "vitest";

import { checkDigitApplies, isCheckDigitValid } from "./checkDigit";
import { extractVin } from "./extractVin";
import { countingRandom, mulberry32 } from "./rng.testutil";

/** A JCB backhoe PIN. Position 9 is `C`, so §4.3 says it carries no check digit at all. */
const PIN = "JCB4CX00CJ2345678";

/** The §4.11 reference VIN: grammar-valid, check digit valid. */
const VALID = "1HGCM82633A004352";

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
   * window unsettled the whole run: the check digit cannot say whether the printed
   * identifier is the PIN or the window that validated. Under R4-A the run is refused a
   * second way — no window in it is a run of its own — so §4.2 returns NO_VIN and the
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
    // And the refusal is the rule rather than the scan giving up on a hard payload: a
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
    // windows — and a two-window run is refused too, under Z6 because one window was
    // never tested and under R4-A because neither window is a run of its own.
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
   * The rate, measured rather than asserted from the rationale. Fixed seed (§13.2), so
   * this is a measurement and not a flake, and the generator is the shared mulberry32 in
   * `rng.testutil.ts` — the same one `bench/corpus.ts` draws the corpus with.
   *
   * RE-MEASURED FOR LEDGER R4-B. Every number in this test used to come off a hand-rolled
   * LCG whose state multiply overflowed 2^53; it cycled with period 10,466, so "3,000
   * trials" was 708 distinct payloads and the residue reported as 13 fabrications was 2
   * distinct payloads seen six times each. The numbers below are re-measured on the
   * corrected stream at the same seed and the same 3,000 trials, and the old ones are not
   * a comparable baseline — the population changed, not just the sample size. The
   * distinct-payload and distinct-draw floors at the bottom are here so this cannot
   * happen again silently; `[R4-B]` below asserts the generator itself.
   *
   * The identifier is NOT stamped with `expectedCheckDigit`, which is what makes this
   * generator the complement of round 1's: it draws all 17 characters freely and keeps
   * only the identifiers that do not validate. That mixes the two populations, so the
   * measurement splits them on §4.3 `checkDigitApplies`:
   *
   *   `untested` — position 9 a letter other than X, so no ISO 3779 check digit exists.
   *                This is the Z6 population, and it is zero: 0 of 1,994.
   *   `misread`  — position 9 a digit or X with the check digit simply wrong. Z6 did not
   *                reach it and was never meant to: every window in such a run can be
   *                asked, so the run IS settleable and step 4(a) settled it — on a window
   *                that is a straddle. That was the residue, 9 of 918 (0.98%) at this
   *                seed, and R4-A's whole-run rule closes it: 0 of 918.
   *
   * The same generator carried out to 200,000 trials — 194,083 distinct payloads, run
   * offline rather than in the gate — put the untested population at 0 of 133,328 and the
   * residue at 487 of 60,755, i.e. **0.80%, 95% CI [0.73%, 0.87%]**, the number ledger
   * R4-A was ruled on. Re-measured on the same 200,000 trials after the rule: **0 of
   * 133,328 and 0 of 60,755**. Both equalities below, not ceilings — §13.6 criterion 4 is
   * zero false accepts, not a low rate — and the sample floors stay, because a zero
   * measured over three payloads means nothing.
   */
  it("fabricates nothing out of either population, over a sample it asserts first", () => {
    const stream = countingRandom(20260904);
    const rng = stream.next;
    const pick = () => ALPHABET[Math.floor(rng() * ALPHABET.length)];
    let considered = 0;
    let fabricated = 0;
    const payloads = new Set<string>();
    const untested = { considered: 0, fabricated: 0, payloads: new Set<string>() };
    const misread = { considered: 0, fabricated: 0, payloads: new Set<string>() };
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
      const raw = `${prefix} ${identifier}`;
      payloads.add(raw);
      bucket.payloads.add(raw);
      const got = extractVin(raw);
      if (got !== null && got.vin !== identifier && got.checkDigitValid) {
        fabricated += 1;
        bucket.fabricated += 1;
      }
    }

    // The denominator the two zeros below are taken over, asserted rather than assumed:
    // 2,912 of the 3,000 draws are identifiers that do not validate, split 1,994 untested
    // / 918 misread. A rate of zero says nothing without it.
    expect(considered).toBe(untested.considered + misread.considered);
    expect(considered).toBeGreaterThanOrEqual(2900);
    // R4-B: the effective sample, not the trial count. Every payload here is distinct
    // (2,912 / 1,994 / 918 measured), so these floors sit just under the real numbers;
    // the broken LCG produced 708 / 478 / 230 and would fail all three by a wide margin.
    // A ceiling on a rate is only as good as the sample it was taken over, so the sample
    // is asserted first.
    expect(payloads.size).toBeGreaterThanOrEqual(2900);
    expect(untested.payloads.size).toBeGreaterThanOrEqual(1950);
    expect(misread.payloads.size).toBeGreaterThanOrEqual(900);
    // And the stream underneath them: 74,241 distinct values drawn here, against 16,707
    // for the old generator over the same ~74,000 draws — its whole reachable state space,
    // which is the defect stated as a number.
    expect(stream.distinct()).toBeGreaterThanOrEqual(70_000);

    // The Z6 population. An equality, not a ceiling: §13.6 criterion 4 is zero false
    // accepts, and a rule that refuses every unsettleable run has no reason to leak one.
    // 0 of 1,994 here, and 0 of 133,328 at 200,000 trials.
    expect(untested.fabricated).toBe(0);

    // The R4-A population, and this is the assertion that finding turns on. WAS a
    // ceiling — `< 0.02`, against a measured 9 of 918 (0.98%) — because the rule of the
    // day could not do better and a residue can only be bounded. It is an equality now:
    // §13.6 criterion 4 is zero, so the number this asserts is 0 and not "low". The
    // sample it is taken over is the 918 distinct payloads floored above.
    expect(misread.fabricated).toBe(0);
    // Overall, therefore: 0 of 2,912, against 9 (0.31%) before. Nothing in this generator
    // is ever read correctly either — the prefix always joins the run, so this whole
    // population is the undelimited multi-field text §4.2's "Known limit" refuses rather
    // than guesses at — so every trial is now a refusal, which is the trade N2 asks for.
    expect(fabricated).toBe(0);
  });
});

/**
 * [R4-B] The generator, asserted rather than assumed.
 *
 * Every measurement in this file and in `extractVin.adversary.test.ts` used to run on a
 * hand-rolled LCG, `seed = (seed * 1103515245 + 12345) & 0x7fffffff`. The multiply reaches
 * ~2.4e18 against a 2^53 exact-integer ceiling, so it loses its low bits and degenerates:
 * from every seed in use it runs a short tail and then cycles with period 10,466, reaching
 * 13,545-16,707 distinct values in total and never one more. §13.2's fixed seeds are for
 * reproducibility, and a reproducible sample four times smaller than the one being
 * reported is worse than an unseeded one, because it reads as evidence.
 *
 * mulberry32's state is a 32-bit counter with an odd stride, so its period is exactly 2^32
 * from any seed. This test does not restate that argument — it measures the consequence,
 * which is the thing the broken generator could not have faked.
 */
describe("[R4-B] the shared seeded generator does not degenerate", () => {
  const SEEDS_IN_USE = [20260904, 12345, 0x2c6b, 0x5aff];

  it.each(SEEDS_IN_USE)("draws ~100,000 distinct values from seed %d", (seed) => {
    const rand = mulberry32(seed);
    const seen = new Set<number>();
    for (let i = 0; i < 100_000; i += 1) seen.add(rand());
    // 2^32 outcomes and 1e5 draws: a handful of birthday collisions, no more — 99,994 to
    // 99,999 measured across these four seeds. The broken LCG saturates at 13,545-16,707
    // from the same seeds and cannot reach this floor at any draw count.
    expect(seen.size).toBeGreaterThanOrEqual(99_900);
  });

  it("is a pure function of its seed, so a recorded measurement stays reproducible", () => {
    const first = Array.from({ length: 32 }, mulberry32(20260904));
    const second = Array.from({ length: 32 }, mulberry32(20260904));
    expect(second).toEqual(first);
    expect(Array.from({ length: 32 }, mulberry32(20260905))).not.toEqual(first);
    // In [0, 1), which is what every `Math.floor(rng() * n)` in these files assumes.
    for (const value of first) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

/**
 * [R2-01 residue] CLOSED by ledger R4-A. This describe is the regression guard for it.
 *
 * Z6 closed the run that cannot be asked. This was the run that can: an ordinary
 * North-American VIN, misread in one character, with a stray §4.1-legal character beside
 * it. Position 9 is a digit in both windows, so §4.3 speaks for the whole run, the run is
 * settleable, and step 4(a) settled it — on the straddle, because the misread identifier
 * is the one window that fails. Z1 could not reach it either: a misread does not validate,
 * so it never competes. §6.3's two-read rule does not help — a 2D symbol decodes
 * identically every frame, and a 1D misread that repeats is exactly what the check digit
 * is supposed to catch.
 *
 * WHY IT STAYED OPEN, AND WHAT CHANGED. `B1HGCM82633A004353` and `1HGCM82633A0043521` are
 * the same shape: an 18-character run, two windows, exactly one passing §4.3. The first is
 * a misread VIN with a stray character in front; the second is a good VIN with a stray
 * character behind. §4.11 used to require the second to "extract the valid 17-window", so
 * any rule that resolved it fabricated the first, at 0.80% of such payloads (95% CI
 * [0.73%, 0.87%], 487 of 60,755). §4.11 now says both rows are NO_VIN — N2 prefers a
 * refusal to a guess, and the fixture yielded to the rule rather than the rule to the
 * fixture — so both are refused here, by the same rule, in the same test.
 *
 * THE RULE, named because this test is what guards it: **a check-digit-valid window may be
 * returned only when it is the whole run** (§4.2 step 4(a)). Z1's uniqueness and step 4(b)
 * are untouched; Z6's per-run testability rule is implied by this one and was removed
 * rather than left where it could never fire.
 */
describe("[R2-01 residue] §4.2 refuses a misread VIN beside a stray character (R4-A)", () => {
  it("returns NO_VIN where it returned a straddling window", () => {
    // WAS: { vin: "B1HGCM82633A00435", raw, checkDigitValid: true } — seventeen characters
    // nobody printed, marked valid, so D03 wrote it, §6.1 beeped it and the §6.3 mismatch
    // banner never appeared.
    expect(extractVin(`B${MISREAD}`)).toBeNull();
    // The straddle still passes §4.3. That is why nothing downstream could ever have
    // caught this: what changed is the run this function will answer for, not the check
    // digit. If this inverts, the fabrication was not what was fixed.
    expect(isCheckDigitValid(`B${MISREAD.slice(0, 16)}`)).toBe(true);

    const fabricated: string[] = [];
    const returned: string[] = [];
    for (const c of ALPHABET) {
      const got = extractVin(`${c}${MISREAD}`);
      if (got !== null) returned.push(c);
      if (got !== null && got.vin !== MISREAD && got.checkDigitValid) fabricated.push(c);
    }
    // WAS ["B", "K", "S", "2"]: four of the thirty-three §4.1 characters — one in eleven,
    // as §4.2's own rationale puts it — every one of them a wrong VIN shown as fact.
    expect(fabricated).toEqual([]);
    // And nothing is returned at all: the run is <c> + MISREAD, eighteen characters, so
    // neither window is a run of its own. Step 4(b) cannot rescue it either — that step
    // needs exactly one window, and there are two.
    expect(returned).toEqual([]);
    for (const c of ["B", "K", "S", "2"]) {
      expect(isCheckDigitValid(c + MISREAD.slice(0, 16)), c).toBe(true);
    }

    // The trailing half of the same shape, which used to fabricate for G, P, X and 7.
    const behind = ALPHABET.split("").filter((c) => extractVin(`${MISREAD}${c}`) !== null);
    expect(behind).toEqual([]);
  });

  it("refuses the §4.11 fixture that is the same shape, which is why this could be closed", () => {
    // `1HGCM82633A0043521`: a VALID VIN with one stray trailing character. Its two windows
    // are the good VIN and a straddle that fails, so it is `B${MISREAD}` with the passing
    // and failing windows swapped — and the bytes do not say which of the two payloads
    // this is. WAS: { vin: VALID, checkDigitValid: true }, required by §4.11 until the row
    // was amended for R4-A; NO_VIN now, and that is the whole reason the test above can
    // assert a refusal at all.
    expect(extractVin(`${VALID}1`)).toBeNull();
    expect(isCheckDigitValid(VALID)).toBe(true);
    expect(isCheckDigitValid(`${VALID}1`.slice(1))).toBe(false);
    // A run of its own still reads, so the rule refuses a shape and not a vehicle: the
    // user rescans or types, exactly as §4.2's "Known limit" says.
    expect(extractVin(VALID)).toEqual({ vin: VALID, raw: VALID, checkDigitValid: true });
  });
});
