/**
 * §4.2 normalization: raw scan or paste to VIN. Pure: no DOM, no React, no I/O (P3).
 */

import { isCheckDigitValid } from "./checkDigit";
import { isVinGrammarValid, splitRuns, VIN_LENGTH } from "./grammar";
import type { ExtractResult } from "./types";

/** §4.2 step 1. `*` is the Code 39 start/stop pair, which some decoders pass through. */
const STRIP_RE = /[\s*]+/g;

interface VinWindow {
  vin: string;
  /** Position within the run it came from; §4.2 step 4a ranks on it. */
  offset: number;
  runLength: number;
}

/**
 * Returns null for NO_VIN. `raw` is echoed back unmodified so a record can keep
 * the exact bytes the decoder produced (§5.2).
 */
export function extractVin(raw: string): ExtractResult | null {
  const cleaned = raw.toUpperCase().replace(STRIP_RE, "");

  const windows: VinWindow[] = [];
  for (const run of splitRuns(cleaned)) {
    for (let offset = 0; offset + VIN_LENGTH <= run.length; offset += 1) {
      windows.push({ vin: run.slice(offset, offset + VIN_LENGTH), offset, runLength: run.length });
    }
  }
  const candidates = windows.filter((w) => isVinGrammarValid(w.vin));

  const valid = candidates.filter((w) => isCheckDigitValid(w.vin));
  if (valid.length > 0) {
    /**
     * §4.2 step 4a. Roughly one window in eleven passes the check digit by
     * chance, so in a run longer than 17 a window straddling two concatenated
     * identifiers can pass before the real VIN is reached. Prefer a window that
     * spans a whole run, then a run's start, then a run's end, then the first.
     */
    const chosen =
      valid.find((w) => w.runLength === VIN_LENGTH) ??
      valid.find((w) => w.offset === 0) ??
      valid.find((w) => w.offset === w.runLength - VIN_LENGTH) ??
      valid[0];
    return { vin: chosen.vin, raw, checkDigitValid: true };
  }

  /**
   * §4.2 step 4b. An identifier carrying no check digit is only locatable when
   * it is a run of its own; embedded in a longer run nothing distinguishes it
   * from its neighbours, so that case falls through to NO_VIN.
   */
  if (candidates.length === 1) {
    return { vin: candidates[0].vin, raw, checkDigitValid: false };
  }

  return null;
}
