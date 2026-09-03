import { describe, expect, it } from "vitest";
import {
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
