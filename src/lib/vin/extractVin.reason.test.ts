/**
 * [FR-1] §4.2's refusal, carried out as data.
 *
 * A mechanic scanned a DYNACRAFT (a division of PACCAR) COMPONENT label on a 2013
 * Kenworth — three Code 128 symbols, one per field, and not the federal certification
 * label — and the app refused every one of them. The refusal is correct and stays
 * correct: this file asserts the refusals as loudly as it asserts the reasons. What the
 * app could not do was say *why*, so the label had to be photographed and shown to a
 * person.
 *
 * The reason is a fact the algorithm already had and threw away. It is data here and
 * words nowhere: the sentence a user reads belongs to the feature layer (§6.4), and a
 * cause the bytes do not carry — "that is a part number", "you are at the wrong sticker"
 * — is a guess and is never stated at all (N2).
 *
 * **The decision did not move.** Every assertion below pairs the reason with the answer
 * `extractVin` gives for the same input, and the last describe runs both channels over
 * the §4.11 fixtures, this directory's adversary payloads and a seeded corpus, requiring
 * them to agree byte for byte. §4.2 is a §4 constant; a reason channel that changed one
 * outcome would be a change to it (N6).
 */

import { describe, expect, it } from "vitest";

import { expectedCheckDigit, isCheckDigitValid } from "./checkDigit";
import { extractVin, extractVinExplained } from "./extractVin";
import { countingRandom } from "./rng.testutil";
import type { NoVin } from "./types";

const VIN = "1HGCM82633A004352";
const BAD_CHECK = "1HGCM82633A004353";
/** An off-highway machine PIN: position 9 is a letter, so §4.3 never tests it (§4.7). */
const PIN = "JCB4CX00CJ2345678";
/**
 * A VIN whose check digit passes, used doubled: printing it twice with nothing between
 * puts **one** VIN at two window offsets, which is the only shape that separates §4.2 step
 * 4(a)'s distinct count from a window count.
 */
const REPEATED = "WKU9ZU57X9GG9BNAC";
const ALPHABET = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";

/** The refusal, or a failure that names what came back instead. */
function refusalOf(raw: string): NoVin {
  const outcome = extractVinExplained(raw);
  if (outcome.ok) throw new Error(`expected NO_VIN, got ${outcome.result.vin}`);
  // The pairing that keeps this file honest: a reason exists exactly where §4.2 refuses.
  expect(extractVin(raw)).toBeNull();
  return outcome.refusal;
}

/**
 * The label from the report, field by field, transcribed from the photograph. The part
 * number is 16 characters with its hyphens out and never reaches a 17-character window —
 * but the hyphens are separators (§4.2 step 2), so what the app actually holds is a
 * longest run of 9. That distinction is the whole point of carrying the evidence: the
 * number the app can quote is the one it measured, not the one a reader would count.
 */
describe("[FR-1] the DYNACRAFT component label, field by field", () => {
  it.each([
    ["part number", "R25-1251-200622120", "200622120", 9],
    ["chassis number", "414556", "414556", 6],
    ["sequence number", "W06007C", "W06007C", 7],
    ["vendor code", "12310LA", "12310LA", 7],
    ["date", "11/04/2013", "2013", 4],
  ])("refuses the %s, and knows the longest run was %s", (_field, raw, run, length) => {
    const refusal = refusalOf(raw);
    expect(refusal.reason).toBe("no_run_of_17");
    expect(refusal.longestRun).toBe(run);
    expect(refusal.longestRun.length).toBe(length);
    // Nothing reached 17 characters, so no window was ever built and none could validate.
    expect(refusal.windowCount).toBe(0);
    expect(refusal.validCount).toBe(0);
  });

  it("hands back the text it read, byte for byte", () => {
    // What the decoder produced, spaces, case and all — the app can quote the read
    // without re-deriving it, and quoting it is the one thing it could not do before.
    const raw = "  p/n r25-1251-200622120  ";
    expect(refusalOf(raw).raw).toBe(raw);
    expect(refusalOf(raw).longestRun).toBe("200622120");
  });
});

describe("[FR-1] `no_run_of_17` — the longest run is the fact", () => {
  it("reports the longest run and not the first or the last", () => {
    // Runs of 3, 4 and 9: the answer is the third of them, so neither end wins by
    // position. `1251` is between them so a maximum that only ever moved forwards or
    // only ever backwards would be caught.
    expect(refusalOf("R25-1251-200622120").longestRun).toBe("200622120");
    expect(refusalOf("200622120-1251-R25").longestRun).toBe("200622120");
  });

  it("keeps the earliest run when two are the longest", () => {
    // A tie is settled by position and settled the same way every time, so a caller
    // quoting the run quotes something stable.
    expect(refusalOf("414556/W06007").longestRun).toBe("414556");
    expect(refusalOf("W06007/414556").longestRun).toBe("W06007");
  });

  it('is `""` when nothing in the text is a §4.1 character', () => {
    expect(refusalOf("")).toEqual({
      reason: "no_run_of_17",
      raw: "",
      longestRun: "",
      windowCount: 0,
      validCount: 0,
    });
    expect(refusalOf("//- ()").longestRun).toBe("");
  });

  it("counts the run I, O and Q left behind, because they separate rather than disqualify", () => {
    // §4.2 step 2, and the correction this file exists to record: there is no branch in
    // which a 17-character window is thrown out for holding an excluded letter. `I`, `O`
    // and `Q` are separators, so they shorten the run instead — the app knows the piece
    // that survived, not "the character that disqualified it".
    const refusal = refusalOf("1HGCM8263IA004352");
    expect(refusal.reason).toBe("no_run_of_17");
    expect(refusal.longestRun).toBe("1HGCM8263");
    expect(refusal.windowCount).toBe(0);
    // Same for the run a space fused and a hyphen split, and for 16 characters flat.
    expect(refusalOf("1HGCM82633A00435").longestRun).toBe("1HGCM82633A00435");
    expect(refusalOf("QQQ-000/ 12345 *** IOI").longestRun).toBe("12345");
  });
});

describe("[FR-1] the three branches that refuse a run long enough to hold a VIN", () => {
  it("`ambiguous` — more than one distinct VIN passes §4.3 (§4.2 step 4(a))", () => {
    // §4.11's two-identifiers-run-together row. §4.2 refuses to rank them, and the count
    // is what the app holds: three distinct validating VINs among eighteen windows.
    const refusal = refusalOf("1HGCM82633A0043531HGCM82633A004352");
    expect(refusal.reason).toBe("ambiguous");
    expect(refusal.validCount).toBe(3);
    expect(refusal.windowCount).toBe(18);
    expect(refusal.longestRun).toBe("1HGCM82633A0043531HGCM82633A004352");

    // §4.11's other ambiguity row: one stray legal character in front makes the offset-0
    // window validate by chance, so two distinct VINs validate over two windows.
    const prefixed = refusalOf(`B${VIN}`);
    expect(prefixed.reason).toBe("ambiguous");
    expect(prefixed.validCount).toBe(2);
    expect(isCheckDigitValid("B1HGCM82633A00435")).toBe(true);
  });

  it("`not_whole_run` — one window validates and it is not the whole run (R4-A)", () => {
    // A 19-character run whose only validating window sits at offset 1. The app knows
    // there were three windows and that one of them passed; it does not know which of
    // the three was printed, and that is exactly what R4-A refuses to guess.
    const refusal = refusalOf(`A${VIN}A`);
    expect(refusal.reason).toBe("not_whole_run");
    expect(refusal.windowCount).toBe(3);
    expect(refusal.validCount).toBe(1);
    expect(refusal.longestRun).toBe(`A${VIN}A`);

    // §4.11's 18-character row, both of its shapes — a good VIN with a stray character
    // after it, and Z6's machine PIN behind a field label. Same branch, because the
    // bytes really do not distinguish them.
    expect(refusalOf(`${VIN}1`).reason).toBe("not_whole_run");
    expect(refusalOf(`PIN ${PIN}`).reason).toBe("not_whole_run");
    // `P` and `IN` split off: `I` is a separator, so the run under test starts at `N`.
    expect(refusalOf(`PIN ${PIN}`).longestRun).toBe(`N${PIN}`);
  });

  it("counts distinct VINs and not windows, so one VIN printed twice is one answer", () => {
    // §4.2 step 4(a)'s own sentence — "Uniqueness in (a) is by VIN, not by window" — which
    // is the one property of this refusal that 100% branch coverage cannot see, because
    // `new Set(...)` is not a branch. `REPEATED` passes §4.3 and is printed twice with
    // nothing between it, so the run is 34 characters and holds eighteen windows, two of
    // which validate — and they are the same VIN, so exactly one distinct VIN validates
    // and R4-A refuses it for not being a run of its own.
    expect(isCheckDigitValid(REPEATED)).toBe(true);
    const refusal = refusalOf(`${REPEATED}${REPEATED}`);
    expect(refusal.reason).toBe("not_whole_run");
    expect(refusal.windowCount).toBe(18);
    // Counting the windows instead would say 2, which turns this refusal into `ambiguous`
    // and makes §6.4's sentence — `refusalText.ts` renders this integer verbatim — tell
    // the user that two different strings here could each be a VIN. There is one. A count
    // the bytes do not hold is the N2 failure the whole reason channel exists to avoid.
    expect(refusal.validCount).toBe(1);
  });

  it("`no_valid_window` — several windows and no check digit settles them", () => {
    // Step 4(b) wants exactly one window; here there are two and neither validates, so
    // there is nothing to return and nothing that could have been ranked.
    const refusal = refusalOf(`${BAD_CHECK}1`);
    expect(refusal.reason).toBe("no_valid_window");
    expect(refusal.windowCount).toBe(2);
    expect(refusal.validCount).toBe(0);

    // Two runs, each 17 characters and each a whole run, neither validating: still two
    // windows, so still refused — the branch is about the count, not about the geometry.
    const twoRuns = refusalOf(`${BAD_CHECK}-${BAD_CHECK}`);
    expect(twoRuns.reason).toBe("no_valid_window");
    expect(twoRuns.windowCount).toBe(2);
  });

  it("holds the evidence at the size a pasted payload can reach", () => {
    // The §13.2 oversize payload: 100,000 characters fused to the VIN by a space that
    // step 1 strips. One window validates out of 100,001 and it is not the run, so the
    // reason is R4-A's — and the run the app quotes really is 100,017 characters long.
    const refusal = refusalOf(`${"A".repeat(100_000)} ${VIN}`);
    expect(refusal.reason).toBe("not_whole_run");
    expect(refusal.windowCount).toBe(100_001);
    expect(refusal.validCount).toBe(1);
    expect(refusal.longestRun.length).toBe(100_017);
    // A run of 300,000 identical characters validates nowhere: the other branch, at size.
    expect(refusalOf("A".repeat(300_000)).reason).toBe("no_valid_window");
  });
});

/**
 * The proof that matters: §4.2's outcomes are authoritative (N6), so the reason channel
 * has to be invisible to every caller that only asked for the VIN.
 */
describe("[FR-1] the reason channel decides nothing", () => {
  /** §4.11 and Appendix B, plus this directory's adversary payloads, accepts and refusals alike. */
  const CORPUS: string[] = [
    "",
    VIN,
    VIN.toLowerCase(),
    `*${VIN}*`,
    `I${VIN}`,
    `  *i${VIN.toLowerCase()}*  `,
    "1HG CM826 3 3 A 004352",
    `{"vin":"${VIN}","unit":"UNIT-42"}`,
    `{"pin":"${PIN}","vin":"${VIN}"}`,
    "11111111111111111",
    BAD_CHECK,
    "1HGCM826X3A004350",
    "WVWZZZ1JZ1W123456",
    "1FUJGLDR49SAV1234",
    "1HTMMAAL67H412345",
    "4V4NC9TJ98N412345",
    "1FUJA6CK14LM12345",
    "1HGCM82633A00435",
    `${VIN}1`,
    "1HGCM8263IA004352",
    "1HGCM82633A0043531HGCM82633A004352",
    `B${VIN}`,
    `B ${VIN}`,
    `2\t${VIN}`,
    `UNIT B\n${VIN}`,
    `A${VIN}A`,
    `${BAD_CHECK}1`,
    "QQQ-000/ 12345 *** IOI",
    PIN,
    `PIN ${PIN}`,
    `PIN: ${PIN}`,
    `SN ${PIN}`,
    `UNIT 42 ${PIN}`,
    `${PIN} 01`,
    `PIN ${PIN} USA`,
    `ſ${VIN}`,
    `ﬅ${VIN}`,
    `ß${VIN}`,
    `ﬁ${VIN}`,
    "1HGCM82633A00435́2",
    "1HGCM826\u000033A004352",
    "１ＨＧCM82633A004352",
    "ıHGCM82633A004352",
    "1HGCM82633A00435\u212A",
    `  ‏*${VIN}*‎  `,
    "R25-1251-200622120",
    "414556",
    "W06007C",
    "12310LA",
    "11/04/2013",
    "A".repeat(3_000),
    `${"A".repeat(100_000)} ${VIN}`,
    `${"A".repeat(100_000)}-${VIN}`,
  ];

  it("agrees with `extractVin` on every fixture and adversary payload in this directory", () => {
    // Both channels, compared object for object rather than "both truthy": a projection
    // that returned the right decision with the wrong `checkDigitValid` would pass a
    // null check and would still be a §4.2 change.
    let accepted = 0;
    for (const raw of CORPUS) {
      const outcome = extractVinExplained(raw);
      expect(extractVin(raw), raw).toEqual(outcome.ok ? outcome.result : null);
      if (outcome.ok) accepted += 1;
    }
    // The corpus is not all refusals, which is what makes the agreement worth measuring.
    expect(CORPUS.length).toBe(53);
    expect(accepted).toBe(24);
  });

  it("agrees over a seeded corpus of straddles, prefixes and suffixes", () => {
    // The generator the straddle and adversary suites draw their measurements with
    // (`rng.testutil.ts`, fixed seed per §13.2), so this walks the same populations R4-A
    // and Z6 were ruled on rather than a fresh idea of what is hostile.
    const stream = countingRandom(20260907);
    const rng = stream.next;
    const pick = (s: string) => s[Math.floor(rng() * s.length)]!;
    const pickFrom = <T>(from: readonly T[]) => from[Math.floor(rng() * from.length)]!;
    const PREFIXES = ["", "I", "B", "PIN ", "UNIT B ", "P/N ", "ID: ", "A", "-"];
    const SUFFIXES = ["", "1", " 01", " USA", "-REV C", "A", "\n"];
    let refused = 0;
    let accepted = 0;
    const payloads = new Set<string>();
    for (let i = 0; i < 4000; i += 1) {
      let body = "";
      for (let j = 0; j < 17; j += 1) body += pick(ALPHABET);
      // Half the draws carry a real check digit, so both populations are represented:
      // an identifier that can be refuted by §4.3 and one that cannot.
      const id = rng() < 0.5 ? body.slice(0, 8) + expectedCheckDigit(body) + body.slice(9) : body;
      const raw = pickFrom(PREFIXES) + id + pickFrom(SUFFIXES);
      payloads.add(raw);
      const outcome = extractVinExplained(raw);
      expect(extractVin(raw), raw).toEqual(outcome.ok ? outcome.result : null);
      if (outcome.ok) accepted += 1;
      else refused += 1;
    }
    // The sample the agreement was taken over, asserted before it is relied on (R4-B):
    // 4,000 distinct payloads off 79,998 distinct draws, measured.
    expect(payloads.size).toBeGreaterThanOrEqual(3900);
    expect(stream.distinct()).toBeGreaterThanOrEqual(70_000);
    // Measured at this seed: 748 accepted, 3,252 refused (1,675 `not_whole_run`, 1,468
    // `no_valid_window`, 109 `ambiguous`). Both floors are here because a corpus that
    // only ever refused would prove nothing about the accepting path.
    expect(accepted).toBeGreaterThan(500);
    expect(refused).toBeGreaterThan(500);
  });

  it("carries no refusal on an accepted read, and no result on a refused one", () => {
    // The union is discriminated on `ok`, so a caller cannot read a reason off a read
    // that succeeded — there is no "why" to show when there is a VIN to show.
    const ok = extractVinExplained(VIN);
    expect(ok).toEqual({ ok: true, result: { vin: VIN, raw: VIN, checkDigitValid: true } });
    expect(extractVinExplained("R25-1251-200622120").ok).toBe(false);
  });
});
