/**
 * The capture screen's decisions, tested where they can actually be driven.
 *
 * These were inside `PaintCaptureScreen.tsx` until this file existed, which meant the only
 * way to reach them was a browser: `vitest.config.ts` pins `environment: "node"` with no
 * jsdom, so a rule in a React file has no unit test at all, and the e2e that stood in for
 * one measured whatever the screen happened to render rather than the rule itself.
 *
 * Every assertion below is about a claim the screen makes that nothing downstream can ever
 * contradict (N2): which strings a person is offered, what the heading says is true of
 * them, which characters are marked, and — the one that outlives the screen entirely —
 * what the record is told about where the characters came from.
 */
import { describe, expect, it } from "vitest";
import { OCR_LOW_CONFIDENCE, OCR_MARK_BELOW } from "../../lib/ocr/constants";
import type { OcrChar, OcrLine, OcrToken } from "../../lib/ocr/types";
import { isLowConfidence, voteOnLines, type PaintProposal } from "../../lib/ocr/vote";
import { CHECK_IT, LOW_HELP, PICK_ONE, PICK_UNSURE, nextEdit, proposalView } from "./proposalView";

const DOUBTED = OCR_MARK_BELOW - 30;
const SURE = 95;

function chars(text: string, confidences: readonly number[]): OcrChar[] {
  return [...text].map((char, index) => ({ char, confidence: confidences[index] ?? SURE }));
}

function token(text: string, confidence: number, per?: readonly number[]): OcrToken {
  return { text, confidence, chars: chars(text, per ?? []) };
}

/** One frame that read one token. */
function read(text: string, confidence: number, per?: readonly number[]): OcrLine {
  const one = token(text, confidence, per);
  return { text, confidence, chars: one.chars, tokens: [one] };
}

/** One frame of the label §5 describes: the paint code and the word beside it. */
function line(...parts: OcrToken[]): OcrLine {
  const text = parts.map((part) => part.text).join(" ");
  return { text, confidence: parts[0].confidence, chars: parts[0].chars, tokens: parts };
}

function vote(...lines: OcrLine[]): PaintProposal {
  const proposal = voteOnLines(lines);
  if (proposal === null) throw new Error("fixture read nothing");
  return proposal;
}

/** A clean read of one token: nothing doubted, nothing else on the line. */
const CLEAN = vote(read("NH-731P", 96), read("NH-731P", 94));
/** The same read with the `8` doubted, which is what puts lookalikes on screen. */
const DOUBTFUL = vote(read("WA8555", 85, [SURE, SURE, DOUBTED, SURE, SURE, SURE]));
/** Two different tokens off the same line — the case the crop box actually catches. */
const TWO_TOKENS = vote(line(token("PNT", 90), token("WA8555", 88)));
/**
 * Two frames that read the same token differently, each of them confidently.
 *
 * The one fixture that separates the candidate row's marks from the read's own: nothing
 * here is under the mark threshold, so `marked` is empty and every position the screen
 * underlines can only have come from the candidates disagreeing.
 */
const SPLIT = vote(read("WA8555", 92), read("WAB555", 88));

describe("what is offered, and what the heading may say about it", () => {
  it("offers one control for a clean read and asks the user to check it", () => {
    const view = proposalView(CLEAN, null);

    expect(view.controls.map((control) => control.text)).toEqual(["NH-731P"]);
    expect(view.several).toBe(false);
    expect(view.heading).toBe(CHECK_IT);
    // Nothing was doubted, so nothing is marked: §5's "marking everything marks nothing"
    // applies to marking the least-good character of a confident read too.
    expect(view.marks).toEqual([]);
    expect(view.showMarkedNote).toBe(false);
  });

  it("says `It read these` only when every string on offer is one a frame returned", () => {
    const view = proposalView(TWO_TOKENS, null);

    expect(view.controls.map((control) => control.text)).toEqual(["PNT", "WA8555"]);
    expect(view.several).toBe(true);
    expect(view.heading).toBe(PICK_ONE);
  });

  it("says it was unsure when a string on offer is one no frame ever returned", () => {
    const view = proposalView(DOUBTFUL, null);

    // The read, plus the lookalikes of the position it doubted (`confusion.ts`).
    expect(view.controls.map((control) => control.text)).toEqual(["WA8555", "WAB555"]);
    // "It read these" would be false about `WAB555`, which the engine never returned. A
    // heading that asserts something untrue about the control it is asking the user to
    // trust is the whole failure mode N2 has no downstream check for.
    expect(view.heading).toBe(PICK_UNSURE);
    expect(view.several).toBe(true);
  });
});

describe("what the record is told about the characters", () => {
  it("calls a string the engine returned `ocr`, and carries the engine's own confidence", () => {
    // Both tokens here were read; each keeps the confidence of its own reads rather than
    // the winner's, because the number describes the string it is attached to.
    expect(proposalView(TWO_TOKENS, null).controls).toEqual([
      { text: "PNT", source: "ocr", confidence: 90 },
      { text: "WA8555", source: "ocr", confidence: 88 },
    ]);
  });

  it("calls a synthesised lookalike typed, with no confidence at all", () => {
    // S5 addendum §5, and the line this slice exists to hold: `WAB555` is a shape argument
    // about one glyph, not a read. A person looked at the sticker and chose it, which is
    // exactly what the typed field is, and there is no read for a confidence to be about.
    expect(proposalView(DOUBTFUL, null).controls[1]).toEqual({
      text: "WAB555",
      source: "typed",
      confidence: null,
    });
  });

  it("calls a corrected string typed, however it was assembled", () => {
    const view = proposalView(DOUBTFUL, "WAB555");

    expect(view.controls).toEqual([{ text: "WAB555", source: "typed", confidence: null }]);
  });
});

describe("the marks", () => {
  it("marks the positions the read itself doubted, and only those", () => {
    const view = proposalView(DOUBTFUL, null);

    // Position 2 is the `8`. It is what `markedPositions` returned, carried through to
    // both the controls and the correction row.
    expect(DOUBTFUL.marked).toEqual([2]);
    expect(view.marks).toEqual([2]);
    expect(view.workingMarks).toEqual([2]);
  });

  it("marks nothing when the candidates are two unrelated tokens", () => {
    // `PNT` and `WA8555` differ at every position there is. Underlining all of both
    // teaches the user that the underline means nothing (§5).
    expect(proposalView(TWO_TOKENS, null).marks).toEqual([]);
  });

  it("marks where two candidates part company, not what the read doubted", () => {
    const view = proposalView(SPLIT, null);

    // Both frames were confident, so the read doubted nothing and `marked` is empty. The
    // underline in the controls is the disagreement between them and nothing else — §5's
    // "differing characters highlighted", which is a different question from §5's marks.
    expect(SPLIT.marked).toEqual([]);
    expect(view.controls.map((control) => control.text)).toEqual(["WA8555", "WAB555"]);
    expect(view.marks).toEqual([2]);
    // And the correction row does not borrow them: it edits one string, where a
    // disagreement between two has nothing to say.
    expect(view.workingMarks).toEqual([]);
  });

  it("says `check the marked characters` for a single read with a doubt, and not otherwise", () => {
    // Nothing doubted, nothing to check.
    expect(proposalView(CLEAN, null).showMarkedNote).toBe(false);
    // Doubted, but the lookalike put a second control on screen: the highlight between
    // them already says where to look, and the sentence would be pointing at a mark the
    // controls no longer carry for that reason.
    expect(DOUBTFUL.marked).toEqual([2]);
    expect(proposalView(DOUBTFUL, null).several).toBe(true);
    expect(proposalView(DOUBTFUL, null).showMarkedNote).toBe(false);
    // Edited: the marks are now the user's own change, which the sentence does not
    // describe either.
    expect(proposalView(DOUBTFUL, "WAB555").showMarkedNote).toBe(false);

    // One control, one doubt: `synthesiseAlternates` has nothing to offer for a `W`, so
    // this read stays a single offer and the sentence is the only thing pointing at it.
    const noLookalike = vote(read("WWWW", 70, [DOUBTED, SURE, SURE, SURE]));
    const view = proposalView(noLookalike, null);
    expect(view.several).toBe(false);
    expect(view.marks).toEqual([0]);
    expect(view.showMarkedNote).toBe(true);
  });
});

describe("the correction the user builds", () => {
  it("collapses the offer to the one string they built", () => {
    const view = proposalView(TWO_TOKENS, "WA8555X");

    // The alternatives were all about the position that has just been resolved. A row
    // that kept offering them would be asking a question that has been answered.
    expect(view.controls.map((control) => control.text)).toEqual(["WA8555X"]);
    expect(view.several).toBe(false);
    expect(view.heading).toBe(CHECK_IT);
  });

  it("marks what the user changed rather than what the engine doubted", () => {
    const view = proposalView(DOUBTFUL, "WA8S55");

    // Position 3 is what they changed; position 2 is what the engine was unsure of and is
    // no longer the thing to look at. The marks in the correction row agree with the ones
    // in the control, because they are the same claim.
    expect(view.marks).toEqual([3]);
    expect(view.workingMarks).toEqual([3]);
    expect(view.working).toBe("WA8S55");
  });

  it("edits the winner until there is an edit, and the edit after that", () => {
    // The winner rather than the last token on the line: the string in the control the
    // user is likeliest to tap is the one the row has to be able to fix.
    expect(proposalView(TWO_TOKENS, null).working).toBe("PNT");
    expect(proposalView(DOUBTFUL, "WAB555").working).toBe("WAB555");
  });

  it("treats picking the read's own character back as no edit at all", () => {
    // `confusionSet` includes the character already there, so this is the undo. It has to
    // land on *no edit* rather than an edit that happens to match: the other tokens, their
    // confidences and their `ocr` provenance all come back with it, and an edit equal to
    // the read would leave the user unable to save what the engine actually read.
    expect(nextEdit("WA8555", "WA8555")).toBeNull();
    expect(nextEdit("WA8555", "WAB555")).toBe("WAB555");

    const restored = proposalView(DOUBTFUL, nextEdit("WA8555", "WA8555"));
    expect(restored.controls).toEqual(proposalView(DOUBTFUL, null).controls);
    expect(restored.controls[0].source).toBe("ocr");
  });
});

describe("the line under a read the screen is not sure of", () => {
  /** Well above the line, and carrying one doubted character: both halves of the `or`. */
  const SURE_BUT_MARKED = vote(read("WA8555", SURE, [SURE, SURE, DOUBTED, SURE, SURE, SURE]));

  it("never states a confidence, because the trigger fires above the threshold (N2)", () => {
    // `isLowConfidence` is `confidence < OCR_LOW_CONFIDENCE || marked.length > 0`. This
    // read is 25 points clear of the threshold and still shows the sentence, so a sentence
    // opening "Low confidence." was telling the user a fact about it that was not true.
    expect(SURE_BUT_MARKED.confidence).toBeGreaterThan(OCR_LOW_CONFIDENCE);
    expect(SURE_BUT_MARKED.marked.length).toBeGreaterThan(0);
    expect(isLowConfidence(SURE_BUT_MARKED)).toBe(true);
    expect(LOW_HELP.toLowerCase()).not.toContain("confidence");
  });

  it("offers another read rather than diagnosing the one that just happened", () => {
    // §13.7 marks the 7° rotation figure synthetic and transferred from licence plates, so
    // "a tilt is what this gets wrong" was a claim about *this* read that nothing measured.
    // What is left has to stay conditional, and it has to stay actionable.
    expect(LOW_HELP.startsWith("If ")).toBe(true);
    expect(LOW_HELP).toContain("read again");
  });

  it("says nothing the Sheet refuses to say about the same number", () => {
    // The Sheet stores `paintConfidence` and renders it nowhere, for the reason §13.7
    // gives: there is no corpus of real stickers, so the percentage is uncalibrated. Two
    // screens may not rule opposite ways on one number.
    expect(LOW_HELP).not.toMatch(/\d/);
  });
});
