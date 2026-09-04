/**
 * §4.2 normalization: raw scan or paste to VIN. Pure: no DOM, no React, no I/O (P3).
 */

import { checkDigitApplies, isCheckDigitValid } from "./checkDigit";
import { isVinGrammarValid, splitRuns, VIN_LENGTH } from "./grammar";
import type { ExtractResult } from "./types";

/** §4.2 step 1. `*` is the Code 39 start/stop pair, which some decoders pass through. */
const STRIP_RE = /[\s*]+/g;

/**
 * Returns null for NO_VIN. `raw` is echoed back unmodified so a record can keep
 * the exact bytes the decoder produced (§5.2).
 */
export function extractVin(raw: string): ExtractResult | null {
  const cleaned = raw.toUpperCase().replace(STRIP_RE, "");

  // §4.2 steps 2 and 3. Windows stay grouped by the run they came from: a window can only
  // straddle the boundary between two fields printed inside the SAME run, so a run is the
  // unit the check digit has to be trusted or distrusted over (step 4a below).
  const perRun = splitRuns(cleaned).map((run) => {
    const windows: string[] = [];
    for (let offset = 0; offset + VIN_LENGTH <= run.length; offset += 1) {
      windows.push(run.slice(offset, offset + VIN_LENGTH));
    }
    // §4.2 step 3, as a filter rather than a guard: runs are alphabet-only by construction,
    // so the predicate never fails and an `if` would leave an unreachable branch that the
    // §13.5 100%-branch gate on this file could never cover.
    return windows.filter(isVinGrammarValid);
  });
  const candidates = perRun.flat();

  /**
   * §4.2 step 4a. Roughly one window in eleven passes the check digit by chance, so a
   * window straddling the boundary between a VIN and whatever is printed next to it can
   * validate too — and nothing downstream can tell it from a real read, because the check
   * digit genuinely matches and a 2D code decodes identically every frame. So the check
   * digit only settles the answer when it settles it uniquely: distinct VINs that all
   * validate are an ambiguous run, and N2 says show nothing rather than pick one.
   *
   * Uniqueness is by VIN, not by window: the same VIN found at two offsets is one answer.
   */
  const valid = [...new Set(candidates.filter(isCheckDigitValid))];

  /**
   * Ledger Z6, and the other half of that argument: uniqueness only settles a run in which
   * every window can be *asked*. A window whose position 9 is a letter carries no ISO 3779
   * check digit at all (§4.3), so failing the check digit does not refute it — it was never
   * tested. An off-highway machine PIN is exactly that (§4.7 puts those vehicles in scope),
   * and it therefore loses a contest it could never enter: `PIN JCB4CX00CJ2345678` used to
   * come back as `NJCB4CX00CJ234567`, marked valid, because the one window that validated
   * was the straddle rather than the PIN. Such a run is not "one VIN and some refuted
   * neighbours"; it is a printed identifier and a chance-validating overlap, and the bytes
   * cannot say which is which. So the run is ambiguous and N2 refuses it, exactly as §4.2's
   * own "Known limit" already says: an identifier carrying no check digit yields NO_VIN
   * unless it is a run of its own — where step 4b, below, still returns it.
   *
   * Scoped to the run because that is where the hazard lives: a window in another run
   * cannot overlap this one, and §4.2's covered cases include a 2D code carrying JSON or
   * delimited text, whose other fields split off into runs of their own.
   */
  const settled = perRun.filter((windows) => windows.every(checkDigitApplies)).flat();

  if (valid.length === 1 && settled.includes(valid[0]!)) {
    return { vin: valid[0]!, raw, checkDigitValid: true };
  }
  if (valid.length > 1) return null;

  /**
   * §4.2 step 4b, on window count rather than distinct VINs: an identifier carrying no
   * check digit is only locatable when it is a run of its own. A longer run of repeated
   * characters collapses to one distinct string, but the identifier still is not a run of
   * its own and reading one out of it would be a guess from noise.
   */
  if (candidates.length === 1) {
    return { vin: candidates[0]!, raw, checkDigitValid: false };
  }

  return null;
}
