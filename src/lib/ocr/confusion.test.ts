/**
 * The lookalikes, and the discipline on inventing one.
 *
 * Every test here is about a string the engine never returned being put in front of a
 * person. That is a dangerous thing to do and §5 permits it for one reason: an OCR
 * confusion repeats on every frame, so the vote cannot see it and the alternative is only
 * ever going to come from a table. The tests therefore pin both directions — that the
 * alternative *is* offered where the read doubted itself, and that it is **not** offered
 * anywhere else (N2: nothing downstream can contradict a wrong paint code).
 */
import { describe, expect, it } from "vitest";
import {
  OCR_CONFUSION_SETS,
  alternativesFor,
  confusionSet,
  hasAlternatives,
  offeredCandidates,
  replaceAt,
  synthesiseAlternates,
} from "./confusion";
import { OCR_CANDIDATES_MAX, OCR_CHAR_WHITELIST, OCR_MARK_BELOW } from "./constants";
import type { OcrChar, OcrLine, OcrToken } from "./types";
import { voteOnLines } from "./vote";

const DOUBTED = OCR_MARK_BELOW - 30;
const SURE = 95;

function chars(text: string, confidences: readonly number[]): OcrChar[] {
  return [...text].map((char, index) => ({ char, confidence: confidences[index] ?? SURE }));
}

function token(text: string, confidence: number, per?: readonly number[]): OcrToken {
  return { text, confidence, chars: chars(text, per ?? []) };
}

function read(text: string, confidence: number, per?: readonly number[]): OcrLine {
  const one = token(text, confidence, per);
  return { text, confidence, chars: one.chars, tokens: [one] };
}

describe("the table", () => {
  it("is the six sets S5 addendum §5 records, and no others", () => {
    // Widening this is a spec question, not a code change: every extra pair is a wrong
    // string offered at equal weight to a right one, on a field nothing downstream checks.
    expect(OCR_CONFUSION_SETS.map((set) => set.join(""))).toEqual([
      "B8",
      "0ODQ",
      "1IL",
      "5S",
      "2Z",
      "6G",
    ]);
  });

  it("offers only characters the engine is allowed to return", () => {
    // A correction the whitelist forbids could never have been read in the first place,
    // and would leave a paint code carrying a character no read could produce.
    for (const member of OCR_CONFUSION_SETS.flat()) {
      expect(OCR_CHAR_WHITELIST.includes(member), member).toBe(true);
    }
  });

  it("keeps the character itself in its own set, so a correction can be undone", () => {
    expect(confusionSet("5")).toEqual(["5", "S"]);
    expect(confusionSet("0")).toEqual(["0", "O", "D", "Q"]);
  });

  it("says a character with no lookalike has none, rather than guessing one", () => {
    expect(confusionSet("W")).toEqual([]);
    expect(alternativesFor("W")).toEqual([]);
    expect(hasAlternatives("W")).toBe(false);
    expect(hasAlternatives("8")).toBe(true);
  });

  it("lists the others in the addendum's order", () => {
    expect(alternativesFor("0")).toEqual(["O", "D", "Q"]);
    expect(alternativesFor("Q")).toEqual(["0", "O", "D"]);
    expect(alternativesFor("B")).toEqual(["8"]);
  });
});

describe("replaceAt", () => {
  it("swaps one position and leaves the length alone", () => {
    expect(replaceAt("WA8555", 3, "S")).toBe("WA8S55");
    expect(replaceAt("WA8555", 0, "V")).toBe("VA8555");
    expect(replaceAt("WA8555", 5, "S")).toBe("WA855S");
  });

  it("refuses a position outside the string rather than growing it", () => {
    // A proposal whose `chars` is shorter than its text is a real shape (`charsOf`), and
    // a character nobody read must not be appended to a paint code (N2).
    expect(replaceAt("UG", 2, "6")).toBe("UG");
    expect(replaceAt("UG", -1, "6")).toBe("UG");
  });
});

describe("synthesiseAlternates", () => {
  it("substitutes only where the read doubted itself", () => {
    const text = "WA8555";
    // Position 3 is the only one under the mark threshold.
    const confidences = [SURE, SURE, SURE, DOUBTED, SURE, SURE];
    expect(synthesiseAlternates(text, chars(text, confidences), [3], 2)).toEqual(["WA8S55"]);
    // The same string with nothing marked offers nothing: §5's "marking everything marks
    // nothing" applied to alternatives. Every `5` here has a lookalike and none is offered.
    expect(synthesiseAlternates(text, chars(text, confidences), [], 2)).toEqual([]);
  });

  it("takes the least certain position first, so one slot goes to the worst one", () => {
    const text = "B0";
    const per = [40, 20];
    // Marked arrives in reading order; position 1 is the less certain of the two.
    expect(synthesiseAlternates(text, chars(text, per), [0, 1], 1)).toEqual(["BO"]);
    expect(synthesiseAlternates(text, chars(text, [20, 40]), [0, 1], 1)).toEqual(["80"]);
  });

  it("gives each doubted position one alternative before giving any of them two", () => {
    const text = "B0";
    // `0` has three lookalikes and `B` has one. Exhausting the worst position first would
    // return O and D and never mention B at all.
    expect(synthesiseAlternates(text, chars(text, [40, 20]), [0, 1], 3)).toEqual([
      "BO",
      "80",
      "BD",
    ]);
  });

  it("never offers back the string it was given", () => {
    // The guarantee is `alternativesFor`'s, not a filter's: a lookalike is by definition a
    // *different* character, so a single substitution cannot reproduce the read. A version
    // that offered the character its own set contains would put `Save WA8555` on screen
    // twice, which reads as two independent reads agreeing.
    const text = "5S";
    const alternates = synthesiseAlternates(text, chars(text, [10, 20]), [0, 1], 3);
    expect(alternates).not.toContain(text);
    expect(alternates).toEqual(["SS", "55"]);
  });

  it("stops at the number of slots the screen has left", () => {
    const text = "0";
    expect(synthesiseAlternates(text, chars(text, [10]), [0], 2)).toEqual(["O", "D"]);
    expect(synthesiseAlternates(text, chars(text, [10]), [0], 0)).toEqual([]);
  });

  it("says nothing about a position the read reported no character for", () => {
    // Two real shapes, both of which must produce nothing rather than a string with
    // `undefined` spliced into it. `charsOf` walks the shortest character list present, so
    // a proposal whose text is longer than its `chars` is something the vote really emits.
    expect(synthesiseAlternates("UG", chars("UG", [10, 10]), [5], 3)).toEqual([]);
    expect(synthesiseAlternates("WA8555", chars("WA8", [10, 10, 10]), [4], 3)).toEqual([]);
    // And a position with no character *and* one with a lookalike: the first contributes
    // nothing and does not stop the second being offered.
    expect(synthesiseAlternates("0G", chars("0G", [10, 10]), [5, 0], 2)).toEqual(["OG", "DG"]);
  });

  it("offers nothing for a doubted character the table has no lookalike for", () => {
    // A `W` the engine was unsure of is still unsure; this table simply has nothing to say
    // about it, and §5's route for that is the typed field, not an invented alternative.
    const text = "WA8555";
    expect(synthesiseAlternates(text, chars(text, [10]), [0], 3)).toEqual([]);
    // It also does not hold a slot in the rotation: the doubted `5` gets both of them.
    expect(synthesiseAlternates(text, chars(text, [10, SURE, SURE, 20]), [0, 3], 2)).toEqual([
      "WA8S55",
    ]);
  });

  it("falls to reading order when two positions were doubted equally", () => {
    // Same read, same offer, every time it is rendered.
    expect(synthesiseAlternates("B0", chars("B0", [20, 20]), [0, 1], 1)).toEqual(["80"]);
    expect(synthesiseAlternates("B0", chars("B0", [20, 20]), [1, 0], 1)).toEqual(["80"]);
  });

  it("keeps rotating once a position has run out of lookalikes", () => {
    // `B` has one alternative and `0` has three, and here `B` is the *less* certain of the
    // two, so it leads the rotation and runs dry first. Past the first round there is
    // nothing left to take from it, and the rotation has to carry on with the position
    // that still has some rather than ending the round at the short one.
    expect(synthesiseAlternates("B0", chars("B0", [20, 40]), [0, 1], 9)).toEqual([
      "80",
      "BO",
      "BD",
      "BQ",
    ]);
  });
});

describe("offeredCandidates", () => {
  it("offers one control when one token was read and nothing was doubted", () => {
    // The §5 case the primary control is for: `Save NH-731P`, value inside the button.
    const proposal = voteOnLines([read("NH-731P", 96), read("NH-731P", 94)])!;
    expect(offeredCandidates(proposal)).toEqual([
      { text: "NH-731P", origin: "read", confidence: 95 },
    ]);
  });

  it("offers the lookalikes of a doubted position beside the read", () => {
    const proposal = voteOnLines([read("WA8555", 85, [SURE, SURE, SURE, DOUBTED, SURE, SURE])])!;
    expect(proposal.marked).toEqual([3]);
    expect(offeredCandidates(proposal)).toEqual([
      { text: "WA8555", origin: "read", confidence: 85 },
      // Null, not a discount of 85: no frame ever returned this string, and a confidence
      // the engine did not produce is the fabrication this slice exists to prevent (N2).
      { text: "WA8S55", origin: "confusion", confidence: null },
    ]);
  });

  it("never mixes a synthesised string into a row about which token is the code", () => {
    // Two tokens on the aimed line, and the winner has a doubted position. The question on
    // screen is which token is the paint code; a lookalike of one of them in the same row
    // asks two questions in one control. The typed field is the escape for the second.
    const line: OcrLine = {
      text: "PNT WA8555",
      confidence: 80,
      chars: [],
      tokens: [
        token("WA8555", 85, [SURE, SURE, SURE, DOUBTED, SURE, SURE]),
        token("PNT", 84),
      ],
    };
    const proposal = voteOnLines([line])!;
    expect(proposal.marked).toEqual([3]);
    const offered = offeredCandidates(proposal);
    expect(offered.map((candidate) => candidate.origin)).toEqual(["read", "read"]);
    expect(offered.map((candidate) => candidate.text)).toEqual(["WA8555", "PNT"]);
  });

  it("never puts more than §5's three on screen, whatever the read doubted", () => {
    // Every position doubted, and every one of them a lookalike: 0 alone has three.
    const text = "00";
    const proposal = voteOnLines([read(text, 40, [10, 20])])!;
    const offered = offeredCandidates(proposal);
    expect(offered.length).toBeLessThanOrEqual(OCR_CANDIDATES_MAX);
    expect(offered[0]).toEqual({ text, origin: "read", confidence: 40 });
    expect(offered.slice(1).map((candidate) => candidate.confidence)).toEqual([null, null]);
    expect(new Set(offered.map((candidate) => candidate.text)).size).toBe(offered.length);
  });
});
