/**
 * [FR-2] The sentence a refused read gets, and the read itself.
 *
 * FR-1 kept §4.2's refusal as data and said nothing to anyone. This is the half a person
 * reads. Every assertion below is driven from a real `extractVinExplained` refusal rather
 * than a hand-built `NoVin`, so a sentence stays attached to the branch that produces it:
 * a reason renamed in `types.ts` or re-routed in `extractVin.ts` and not re-worded here
 * turns this file red rather than shipping the wrong explanation.
 *
 * **N2 is the constraint.** The app holds three things — the text it decoded, the length
 * of §4.2 step 2's longest run, and which branch refused — and it does not hold what the
 * string *is*. The last test in this file is the one that matters: no sentence here may
 * name a cause the bytes do not carry.
 */

import { describe, expect, it } from "vitest";

import { NOT_A_VIN, READ_LIMIT, refusalRead, refusalReason } from "./refusalText";
import { extractVinExplained } from "../lib/vin/extractVin";
import type { NoVin, NoVinReason } from "../lib/vin/types";

const VIN = "1HGCM82633A004352";
const BAD_CHECK = "1HGCM82633A004353";

/** The refusal §4.2 gives for `raw`, or a failure that says what came back instead. */
function refusalOf(raw: string): NoVin {
  const outcome = extractVinExplained(raw);
  if (outcome.ok) throw new Error(`expected NO_VIN, got ${outcome.result.vin}`);
  return outcome.refusal;
}

/** One payload per branch of §4.2 step 4, checked to be that branch before it is used. */
const BY_REASON: Record<NoVinReason, string> = {
  no_run_of_17: "R25-1251-200622120",
  ambiguous: `${VIN.slice(0, 16)}3${VIN}`,
  not_whole_run: `A${VIN}A`,
  no_valid_window: `${BAD_CHECK}1`,
};

describe("[FR-2] the read, as the screen shows it", () => {
  it("is the text that was read, byte for byte", () => {
    // The report's part number, and the reason the app can now quote it: the decoder's
    // own output, case, spaces, punctuation and all. Nothing is tidied — a user comparing
    // this against the sticker in front of them is comparing what came back.
    expect(refusalRead(refusalOf("R25-1251-200622120"))).toBe("R25-1251-200622120");
    expect(refusalRead(refusalOf("  p/n r25-1251-200622120  "))).toBe("  p/n r25-1251-200622120  ");
  });

  it("shows a read of exactly the limit whole", () => {
    const raw = "A".repeat(READ_LIMIT);
    expect(READ_LIMIT).toBe(48);
    expect(refusalRead(refusalOf(raw))).toBe(raw);
    expect(refusalRead(refusalOf(raw))).not.toContain("…");
  });

  it("cuts a longer read to the limit and marks the cut", () => {
    // §13.2's oversize payload reaches this: `raw` is unbounded, and a banner that grew
    // with it would push its own explanation off the screen.
    const long = refusalRead(refusalOf("B".repeat(100_000)));
    expect(long).toBe(`${"B".repeat(READ_LIMIT)}…`);
    expect([...long]).toHaveLength(READ_LIMIT + 1);
  });

  it("cuts on characters, not on UTF-16 units", () => {
    // A pasted payload can carry anything. Slicing mid-pair renders U+FFFD, which is a
    // character the label does not have — the one thing this line must never invent (N2).
    const raw = `${"C".repeat(READ_LIMIT - 1)}🚚🚚`;
    expect(refusalRead(refusalOf(raw))).toBe(`${"C".repeat(READ_LIMIT - 1)}🚚…`);
    expect(refusalRead(refusalOf(raw))).not.toContain("�");
  });
});

describe("[FR-2] why it is not a VIN, one sentence per §4.2 branch", () => {
  it("quotes the longest run when nothing reached 17 characters", () => {
    // The field report, exactly: eighteen characters on the label, sixteen of them §4.1,
    // and a longest run of nine, because the hyphens are separators (§4.2 step 2). The
    // number the app quotes is the one it measured.
    const refusal = refusalOf("R25-1251-200622120");
    expect(refusal.reason).toBe("no_run_of_17");
    expect(refusalReason(refusal)).toBe("No 17 characters in a row here — the longest run is 9.");
    // The other three fields off the same sticker, which are shorter still.
    expect(refusalReason(refusalOf("414556"))).toBe(
      "No 17 characters in a row here — the longest run is 6.",
    );
    expect(refusalReason(refusalOf("W06007C"))).toBe(
      "No 17 characters in a row here — the longest run is 7.",
    );
    // Nothing §4.1 in the text at all still states a fact rather than a special case.
    expect(refusalReason(refusalOf("//- ()"))).toBe(
      "No 17 characters in a row here — the longest run is 0.",
    );
  });

  it("counts the VINs when more than one validates", () => {
    const refusal = refusalOf(BY_REASON.ambiguous);
    expect(refusal.reason).toBe("ambiguous");
    expect(refusal.validCount).toBe(3);
    expect(refusalReason(refusal)).toBe(
      "3 different 17-character strings here could each be a VIN, and nothing says which.",
    );
    // §4.11's other ambiguity row: two, and the sentence counts what it found.
    const two = refusalOf(`B${VIN}`);
    expect(two.validCount).toBe(2);
    expect(refusalReason(two)).toBe(
      "2 different 17-character strings here could each be a VIN, and nothing says which.",
    );
    // The branch cannot produce a count of one, so the plural is never wrong.
    expect(two.validCount).toBeGreaterThan(1);
  });

  it("says where the VIN would start is unknown when one window validates inside a run", () => {
    const refusal = refusalOf(BY_REASON.not_whole_run);
    expect(refusal.reason).toBe("not_whole_run");
    expect(refusalReason(refusal)).toBe(
      "The 17 characters that could be a VIN sit inside a longer string, and nothing says where a VIN starts.",
    );
    // R4-A's two shapes — a stray character in front of a misread VIN, and a good VIN
    // with one after it — are one branch, so they are one sentence.
    expect(refusalReason(refusalOf(`${VIN}1`))).toBe(refusalReason(refusal));
  });

  it("names the check digit when several windows exist and none passes", () => {
    const refusal = refusalOf(BY_REASON.no_valid_window);
    expect(refusal.reason).toBe("no_valid_window");
    expect(refusalReason(refusal)).toBe(
      "None of the 17-character strings here has a matching check digit.",
    );
  });

  it("has a distinct sentence for every branch, and no branch without one", () => {
    // Exhaustive over §4.2 step 4: `NoVinReason` has four members, each payload is
    // checked to be the branch it claims, and no two branches share a sentence — an
    // explanation that collapsed two of them would explain neither.
    const reasons = Object.keys(BY_REASON) as NoVinReason[];
    expect(reasons).toHaveLength(4);
    const sentences = reasons.map((reason) => {
      const refusal = refusalOf(BY_REASON[reason]);
      expect(refusal.reason).toBe(reason);
      return refusalReason(refusal);
    });
    expect(new Set(sentences).size).toBe(4);
    for (const sentence of sentences) expect(sentence.endsWith(".")).toBe(true);
  });
});

describe("[FR-2] the sentence states what the app holds, and nothing else (N2)", () => {
  it("never names what the string is", () => {
    // The guess this whole finding exists to avoid. The label in the report was a
    // component sticker and the string was a part number, and the app cannot see either:
    // the next read is a pallet tag, an asset number or a shipping label, and a sentence
    // that named one of them would be wrong on the rest. It says what the text is not.
    const guesses = [
      "part number",
      "looks like",
      "probably",
      "wrong sticker",
      "component",
      "serial number",
      "seems",
      "maybe",
    ];
    for (const reason of Object.keys(BY_REASON) as NoVinReason[]) {
      const sentence = refusalReason(refusalOf(BY_REASON[reason])).toLowerCase();
      for (const guess of guesses) expect(sentence).not.toContain(guess);
    }
  });

  it("never blames the person holding the phone (§6.4)", () => {
    for (const reason of Object.keys(BY_REASON) as NoVinReason[]) {
      const sentence = refusalReason(refusalOf(BY_REASON[reason])).toLowerCase();
      expect(sentence).not.toContain("you ");
      expect(sentence).not.toContain("your ");
      // No apology and no hedge: §6.4's voice says what happened.
      expect(sentence).not.toContain("sorry");
      expect(sentence).not.toContain("unfortunately");
    }
  });

  it("titles the state in §6.4's own words", () => {
    // Not a new sentence: §6.4 gives this to the typed path, and the scan screen now says
    // it about the same fact rather than coining a second one (§7 item 5).
    expect(NOT_A_VIN).toBe("Not a VIN yet");
  });
});
