/**
 * Several reads of the same sticker, reduced to one proposal.
 *
 * S5 addendum §5, and the rule it exists to *not* break. Confidence-weighted majority over
 * a handful of frames bought 66.7% → 81% on licence plates, so it is worth doing; what it
 * buys is a better default string. It does **not** buy the right to skip the human, and
 * this file must never be read as if it did:
 *
 * §6.3's two-read rule works for a barcode because a bad decode comes from a bad *frame* —
 * glare, motion, a fold in the label — and the next frame is independently bad. An OCR
 * confusion (`B/8`, `0/O/D/Q`, `1/I/L`, `5/S`, `2/Z`, `6/G`) comes from the *glyph's
 * shape*, which is identical on every frame of the same sticker in the same light. Five
 * frames agreeing on `WA8SSS` is five frames agreeing, not five checks passing. Voting
 * kills transient garbage and nothing else.
 *
 * That is why nothing here returns a boolean, a threshold verdict or an "accepted" flag:
 * a `PaintProposal` is what a person is shown. N2 — a paint code has no check digit, no
 * grammar and no downstream lookup, so the person is the only check there is.
 *
 * Pure: lines in, a proposal out.
 */
import {
  OCR_CANDIDATES_MAX,
  OCR_LOW_CONFIDENCE,
  OCR_MARKED_MAX,
  OCR_MARK_BELOW,
} from "./constants";
import type { OcrChar, OcrLine, OcrToken } from "./types";

/** One token several frames read, and how much of the vote stood behind it. */
export interface PaintCandidate {
  text: string;
  /** Mean of the reads that produced this exact string, 0–100. */
  confidence: number;
  /** How many reads produced it. */
  frames: number;
}

export interface PaintProposal {
  text: string;
  /** The winning string's own mean confidence, 0–100. */
  confidence: number;
  /** The winner's share of the total weight, 0–1. One means every read agreed. */
  agreement: number;
  /** How many reads went into the vote at all (a read with no token is not a vote). */
  frames: number;
  /** Per position, averaged over the reads that voted for the winner. */
  chars: OcrChar[];
  /** §5: at most the two lowest-confidence positions, and only genuinely doubtful ones. */
  marked: number[];
  /** §5: at most three, winner first, nothing preselected by anything here. */
  candidates: PaintCandidate[];
}

interface Group {
  text: string;
  weight: number;
  frames: number;
  tokens: OcrToken[];
}

/** Negative or non-finite confidences carry no weight rather than subtracting from someone else's. */
function weightOf(token: OcrToken): number {
  return Number.isFinite(token.confidence) ? Math.max(token.confidence, 0) : 0;
}

/** Both call sites average over a group's own tokens, and a group always has at least one. */
function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Per-position confidence across the reads that agreed on the winning string.
 *
 * Walked over the shortest `chars` array present, because a line whose character list is
 * shorter than its text has nothing to say about the positions it does not carry, and
 * inventing a confidence for one is exactly the fabrication N2 is about.
 */
function charsOf(group: Group): OcrChar[] {
  const width = group.tokens.reduce(
    (shortest, token) => Math.min(shortest, token.chars.length),
    group.text.length,
  );
  const chars: OcrChar[] = [];
  for (let index = 0; index < width; index += 1) {
    const at = group.tokens.map((token) => token.chars[index]);
    chars.push({ char: at[0].char, confidence: mean(at.map((char) => char.confidence)) });
  }
  return chars;
}

/**
 * The positions worth looking at, and no others.
 *
 * §5: "Only the ≤2 lowest-confidence positions are marked. Marking everything marks
 * nothing." A position under the mark threshold is doubtful; if none are, none are marked,
 * because marking the least-good character of a confident read teaches the user to ignore
 * the marks.
 */
export function markedPositions(chars: readonly OcrChar[]): number[] {
  return chars
    .map((char, index) => ({ index, confidence: char.confidence }))
    .filter((entry) => entry.confidence < OCR_MARK_BELOW)
    .sort((a, b) => a.confidence - b.confidence || a.index - b.index)
    .slice(0, OCR_MARKED_MAX)
    .map((entry) => entry.index)
    .sort((a, b) => a - b);
}

/**
 * The confidence-weighted majority.
 *
 * Grouped by the exact token: a read of a different length is a read of something else,
 * and stitching per-position winners together would produce a string no frame ever
 * returned. Ties break by frame count and then by the order the reads arrived.
 *
 * `null` when nothing was read at all — which the screen says out loud rather than
 * dressing up as an empty proposal (P7).
 */
export function voteOnLines(lines: readonly OcrLine[]): PaintProposal | null {
  const groups = new Map<string, Group>();
  for (const line of lines) {
    for (const token of line.tokens) {
      const existing = groups.get(token.text);
      const group = existing ?? { text: token.text, weight: 0, frames: 0, tokens: [] };
      group.weight += weightOf(token);
      group.frames += 1;
      group.tokens.push(token);
      groups.set(token.text, group);
    }
  }
  // A read that found no token is not a vote for the empty string; it is not a vote. Every
  // read finding none is the `nothing` the screen says out loud (P7).
  if (groups.size === 0) return null;

  // Ties fall to the string that was read first: a `Map` iterates in insertion order and
  // `Array#sort` is stable, so the same five reads always propose the same thing. There is
  // no third comparator here on purpose — one that could never change an answer is one no
  // test could ever catch going wrong.
  const ranked = [...groups.values()].sort((a, b) => b.weight - a.weight || b.frames - a.frames);
  const winner = ranked[0] as Group;
  const totalWeight = ranked.reduce((total, group) => total + group.weight, 0);
  const totalFrames = ranked.reduce((total, group) => total + group.frames, 0);
  const chars = charsOf(winner);

  return {
    text: winner.text,
    confidence: mean(winner.tokens.map((token) => weightOf(token))),
    // Every read at confidence zero still agreed or disagreed, so the share falls back to
    // the frames rather than dividing by nothing and reporting `NaN` as agreement.
    agreement: totalWeight > 0 ? winner.weight / totalWeight : winner.frames / totalFrames,
    frames: totalFrames,
    chars,
    marked: markedPositions(chars),
    candidates: ranked.slice(0, OCR_CANDIDATES_MAX).map((group) => ({
      text: group.text,
      confidence: mean(group.tokens.map((token) => weightOf(token))),
      frames: group.frames,
    })),
  };
}

/**
 * Whether the screen should stop implying this read is good.
 *
 * Not a gate — nothing is auto-accepted at any confidence, so there is no threshold at
 * which this changes what happens (N2). It changes what is *said*: below it the screen
 * offers the one thing that actually helps, since rotation is the measured weak axis (7°
 * of tilt drops exact match from 96% to 83%) and §6.1 bans the gestures that would let the
 * box be turned instead.
 */
export function isLowConfidence(proposal: PaintProposal): boolean {
  return proposal.confidence < OCR_LOW_CONFIDENCE || proposal.marked.length > 0;
}

/**
 * The positions two or three candidates disagree about (§5: "differing characters
 * highlighted").
 *
 * When the vote is split, marking the *least confident* character of the winner would be
 * marking the wrong thing: what the user has to look at is where the candidates part
 * company. A position past the end of a shorter candidate is a disagreement too.
 */
export function differingPositions(texts: readonly string[]): number[] {
  const width = Math.max(...texts.map((text) => text.length));
  const positions: number[] = [];
  for (let index = 0; index < width; index += 1) {
    const first = texts[0][index];
    if (texts.some((text) => text[index] !== first)) positions.push(index);
  }
  return positions;
}
