/**
 * §4.2 normalization: raw scan or paste to VIN. Pure: no DOM, no React, no I/O (P3).
 */

import { isCheckDigitValid } from "./checkDigit";
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

  const windows: string[] = [];
  for (const run of splitRuns(cleaned)) {
    for (let offset = 0; offset + VIN_LENGTH <= run.length; offset += 1) {
      windows.push(run.slice(offset, offset + VIN_LENGTH));
    }
  }
  // §4.2 step 3, as a filter rather than a guard: runs are alphabet-only by construction,
  // so the predicate never fails and an `if` would leave an unreachable branch that the
  // §13.5 100%-branch gate on this file could never cover.
  const candidates = windows.filter(isVinGrammarValid);

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
  if (valid.length === 1) {
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
