/**
 * §13.2 adversary — hostile scan payloads against §4.2 step 1.
 *
 * [G1] `String.prototype.toUpperCase` is a *length-changing* map, and §4.2 step 1 runs it
 * before step 2 splits the string into runs. Fifteen code points outside the §4.1 alphabet
 * uppercase into it — six of them into TWO OR THREE §4.1 characters:
 *
 *     U+00DF ß -> SS    U+FB00 ﬀ -> FF    U+FB02 ﬂ -> FL
 *     U+FB04 ﬄ -> FFL   U+FB05 ﬅ -> ST    U+FB06 ﬆ -> ST
 *     U+017F ſ -> S     U+1E96 ẖ -> H+◌̱   U+FB01 ﬁ -> F+I (and eight more partials)
 *
 * So a character that step 2 would have treated as a SEPARATOR is turned, before step 2
 * ever sees it, into one or more characters of the alphabet — which lengthens the run it
 * sits in and can *join two runs into one*. R4-A's whole-run rule is the only thing
 * standing between §4.2 and a fabricated VIN, and it is stated over run geometry: a
 * 16-character raw whose runs are 12 and 3 characters long holds no VIN at any offset, but
 * after step 1 it is one 17-character run, that run is a window of its own, and if the
 * window passes §4.3 it comes back marked `checkDigitValid: true` — a fact.
 *
 * These are not the prefix cases already pinned in `extractVin.adversary.test.ts`
 * (`ſ${VIN}`, `ﬅ${VIN}`): those grow an 18/19-character run in which the VIN is not the
 * whole run, so R4-A refuses them and they pass. What is new here is the *interior*
 * expansion, which manufactures a whole run and walks straight through R4-A.
 *
 * Reachable, not theoretical. `@zxing/library`'s Data Matrix parser emits
 * `String.fromCharCode(value + 128)` for an Upper Shift byte, and its QR/Data Matrix byte
 * segments default to ISO-8859-1, so byte 0xDF on a label decodes as `ß`; `useScanner`
 * hands that text straight to `extractVin` (`readScanResult`). The paste path takes it too.
 *
 * Every case here is a literal string. No clock, no RNG, no timers.
 */
import { describe, expect, it } from "vitest";
import { extractVin } from "./extractVin";
import { isCheckDigitValid } from "./checkDigit";
import { splitRuns } from "./grammar";

/** ASCII-only uppercase — "uppercase" over §4.1's alphabet, with no length change. */
function asciiUpper(raw: string): string {
  return raw.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));
}

/** The longest §4.1 run the raw bytes actually contain, before any case map grows one. */
function longestRun(raw: string): number {
  return splitRuns(asciiUpper(raw)).reduce((max, run) => Math.max(max, run.length), 0);
}

describe("[G1] §4.2 step 1 uppercases non-§4.1 characters INTO the alphabet", () => {
  /**
   * `1HGCM82653A0SS352` is grammar-valid and check-digit valid (the `SS` sits at positions
   * 13–14). Replace those two characters with the single code point that uppercases to
   * them and the raw is 16 characters long: two runs, twelve and three, and no VIN in it.
   */
  const FABRICATED = "1HGCM82653A0SS352";

  it("does not manufacture a 17-character run out of U+00DF", () => {
    const raw = "1HGCM82653A0ß352";
    expect(raw).toHaveLength(16);
    // The bytes on the label hold no 17-character §4.1 run at any offset.
    expect(longestRun(raw)).toBeLessThan(17);
    expect(isCheckDigitValid(FABRICATED)).toBe(true);
    // TODAY: { vin: "1HGCM82653A0SS352", checkDigitValid: true } — a VIN that is on no
    // label, returned as fact, past R4-A because step 1 built it a run of its own.
    expect(extractVin(raw)).toBeNull();
  });

  it("does not manufacture one out of U+FB00, U+FB02, U+FB05 or U+017F either", () => {
    // Each raw is shorter than 17 characters or splits into runs shorter than 17.
    const cases: readonly (readonly [string, string])[] = [
      ["1HGCM82653A0ﬀ352", "1HGCM82653A0FF352"], // ﬀ -> FF
      ["1HGCM826X3A0ﬂ352", "1HGCM826X3A0FL352"], // ﬂ -> FL
      ["1HGCM82683A0ﬅ352", "1HGCM82683A0ST352"], // ﬅ -> ST
      ["1HGCM82653A0ſS352", "1HGCM82653A0SS352"], // ſ -> S
    ];
    for (const [raw, fabricated] of cases) {
      expect(longestRun(raw), raw).toBeLessThan(17);
      // Each of these passes §4.3, which is what makes it indistinguishable downstream:
      // the two-read rule agrees because a 2D code decodes identically every frame.
      expect(isCheckDigitValid(fabricated), fabricated).toBe(true);
      expect(extractVin(raw), raw).toBeNull();
    }
  });

  it("does not join two label fields across a separator that uppercases into the alphabet", () => {
    // Two printed fields — a 12-character unit tag and a 3-character bay number — with a
    // single high byte between them. Before step 1 they are two runs; after it they are
    // one, and the one is exactly 17 characters.
    const raw = "8CJ7BLMR2AWTß9K4";
    expect(splitRuns(asciiUpper(raw))).toEqual(["8CJ7BLMR2AWT", "9K4"]);
    expect(extractVin(raw)).toBeNull();
  });

  it("never returns a VIN holding a character the raw bytes did not carry", () => {
    // The general invariant, over every code point whose uppercase lands in §4.1. A VIN
    // §4.2 returns has to be readable off the label; a character step 1 invented is not.
    const injectors = [
      "ß",
      "ſ",
      "ﬀ",
      "ﬁ",
      "ﬂ",
      "ﬃ",
      "ﬄ",
      "ﬅ",
      "ﬆ",
      "ǰ",
      "ẖ",
      "ẗ",
      "ẘ",
      "ẙ",
      "ẚ",
    ];
    for (const injector of injectors) {
      for (const at of [0, 6, 12, 16]) {
        const raw = `1HGCM82653A0SS352`.slice(0, at) + injector + `1HGCM82653A0SS352`.slice(at);
        const read = extractVin(raw);
        if (read === null) continue;
        // Whatever comes back must be a substring of the raw as §4.1 reads it.
        expect(asciiUpper(raw), `${JSON.stringify(raw)} -> ${read.vin}`).toContain(read.vin);
      }
    }
  });
});
