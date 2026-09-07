/**
 * What the capture screen offers, what it calls it, and what it marks — decided here.
 *
 * The reason this is a module and not thirty lines inside `PaintCaptureScreen.tsx` is the
 * one `usePaintCapture.ts` states about itself: `vitest.config.ts` pins
 * `environment: "node"` with no jsdom, so **a rule that lives inside a React file cannot be
 * unit-tested in this repo at all**. It can only be reached through Playwright, and a
 * browser test reaches a decision through whatever it happens to have rendered — which is
 * how a test ends up asserting a neighbouring observable and passing forever. The repo's
 * answer to that is already written down three times over: `shareFile.ts`, `shareOutcome.ts`
 * and `copyTexts.ts` are all screen decisions lifted into a pure sibling for exactly this.
 *
 * Every rule below is one of S5 addendum §5's, and each is a thing nothing downstream can
 * check afterwards (N2 — a paint code has no check digit, no grammar and no lookup):
 *
 *   · which strings are offered, and at what weight;
 *   · which heading is true of that set of strings;
 *   · which positions are marked, and when marking is dropped entirely;
 *   · what provenance each control would store — `"ocr"` only for a string the engine
 *     actually returned.
 *
 * Pure: a proposal and the user's edit in, a description of the screen out. No DOM, no
 * React, no I/O.
 */
import { offeredCandidates, type OfferedCandidate } from "../../lib/ocr/confusion";
import { differingPositions, highlightedPositions, type PaintProposal } from "../../lib/ocr/vote";
import type { PaintSource } from "../../lib/vin/types";

/**
 * §5, and the only sentence on the capture screen doing real work. The engine is right
 * about 96 of 100 synthetic crops and there is no corpus of real stickers (§13.7), so
 * roughly 4 in 100 are wrong — undetectably, because a paint code has no check digit, no
 * grammar and no downstream lookup (N2). The heading says whose job that makes it.
 */
export const CHECK_IT = "Check this against the sticker before you save it.";

/** Several strings, every one of which some frame returned. */
export const PICK_ONE = "It read these. Pick the one on the sticker.";

/**
 * §5's other candidate row, and the reason it is worded differently from `PICK_ONE`.
 *
 * `PICK_ONE` is true when every control carries a string some frame returned. When one of
 * them was synthesised from the confusion table (`confusion.ts`) the engine never read it,
 * and a heading that said "It read these" would be the screen asserting something false
 * about the very control it is asking the user to trust (N2).
 */
export const PICK_UNSURE = "It wasn't sure of the marked characters. Pick the one on the sticker.";

/** One thing the screen offers to save, and what the record would say about it. */
export interface PaintControl {
  text: string;
  /**
   * S5 addendum §5: "persist `source: \"ocr\"` and the confidence". `"ocr"` is reserved
   * for a string the engine returned; a lookalike off `confusion.ts`'s table and a
   * per-character correction are strings no frame ever produced — a person looked at the
   * glyph and chose them — so they are stored exactly as the typed field is, and with no
   * confidence, because there is no read for a confidence to be about.
   */
  source: PaintSource;
  confidence: number | null;
}

export interface ProposalView {
  /** The one sentence above the controls, and it must be true of all of them. */
  heading: string;
  /** §5: nothing preselected, and — when there are several — nothing ranked either. */
  controls: PaintControl[];
  /** Several controls are drawn at equal weight; one is the primary. */
  several: boolean;
  /** Positions underlined inside the controls. */
  marks: number[];
  /** §5's "Check the marked characters.", which only means anything on a single offer. */
  showMarkedNote: boolean;
  /** The string the per-character correction row edits. */
  working: string;
  /** Positions underlined in that row. */
  workingMarks: number[];
}

function controlFor(candidate: OfferedCandidate): PaintControl {
  return candidate.origin === "read"
    ? { text: candidate.text, source: "ocr", confidence: candidate.confidence }
    : { text: candidate.text, source: "typed", confidence: null };
}

/**
 * The screen, as a value.
 *
 * `edited` is what the user built in the correction row, or null. It collapses the offer to
 * one control on purpose: the alternatives were all about the position they just resolved,
 * and a row that kept offering them beside the answer would be asking a question that has
 * been answered. The marks move with it — after an edit they say "this is not what it
 * read" rather than "this is what it was unsure of", which is a different and now more
 * useful sentence.
 */
export function proposalView(proposal: PaintProposal, edited: string | null): ProposalView {
  const offered: OfferedCandidate[] =
    edited === null
      ? offeredCandidates(proposal)
      : [{ text: edited, origin: "confusion", confidence: null }];
  const several = offered.length > 1;
  const synthesised = offered.some((candidate) => candidate.origin === "confusion");
  const changed = edited === null ? [] : differingPositions([proposal.text, edited]);

  return {
    heading: !several ? CHECK_IT : synthesised ? PICK_UNSURE : PICK_ONE,
    controls: offered.map(controlFor),
    several,
    // With several controls the mark is where they part company (§5: "differing characters
    // highlighted"), and `highlightedPositions` drops it when that is every position —
    // two unrelated tokens off the same label line differ everywhere, and underlining all
    // of both is §5's "marking everything marks nothing".
    marks: several
      ? highlightedPositions(offered.map((candidate) => candidate.text))
      : edited === null
        ? proposal.marked
        : changed,
    // §5's sentence is about the read's own doubts. Beside several controls the highlight
    // already says where to look, and after an edit the marks are the user's own change,
    // so in both cases the sentence would be pointing at something it does not describe.
    showMarkedNote: !several && edited === null && proposal.marked.length > 0,
    working: edited ?? proposal.text,
    workingMarks: edited === null ? proposal.marked : changed,
  };
}

/**
 * What a tap in the correction row leaves the screen holding.
 *
 * `confusionSet` includes the character that is already there, so picking the read's own
 * character back is how a correction is undone — and undone means *no edit*, not an edit
 * that happens to match, because the whole offer (the other tokens, their confidences,
 * their `"ocr"` provenance) has to come back with it. Anything else is a user who tapped
 * twice and can no longer save what the engine actually read.
 */
export function nextEdit(read: string, picked: string): string | null {
  return picked === read ? null : picked;
}
