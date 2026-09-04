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
   * Ledger R4-A, and the rest of that argument: uniqueness settles a run only when the
   * window that validated **is** the run. A run longer than 17 characters holds a window
   * per offset, and the one that passes §4.3 is no likelier to be the identifier than to
   * be a straddle across the boundary between the identifier and whatever was printed
   * beside it — because the identifier is the window that *fails*. `B1HGCM82633A004353`,
   * a misread North-American VIN with one stray legal character in front, used to come
   * back as `B1HGCM82633A00435`, marked valid; 4 of the 33 legal leading characters did
   * that to it, and it happened to 0.80% of such payloads (95% CI [0.73%, 0.87%], 487 of
   * 60,755).
   *
   * Nothing in the bytes separates that from `1HGCM82633A0043521` — a good VIN with one
   * stray character after it — which is the same 18-character run with the same two
   * windows, exactly one of them passing. §4.11 used to require the second to resolve,
   * which is what made the first irreducible; it now says both are NO_VIN, so both are
   * refused here. A window that is a run of its own is the only one returned as fact, and
   * an identifier printed beside another field is refused rather than guessed at, exactly
   * as §4.2's own "Known limit" says.
   *
   * This SUBSUMES ledger Z6's per-run testability rule rather than standing beside it, so
   * that rule is gone rather than kept where it could never fire: a window that passes
   * §4.3 has a digit or `X` at position 9, so a run consisting of exactly that window is a
   * run every window of which satisfies `checkDigitApplies`. Z6's population — an
   * off-highway machine PIN sharing a run with a field label, §4.7 — stays closed and is
   * still guarded by `[R2-F]` and `[R2-01]`; measured, both rules fabricate 0 of 133,328.
   * An identifier that is a run of its own still reads through step 4b below, with
   * `checkDigitValid: false` and no banner (§4.3).
   */
  const wholeRun = perRun.filter((windows) => windows.length === 1).flat();

  if (valid.length === 1 && wholeRun.includes(valid[0]!)) {
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
