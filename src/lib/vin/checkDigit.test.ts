import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CHECK_DIGIT_WEIGHTS,
  checkDigitApplies,
  checkDigitSum,
  expectedCheckDigit,
  isCheckDigitValid,
  transliterate,
  TRANSLITERATION,
} from "./checkDigit";

/** §4.3, restated here as a literal so the table and the test cannot drift together. */
const EXPECTED_VALUES: Record<string, number> = {
  A: 1,
  B: 2,
  C: 3,
  D: 4,
  E: 5,
  F: 6,
  G: 7,
  H: 8,
  J: 1,
  K: 2,
  L: 3,
  M: 4,
  N: 5,
  P: 7,
  R: 9,
  S: 2,
  T: 3,
  U: 4,
  V: 5,
  W: 6,
  X: 7,
  Y: 8,
  Z: 9,
  "0": 0,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
};

const ALPHABET = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789".split("");

/** §4.11 fixtures with the arithmetic the spec states. */
const FIXTURES: { vin: string; sum: number; expected: string; valid: boolean }[] = [
  { vin: "1HGCM82633A004352", sum: 311, expected: "3", valid: true },
  { vin: "11111111111111111", sum: 89, expected: "1", valid: true },
  { vin: "1HGCM82633A004353", sum: 313, expected: "5", valid: false },
  { vin: "1HGCM826X3A004350", sum: 307, expected: "X", valid: true },
];

/** §4.11 heavy trucks, all check-digit valid. */
const TRUCKS: { vin: string; sum: number }[] = [
  { vin: "1FUJGLDR49SAV1234", sum: 378 },
  { vin: "1HTMMAAL67H412345", sum: 358 },
  { vin: "4V4NC9TJ98N412345", sum: 361 },
  { vin: "1FUJA6CK14LM12345", sum: 265 },
];

describe("§4.3 transliteration", () => {
  it.each(ALPHABET)("maps %s to the stated value", (c) => {
    expect(transliterate(c)).toBe(EXPECTED_VALUES[c]);
    expect(TRANSLITERATION[c]).toBe(EXPECTED_VALUES[c]);
  });

  it("covers exactly the 33 characters of the §4.1 alphabet", () => {
    expect(Object.keys(TRANSLITERATION).sort()).toEqual([...ALPHABET].sort());
  });

  it.each(["I", "O", "Q"])("throws on the excluded letter %s", (c) => {
    expect(() => transliterate(c)).toThrow(RangeError);
  });

  it("throws on lowercase and on separators", () => {
    expect(() => transliterate("a")).toThrow(RangeError);
    expect(() => transliterate("-")).toThrow(RangeError);
    expect(() => transliterate("")).toThrow(RangeError);
  });
});

describe("§4.3 weights", () => {
  it("is exactly the spec's 17 numbers, in order", () => {
    expect(CHECK_DIGIT_WEIGHTS).toEqual([8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2]);
  });

  it("weighs position 9 at zero so the check digit never feeds its own sum", () => {
    expect(CHECK_DIGIT_WEIGHTS[8]).toBe(0);
    expect(checkDigitSum("1HGCM82633A004352")).toBe(checkDigitSum("1HGCM826X3A004352"));
  });
});

describe("§4.11 fixtures", () => {
  it.each(FIXTURES)("$vin sums to $sum and expects $expected", ({ vin, sum, expected, valid }) => {
    expect(checkDigitSum(vin)).toBe(sum);
    expect(sum % 11).toBe(expected === "X" ? 10 : Number(expected));
    expect(expectedCheckDigit(vin)).toBe(expected);
    expect(isCheckDigitValid(vin)).toBe(valid);
  });

  it("reports the mismatch on 1HGCM82633A004353 as expected 5, actual 3", () => {
    expect(expectedCheckDigit("1HGCM82633A004353")).toBe("5");
    expect("1HGCM82633A004353".charAt(8)).toBe("3");
  });

  it.each(TRUCKS)("heavy truck $vin sums to $sum and is valid", ({ vin, sum }) => {
    expect(checkDigitSum(vin)).toBe(sum);
    expect(isCheckDigitValid(vin)).toBe(true);
  });
});

describe("checkDigitApplies (§4.3, D17)", () => {
  it.each([...FIXTURES.map((f) => f.vin), ...TRUCKS.map((t) => t.vin)])("is true for %s", (vin) => {
    expect(checkDigitApplies(vin)).toBe(true);
  });

  it("is false when position 9 is a letter other than X", () => {
    expect(checkDigitApplies("WVWZZZ1JZ1W123456")).toBe(false);
    expect(isCheckDigitValid("WVWZZZ1JZ1W123456")).toBe(false);
  });

  it("is false when there is no position 9 at all", () => {
    expect(checkDigitApplies("1HGCM826")).toBe(false);
    expect(checkDigitApplies("")).toBe(false);
  });
});

describe("input that is not a §4.1 VIN", () => {
  it("throws from checkDigitSum on the wrong length", () => {
    expect(() => checkDigitSum("1HGCM82633A00435")).toThrow(RangeError);
    expect(() => checkDigitSum("1HGCM82633A0043521")).toThrow(RangeError);
    expect(() => expectedCheckDigit("")).toThrow(RangeError);
  });

  it("throws from checkDigitSum on a disallowed character", () => {
    expect(() => checkDigitSum("1HGCM8263IA004352")).toThrow(RangeError);
  });

  it("returns false from isCheckDigitValid rather than throwing", () => {
    expect(isCheckDigitValid("1hgcm82633a004352")).toBe(false);
    expect(isCheckDigitValid("1HGCM8263IA004352")).toBe(false);
    expect(isCheckDigitValid("1HGCM82633A00435")).toBe(false);
    expect(isCheckDigitValid("")).toBe(false);
  });
});

describe("property: the expected check digit always validates", () => {
  it("returns 0–9 or X and makes any grammar-valid VIN pass", () => {
    const vinArb = fc
      .array(fc.constantFrom(...ALPHABET), { minLength: 17, maxLength: 17 })
      .map((chars) => chars.join(""));

    fc.assert(
      fc.property(vinArb, (vin) => {
        const expected = expectedCheckDigit(vin);
        expect("0123456789X").toContain(expected);
        expect(isCheckDigitValid(vin.slice(0, 8) + expected + vin.slice(9))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});
