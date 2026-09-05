import { describe, expect, it } from "vitest";
import {
  asciiUpper,
  groupVin,
  isAllowedVinChar,
  isVinGrammarValid,
  splitRuns,
  VIN_LENGTH,
  VIN_RE,
} from "./grammar";

/** §4.1 alphabet, written out so a regex edit cannot silently redefine it. */
const ALPHABET = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";

const FIXTURES = [
  "1HGCM82633A004352",
  "11111111111111111",
  "1HGCM82633A004353",
  "1HGCM826X3A004350",
  "WVWZZZ1JZ1W123456",
  "1FUJGLDR49SAV1234",
  "1HTMMAAL67H412345",
  "4V4NC9TJ98N412345",
  "1FUJA6CK14LM12345",
];

describe("§4.1 constants", () => {
  it("pins the length and the regex", () => {
    expect(VIN_LENGTH).toBe(17);
    expect(VIN_RE.source).toBe("^[A-HJ-NPR-Z0-9]{17}$");
    expect(VIN_RE.flags).toBe("");
  });

  it("covers 33 characters", () => {
    expect(ALPHABET).toHaveLength(33);
  });
});

describe("isVinGrammarValid", () => {
  it.each(FIXTURES)("accepts the §4.11 fixture %s", (vin) => {
    expect(isVinGrammarValid(vin)).toBe(true);
  });

  it("rejects a 17-char string containing I, O or Q", () => {
    expect(isVinGrammarValid("1HGCM8263IA004352")).toBe(false);
    expect(isVinGrammarValid("1HGCM8263OA004352")).toBe(false);
    expect(isVinGrammarValid("1HGCM8263QA004352")).toBe(false);
  });

  it("rejects 16 and 18 characters", () => {
    expect(isVinGrammarValid("1HGCM82633A00435")).toBe(false);
    expect(isVinGrammarValid("1HGCM82633A0043521")).toBe(false);
    expect(isVinGrammarValid("")).toBe(false);
  });

  it("rejects lowercase", () => {
    expect(isVinGrammarValid("1hgcm82633a004352")).toBe(false);
    expect(isVinGrammarValid("1HGCM82633a004352")).toBe(false);
  });

  it("rejects punctuation, spaces and the grouped display form", () => {
    expect(isVinGrammarValid("1HGCM82633A00435-")).toBe(false);
    expect(isVinGrammarValid("1HG CM826 3 3 A 004352")).toBe(false);
    expect(isVinGrammarValid("*1HGCM82633A004352*")).toBe(false);
  });

  it("is not anchored around newlines", () => {
    expect(isVinGrammarValid("1HGCM82633A004352\n")).toBe(false);
    expect(isVinGrammarValid("\n1HGCM82633A004352")).toBe(false);
  });
});

describe("isAllowedVinChar", () => {
  it.each(ALPHABET.split(""))("accepts %s", (c) => {
    expect(isAllowedVinChar(c)).toBe(true);
  });

  it.each(["I", "O", "Q"])("rejects the excluded letter %s", (c) => {
    expect(isAllowedVinChar(c)).toBe(false);
  });

  it("rejects lowercase, separators and multi-character strings", () => {
    expect(isAllowedVinChar("a")).toBe(false);
    expect(isAllowedVinChar("-")).toBe(false);
    expect(isAllowedVinChar("*")).toBe(false);
    expect(isAllowedVinChar(" ")).toBe(false);
    expect(isAllowedVinChar("")).toBe(false);
    expect(isAllowedVinChar("AB")).toBe(false);
  });
});

describe("splitRuns (§4.2 step 2)", () => {
  it("returns a single run for a plain VIN", () => {
    expect(splitRuns("1HGCM82633A004352")).toEqual(["1HGCM82633A004352"]);
  });

  it("splits the ANSI MH10.8.2 data identifier off the front", () => {
    expect(splitRuns("I1HGCM82633A004352")).toEqual(["1HGCM82633A004352"]);
  });

  it("treats every non-alphabet character as a separator", () => {
    expect(splitRuns("ABC-DEF")).toEqual(["ABC", "DEF"]);
    expect(splitRuns('{"vin":"1HGCM82633A004352"}')).toEqual(["1HGCM82633A004352"]);
  });

  it("keeps runs in order and drops empty ones", () => {
    expect(splitRuns("--1HGCM82633A004352..ZZZ--")).toEqual(["1HGCM82633A004352", "ZZZ"]);
    expect(splitRuns("")).toEqual([]);
    expect(splitRuns("----")).toEqual([]);
    expect(splitRuns("iq")).toEqual([]);
  });

  it("returns maximal runs, not fragments", () => {
    expect(splitRuns("1HGCM82633A0043531HGCM82633A004352")).toEqual([
      "1HGCM82633A0043531HGCM82633A004352",
    ]);
  });
});

describe("groupVin (§4.1 display grouping)", () => {
  it("groups WMI VDS C Y P SERIAL", () => {
    expect(groupVin("1HGCM82633A004352")).toBe("1HG CM826 3 3 A 004352");
    expect(groupVin("WVWZZZ1JZ1W123456")).toBe("WVW ZZZ1J Z 1 W 123456");
  });

  it("returns anything that is not 17 characters unchanged", () => {
    expect(groupVin("1HGCM82633A00435")).toBe("1HGCM82633A00435");
    expect(groupVin("")).toBe("");
  });
});

/**
 * [G1] §4.2 step 1, ruled by Zach 2026-09-05. `String.prototype.toUpperCase` is a
 * length-changing map that carries code points from outside §4.1 **into** §4.1, and step 1
 * runs before step 2 splits into runs — so it can invent alphabet characters the label
 * never carried and hand step 3 a 17-character window to validate. These tests are stated
 * over the whole of Unicode rather than over the handful of code points the finding names.
 */
describe("asciiUpper (§4.2 step 1)", () => {
  it("maps a–z to A–Z and nothing else", () => {
    expect(asciiUpper("1hgcm82633a004352")).toBe("1HGCM82633A004352");
    expect(asciiUpper(ALPHABET)).toBe(ALPHABET);
    expect(asciiUpper("")).toBe("");
    // The characters §4.2 step 2 will treat as separators are handed on untouched, so the
    // run geometry step 2 sees is the geometry the scanned bytes actually had.
    expect(asciiUpper("1HGCM82653A0ß352")).toBe("1HGCM82653A0ß352");
    expect(asciiUpper("i-o-q *ß* ﬁ")).toBe("I-O-Q *ß* ﬁ");
  });

  /**
   * One sweep of every code point in Unicode, surrogate halves excluded because they are
   * not characters on their own. Violations are collected rather than asserted per code
   * point: 1.1 M assertions cost half a minute, one assertion over the collected list costs
   * a second and names every offender it finds.
   *
   * "Enters the alphabet" is asked through `splitRuns` — the same function §4.2 step 2 uses
   * — so it is asked exactly the way step 2 asks it.
   */
  it("lets no code point outside the alphabet enter it, and changes no length", () => {
    function entersAlphabet(mapped: string): boolean {
      return splitRuns(mapped).join("") !== "";
    }

    const grew: string[] = [];
    const invented: string[] = [];
    // The same sweep against `String.prototype.toUpperCase`, so the two lists above cannot
    // be empty for want of anything to find.
    const unicodeGrew: string[] = [];
    const unicodeInvented: string[] = [];

    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      // `a`–`z` are the only code points step 1 may turn into alphabet characters, and the
      // alphabet's own characters are already there.
      const mayEnter = isAllowedVinChar(c) || (c >= "a" && c <= "z");

      const ascii = asciiUpper(c);
      if (ascii.length !== c.length) grew.push(c);
      if (!mayEnter && entersAlphabet(ascii)) invented.push(c);

      const unicode = c.toUpperCase();
      if (unicode.length !== c.length) unicodeGrew.push(c);
      if (!mayEnter && entersAlphabet(unicode)) unicodeInvented.push(c);
    }

    expect(grew).toEqual([]);
    expect(invented).toEqual([]);

    // 102 code points change length under `String.prototype.toUpperCase`; 16 outside §4.1
    // land inside it — six of them as two or three characters at once (ﬀ→FF, ﬁ→FI, ﬂ→FL,
    // ﬃ→FFI, ﬄ→FFL, ß→SS), the rest as one letter plus a separator (ŉ→ʼN, ǰ→J+◌̌).
    // Measured here rather than quoted: §4.2 step 1's prose says fifteen.
    expect(unicodeGrew).toHaveLength(102);
    expect(unicodeInvented.join("")).toBe("ßŉſǰẖẗẘẙẚﬀﬁﬂﬃﬄﬅﬆ");
    // And every one of them is left exactly as it came in by step 1 as it now stands.
    for (const c of [...unicodeGrew, ...unicodeInvented]) {
      expect(asciiUpper(c), c).toBe(c);
    }
  });
});
