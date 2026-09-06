/**
 * The lookalikes, and the alternatives they buy a person who is holding the phone.
 *
 * S5 addendum §5 names six confusions — `B/8`, `0/O/D/Q`, `1/I/L`, `5/S`, `2/Z`, `6/G` —
 * and names them for a reason that is the whole argument of this slice: an OCR confusion
 * comes from the **glyph's shape**, so it is identical on every frame of the same sticker
 * in the same light. Voting across frames cannot see it. Five frames agreeing on `WA8SSS`
 * is five frames agreeing, not five checks passing (N2).
 *
 * So the only thing that can catch one is a person reading the sticker, and the only way a
 * person can act on it is if the alternative is on screen as something they can tap.
 * tesseract.js hands us no alternatives to show: `Symbol` carries no `choices` in the
 * shipped types, and word alternates come from the Legacy engine while this build pins
 * `OEM.LSTM_ONLY` (`OCR_OEM`). They have to be synthesised, and this is where.
 *
 * Two rules hold the fabrication in check:
 *
 * 1. **Only at a position the read itself doubted** (`markedPositions`, under
 *    `OCR_MARK_BELOW`). Offering `WA8S55` beside a `5` the engine was 99% sure of is
 *    manufacturing a doubt that nothing measured, and §5's "marking everything marks
 *    nothing" applies to alternatives exactly as it applies to marks.
 * 2. **Only the six sets the addendum records.** Adding `U/V` or `C/G` because they look
 *    similar would be inventing evidence; the six are what the addendum measured this
 *    task against, and widening them is a spec question, not a code change.
 *
 * Nothing here ranks, scores or prefers. A synthesised string is offered at exactly the
 * same weight as the one the engine read, because the engine's confidence is the thing
 * being doubted — §5: equal-weight buttons, nothing preselected.
 *
 * Pure: strings and confidences in, strings out. No DOM, no React, no I/O (P3).
 */
import { OCR_CANDIDATES_MAX } from "./constants";
import type { OcrChar } from "./types";
import type { PaintProposal } from "./vote";

/**
 * S5 addendum §5's six confusion sets, verbatim and in its order.
 *
 * Every member is inside `OCR_CHAR_WHITELIST`, which `constants.test.ts` checks: a
 * character the engine is not allowed to return could never be a read to correct, and one
 * it is not allowed to return cannot be offered as a correction either.
 */
export const OCR_CONFUSION_SETS: readonly (readonly string[])[] = [
  ["B", "8"],
  ["0", "O", "D", "Q"],
  ["1", "I", "L"],
  ["5", "S"],
  ["2", "Z"],
  ["6", "G"],
];

/**
 * The set a character belongs to, including the character itself, or empty when it belongs
 * to none.
 *
 * The character is included on purpose: the correction UI renders this set, so tapping the
 * character that is already there is how a correction is undone. A set that excluded it
 * would make the first tap irreversible without a second control.
 */
export function confusionSet(char: string): readonly string[] {
  return OCR_CONFUSION_SETS.find((set) => set.includes(char)) ?? [];
}

/** The other members of `char`'s set, in the addendum's order. Empty when it has none. */
export function alternativesFor(char: string): string[] {
  return confusionSet(char).filter((member) => member !== char);
}

/** Whether tapping this character can offer anything — what the correction row disables on. */
export function hasAlternatives(char: string): boolean {
  return alternativesFor(char).length > 0;
}

/**
 * `text` with position `index` replaced. Out-of-range positions return the text unchanged
 * rather than growing it: a proposal whose `chars` array is shorter than its text is a
 * real shape (`charsOf`), and appending a character nobody read is the fabrication N2 is
 * about.
 */
export function replaceAt(text: string, index: number, char: string): string {
  if (index < 0 || index >= text.length) return text;
  return text.slice(0, index) + char + text.slice(index + 1);
}

/**
 * Single-substitution alternatives at the doubted positions, most doubtful first.
 *
 * Round-robin across the positions rather than exhausting the worst one: with two marks
 * there are two things the user has to check, and spending both slots on the first one
 * hides the second. Within a position the addendum's own set order decides, so the same
 * read always offers the same alternatives — a proposal that reshuffles between renders is
 * one nobody can learn to read.
 *
 * Only single substitutions. Two at once is a string two independent glyphs would both
 * have to be wrong to produce, and it crowds out the one-character alternative that is far
 * likelier — with three slots on screen, the crowding is the whole cost.
 */
export function synthesiseAlternates(
  text: string,
  chars: readonly OcrChar[],
  marked: readonly number[],
  limit: number,
): string[] {
  if (limit <= 0) return [];

  const options: { index: number; confidence: number; alternates: string[] }[] = [];
  for (const index of marked) {
    const at = chars[index];
    const char = text[index];
    // A position the read said nothing about is not a position the read doubted. `charsOf`
    // walks the shortest character list present, so a proposal whose text is longer than
    // its `chars` is a real shape — and offering a lookalike for a character no frame
    // reported a confidence for is inventing the doubt, which is the fabrication N2 is
    // about.
    // (`char === undefined` is the narrowing the line below needs; behaviourally it is
    // already covered by a character with no lookalike contributing nothing.)
    if (at === undefined || char === undefined) continue;
    // A doubted `W` is still doubted; this table simply has nothing to offer for it, and
    // the rotation below skips it every round. §5's route for a character with no
    // lookalike is the typed field, not an invented alternative.
    options.push({ index, confidence: at.confidence, alternates: alternativesFor(char) });
  }
  // Reading order is what `markedPositions` returns, because that is how the marks are
  // rendered. Here the least-certain position goes first: it is the one an alternative is
  // most likely to be needed for, and with one slot it is the one that gets it. Equal
  // confidences fall to reading order, so the same read always offers the same thing.
  options.sort((a, b) => a.confidence - b.confidence || a.index - b.index);
  const deepest = options.reduce((most, option) => Math.max(most, option.alternates.length), 0);

  // No dedupe, and none is needed: `alternativesFor` never returns the character it was
  // given, so a single substitution can never reproduce `text`, and two substitutions at
  // two different positions can never produce the same string. `marked` is
  // `markedPositions`'s output, whose indices are distinct. A filter here would be a branch
  // no input could walk — the kind this repo has shipped seven of — and the guarantee is
  // asserted where it actually lives, on `alternativesFor`. If this ever grows to
  // substitute two positions at once, that stops being true.
  const out: string[] = [];
  for (let round = 0; round < deepest; round += 1) {
    for (const option of options) {
      const alternate = option.alternates[round];
      if (alternate === undefined) continue;
      out.push(replaceAt(text, option.index, alternate));
      if (out.length === limit) return out;
    }
  }
  return out;
}

/** One thing the screen offers to save, and where the characters in it came from. */
export interface OfferedCandidate {
  text: string;
  /** `read`: some frame returned this exact string. `confusion`: synthesised above. */
  origin: "read" | "confusion";
  /**
   * The engine's mean confidence in this exact string, or **null** when no frame returned
   * it.
   *
   * Null rather than the winner's number, and rather than a discount of it. A synthesised
   * string is a shape argument about one glyph, not a read: the engine never scored it,
   * and carrying a confidence it did not produce is the one thing this whole slice exists
   * to prevent (N2). What is stored for such a string is `source: "typed"` — a person read
   * the sticker and chose it — and no confidence at all.
   */
  confidence: number | null;
}

/**
 * Everything the screen puts on a button, capped at §5's three, nothing preselected.
 *
 * When the frames returned more than one distinct token the offer is those tokens and
 * nothing else: the question on screen is then *which token on this line is the paint
 * code*, and mixing a lookalike of one of them into that row asks two questions in one
 * control. The typed field is the escape for the second one, and it is always present.
 *
 * When the frames returned exactly one token, the offer is that token plus the lookalikes
 * of the positions it doubted — which is the case §5 was written for, and the only case in
 * which this app has ever had an alternative to show.
 */
export function offeredCandidates(proposal: PaintProposal): OfferedCandidate[] {
  const read: OfferedCandidate[] = proposal.candidates.map((candidate) => ({
    text: candidate.text,
    origin: "read",
    confidence: candidate.confidence,
  }));
  if (read.length > 1) return read.slice(0, OCR_CANDIDATES_MAX);
  const alternates = synthesiseAlternates(
    proposal.text,
    proposal.chars,
    proposal.marked,
    OCR_CANDIDATES_MAX - read.length,
  );
  return [
    ...read,
    ...alternates.map((text) => ({ text, origin: "confusion" as const, confidence: null })),
  ];
}
