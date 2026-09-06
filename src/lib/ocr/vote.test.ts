/**
 * The vote, and the thing the vote is not.
 *
 * Agreement across frames is worth having — it bought 66.7% → 81% on plates — and it is
 * worth nothing as a check: an OCR confusion comes from the glyph's shape and repeats on
 * every frame of the same sticker in the same light. So these tests pin what the vote
 * *produces* (a default string, an honest confidence, at most two marks, at most three
 * candidates) and there is deliberately nothing here that turns any of it into an
 * acceptance. §5, N2.
 */
import { describe, expect, it } from "vitest";
import {
  OCR_CANDIDATES_MAX,
  OCR_LOW_CONFIDENCE,
  OCR_MARKED_MAX,
  OCR_MARK_BELOW,
} from "./constants";
import type { OcrLine } from "./types";
import { isLowConfidence, markedPositions, voteOnLines } from "./vote";

/** A read, with one confidence for the line and the same for every character in it. */
function read(text: string, confidence: number, chars?: number[]): OcrLine {
  return {
    text,
    confidence,
    chars: [...text].map((char, index) => ({
      char,
      confidence: chars?.[index] ?? confidence,
    })),
  };
}

describe("voteOnLines", () => {
  it("takes the string the confidence stands behind, not the one seen most often", () => {
    // Three reads say WA8SSS at 40; two say WA8555 at 92. Counting heads gives the wrong
    // answer, which is the whole reason the vote is weighted.
    const proposal = voteOnLines([
      read("WA8SSS", 40),
      read("WA8555", 92),
      read("WA8SSS", 40),
      read("WA8555", 92),
      read("WA8SSS", 40),
    ])!;
    expect(proposal.text).toBe("WA8555");
    expect(proposal.confidence).toBeCloseTo(92);
    expect(proposal.frames).toBe(5);
    expect(proposal.agreement).toBeCloseTo(184 / 304);
  });

  it("reports full agreement when every read said the same thing", () => {
    const proposal = voteOnLines([read("NH-731P", 88), read("NH-731P", 90)])!;
    expect(proposal.agreement).toBe(1);
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.confidence).toBeCloseTo(89);
  });

  it("does not count a read that found nothing as a vote for nothing", () => {
    const proposal = voteOnLines([read("", 0), read("UG", 70), read("", 0)])!;
    expect(proposal.text).toBe("UG");
    expect(proposal.frames).toBe(1);
    expect(proposal.agreement).toBe(1);
  });

  it("says so when nothing was read at all, rather than proposing an empty string", () => {
    expect(voteOnLines([read("", 0), read("", 0)])).toBeNull();
    expect(voteOnLines([])).toBeNull();
  });

  it("offers at most three candidates, winner first, and nothing else", () => {
    const proposal = voteOnLines([
      read("1F7", 90),
      read("1F1", 80),
      read("1E7", 70),
      read("IF7", 60),
      read("1F7", 90),
    ])!;
    expect(proposal.candidates.map((candidate) => candidate.text)).toEqual(["1F7", "1F1", "1E7"]);
    expect(proposal.candidates).toHaveLength(OCR_CANDIDATES_MAX);
    expect(proposal.candidates[0]!.frames).toBe(2);
    expect(proposal.candidates[0]!.text).toBe(proposal.text);
  });

  it("averages each position over the reads that agreed, so a mark means something", () => {
    const proposal = voteOnLines([
      read("WA8555", 90, [95, 95, 95, 40, 95, 95]),
      read("WA8555", 90, [95, 95, 95, 60, 95, 95]),
    ])!;
    expect(proposal.chars).toHaveLength(6);
    expect(proposal.chars[3]!.confidence).toBeCloseTo(50);
    expect(proposal.chars[0]!.confidence).toBeCloseTo(95);
    expect(proposal.chars.map((char) => char.char).join("")).toBe("WA8555");
  });

  it("ignores confidences that are not numbers rather than letting one poison the vote", () => {
    const proposal = voteOnLines([
      { ...read("UG", Number.NaN) },
      { ...read("UG", -50) },
      read("LC9X", 10),
    ])!;
    // Two reads of UG carrying no weight lose to one real read; nothing returns NaN.
    expect(proposal.text).toBe("LC9X");
    expect(Number.isFinite(proposal.confidence)).toBe(true);
    expect(Number.isFinite(proposal.agreement)).toBe(true);
  });

  it("still reports a share when every read came back at zero confidence", () => {
    const proposal = voteOnLines([read("UG", 0), read("UG", 0), read("U6", 0)])!;
    expect(proposal.agreement).toBeCloseTo(2 / 3);
    expect(Number.isNaN(proposal.agreement)).toBe(false);
  });

  it("breaks a tie the same way every time it is asked", () => {
    const lines = [read("UG", 50), read("U6", 50)];
    expect(voteOnLines(lines)!.text).toBe("UG");
    expect(voteOnLines([...lines].reverse())!.text).toBe("U6");
    // Same input, same answer — twice, not by luck.
    expect(voteOnLines(lines)!.text).toBe(voteOnLines(lines)!.text);
  });

  it("says nothing about positions no read reported a character for", () => {
    // A line whose character list is shorter than its text: the missing positions have no
    // confidence, and inventing one is the fabrication this whole slice is about (N2).
    const short: OcrLine = { text: "WA8555", confidence: 80, chars: [{ char: "W", confidence: 80 }] };
    const proposal = voteOnLines([short])!;
    expect(proposal.chars).toHaveLength(1);
    expect(proposal.text).toBe("WA8555");
  });
});

describe("markedPositions", () => {
  const doubtful = OCR_MARK_BELOW - 30;

  it("marks at most two, and the two least certain", () => {
    const chars = [90, doubtful + 5, 92, doubtful, 91, doubtful + 10].map((confidence, index) => ({
      char: String(index),
      confidence,
    }));
    expect(markedPositions(chars)).toEqual([1, 3]);
    expect(markedPositions(chars).length).toBeLessThanOrEqual(OCR_MARKED_MAX);
  });

  it("marks nothing when nothing is doubtful, because marking everything marks nothing", () => {
    const chars = [95, 88, 91].map((confidence) => ({ char: "X", confidence }));
    expect(markedPositions(chars)).toEqual([]);
  });

  it("returns them in reading order, whatever order they were least certain in", () => {
    const chars = [10, 95, 20].map((confidence) => ({ char: "X", confidence }));
    expect(markedPositions(chars)).toEqual([0, 2]);
  });
});

describe("isLowConfidence", () => {
  it("is true below the line, and true whenever a position had to be marked", () => {
    const weak = voteOnLines([read("WA8555", OCR_LOW_CONFIDENCE - 1)])!;
    expect(isLowConfidence(weak)).toBe(true);

    const marked = voteOnLines([read("WA8555", 95, [95, 95, 95, 30, 95, 95])])!;
    expect(marked.marked).toEqual([3]);
    expect(isLowConfidence(marked)).toBe(true);
  });

  it("is false for a clean read, so the hint is not permanent furniture", () => {
    expect(isLowConfidence(voteOnLines([read("WA8555", 95)])!)).toBe(false);
  });
});
