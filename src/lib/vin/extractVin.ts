/**
 * §4.2 normalization: raw scan or paste to VIN. Pure: no DOM, no React, no I/O (P3).
 */

import { isCheckDigitValid } from "./checkDigit";
import { asciiUpper, isVinGrammarValid, splitRuns, VIN_LENGTH } from "./grammar";
import type { ExtractOutcome, ExtractResult, NoVin, NoVinReason } from "./types";

/** §4.2 step 1. `*` is the Code 39 start/stop pair, which some decoders pass through. */
const STRIP_RE = /[\s*]+/g;

/**
 * §4.2 step 1 on its own: ASCII-only uppercase, whitespace and `*` gone.
 *
 * Exported because a caller has to be able to ask *how much has been supplied* without
 * retyping the strip (§7 item 5) — the typed screen decides whether there is enough in the
 * field to say anything about, and counting §4.1 characters answered that wrong: the
 * report's `R25-1251-200622120` is eighteen characters of which sixteen are §4.1, so the
 * screen read it as half-typed and stayed silent. Step 1 is what §4.2 itself measures.
 *
 * `extractVinExplained` calls this and nothing else does the same work, so §4.2's first
 * step has one implementation.
 */
export function normalizeForExtract(raw: string): string {
  return asciiUpper(raw).replace(STRIP_RE, "");
}

/**
 * Returns null for NO_VIN. `raw` is echoed back unmodified so a record can keep
 * the exact bytes the decoder produced (§5.2).
 *
 * A projection of `extractVinExplained` and nothing else, so §4.2 has exactly one
 * implementation and the reason channel cannot decide anything the VIN channel does not
 * (§7 item 5). Every caller that only needs the answer keeps this signature.
 */
export function extractVin(raw: string): ExtractResult | null {
  const outcome = extractVinExplained(raw);
  return outcome.ok ? outcome.result : null;
}

/**
 * §4.2, with the branch that refused carried out as data (`NoVin`). The decision is the
 * one below and the only one: this function *is* §4.2, and `extractVin` above reads its
 * answer. Adding the reason moved no accept and no refusal — pinned by
 * `extractVin.reason.test.ts`, which asserts the two channels agree on every fixture and
 * every adversary payload in this directory.
 */
export function extractVinExplained(raw: string): ExtractOutcome {
  const cleaned = normalizeForExtract(raw);

  // §4.2 steps 2 and 3. Windows stay grouped by the run they came from: a window can only
  // straddle the boundary between two fields printed inside the SAME run, so a run is the
  // unit the check digit has to be trusted or distrusted over (step 4a below).
  const runs = splitRuns(cleaned);
  const perRun = runs.map((run) => {
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
    return { ok: true, result: { vin: valid[0]!, raw, checkDigitValid: true } };
  }

  /**
   * §4.2 step 4b, on window count rather than distinct VINs: an identifier carrying no
   * check digit is only locatable when it is a run of its own. A longer run of repeated
   * characters collapses to one distinct string, but the identifier still is not a run of
   * its own and reading one out of it would be a guess from noise.
   *
   * **An ambiguous run falls out here rather than being turned away above** (M9), and that
   * is not an omission: `valid` is a set of `candidates`, so more than one distinct VIN
   * validating means at least two windows, and a payload with two windows cannot satisfy
   * this test. An `if (valid.length > 1) return null;` above therefore stood in front of a
   * `return null` it could never change — a line no test could distinguish from its own
   * absence, which is precisely what `bun run mutate` reported and what 100% branch
   * coverage on this file could not see. §4.2 step 4a's refusal is unchanged and is pinned
   * by `[M2]` and the straddle suite; what is gone is a second, unobservable statement of
   * it. Anyone tempted to restore it should make step 4b weaker first — while it demands
   * *exactly one* window, ambiguity has nowhere else to go.
   */
  if (candidates.length === 1) {
    return { ok: true, result: { vin: candidates[0]!, raw, checkDigitValid: false } };
  }

  /**
   * NO_VIN, and which of step 4's branches said so. The evidence is gathered here rather
   * than alongside the algorithm above so that nothing on the accepting path depends on
   * it: the reason is read off the same three quantities the decision was taken on, after
   * the decision was taken.
   */
  return {
    ok: false,
    refusal: {
      reason: refusalReason(candidates.length, valid.length),
      raw,
      longestRun: longestRunOf(runs),
      windowCount: candidates.length,
      validCount: valid.length,
    } satisfies NoVin,
  };
}

/**
 * §4.2 step 2's longest run, which is the fact behind `no_run_of_17`: on a label carrying
 * no VIN the app knows what it did read and how long the longest unbroken piece of it
 * was. `""` when the text held no §4.1 character. Ties go to the earliest run — `>` and
 * not `>=` — so a caller quoting it quotes the first thing on the label, not the last.
 */
function longestRunOf(runs: readonly string[]): string {
  let longest = "";
  for (const run of runs) if (run.length > longest.length) longest = run;
  return longest;
}

/**
 * Which branch of step 4 refused, from the two counts the branch was taken on. Exclusive
 * and exhaustive in this order, and reachable only after both accepting returns above:
 *
 * - no window at all — nothing reached 17 §4.1 characters (`I`, `O`, `Q`, punctuation and
 *   whitespace are separators, so they shorten a run rather than failing a window);
 * - more than one distinct VIN passes §4.3 — the run is ambiguous and §4.2 refuses to
 *   rank (its "Why uniqueness and not precedence" paragraph);
 * - exactly one passes and step 4(a) still declined — so that window was not an entire
 *   run (R4-A);
 * - none passes, and more than one window exists — so step 4(b) cannot fire either.
 */
function refusalReason(windowCount: number, validCount: number): NoVinReason {
  if (windowCount === 0) return "no_run_of_17";
  if (validCount > 1) return "ambiguous";
  if (validCount === 1) return "not_whole_run";
  return "no_valid_window";
}
