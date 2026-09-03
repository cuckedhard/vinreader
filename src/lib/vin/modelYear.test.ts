import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { MODEL_YEAR_CODES, isValidYearCode, modelYearFromVin } from "./modelYear";

/** §4.4 pinned as a literal, independent of the implementation's own table. */
const EXPECTED_TABLE: Record<string, [number, number]> = {
  A: [1980, 2010],
  B: [1981, 2011],
  C: [1982, 2012],
  D: [1983, 2013],
  E: [1984, 2014],
  F: [1985, 2015],
  G: [1986, 2016],
  H: [1987, 2017],
  J: [1988, 2018],
  K: [1989, 2019],
  L: [1990, 2020],
  M: [1991, 2021],
  N: [1992, 2022],
  P: [1993, 2023],
  R: [1994, 2024],
  S: [1995, 2025],
  T: [1996, 2026],
  V: [1997, 2027],
  W: [1998, 2028],
  X: [1999, 2029],
  Y: [2000, 2030],
  "1": [2001, 2031],
  "2": [2002, 2032],
  "3": [2003, 2033],
  "4": [2004, 2034],
  "5": [2005, 2035],
  "6": [2006, 2036],
  "7": [2007, 2037],
  "8": [2008, 2038],
  "9": [2009, 2039],
};

const VALID_CODES = Object.keys(EXPECTED_TABLE);
const INVALID_POSITION_10 = ["I", "O", "Q", "U", "Z", "0"];
/** §4.1 alphabet, the only characters position 7 can hold in a grammar-valid VIN. */
const VIN_ALPHABET = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789".split("");

/** A grammar-valid VIN with the given characters at positions 7 and 10. */
function vinWith(position7: string, position10: string): string {
  return `1HGCM8${position7}63${position10}A004352`;
}

describe("MODEL_YEAR_CODES", () => {
  it("maps all 30 codes to exactly the §4.4 pairs and holds nothing else", () => {
    expect(MODEL_YEAR_CODES).toEqual(EXPECTED_TABLE);
    expect(Object.keys(MODEL_YEAR_CODES)).toHaveLength(30);
  });
});

describe("isValidYearCode", () => {
  it.each(VALID_CODES)("accepts %s", (code) => {
    expect(isValidYearCode(code)).toBe(true);
  });

  it.each(INVALID_POSITION_10)("rejects %s", (code) => {
    expect(isValidYearCode(code)).toBe(false);
  });

  it("rejects inherited property names, lowercase and non-single characters", () => {
    expect(isValidYearCode("toString")).toBe(false);
    expect(isValidYearCode("constructor")).toBe(false);
    expect(isValidYearCode("a")).toBe(false);
    expect(isValidYearCode("AB")).toBe(false);
    expect(isValidYearCode("")).toBe(false);
  });
});

describe("modelYearFromVin", () => {
  it.each(INVALID_POSITION_10)("returns no candidates for the invalid code %s", (code) => {
    expect(modelYearFromVin(vinWith("A", code), 2026)).toEqual({
      candidates: [],
      resolved: null,
    });
  });

  it("returns no candidates when the VIN is too short to have a position 10", () => {
    expect(modelYearFromVin("", 2026)).toEqual({ candidates: [], resolved: null });
    expect(modelYearFromVin("1HGCM8263", 2026)).toEqual({ candidates: [], resolved: null });
  });

  it("resolves the §4.11 fixture: digit in position 7, the cap drops 2033", () => {
    expect(modelYearFromVin("1HGCM82633A004352", 2026)).toEqual({
      candidates: [2003],
      resolved: 2003,
    });
  });

  it("takes the late candidate when position 7 is a letter and it survives the cap", () => {
    expect(modelYearFromVin(vinWith("A", "K"), 2026)).toEqual({
      candidates: [1989, 2019],
      resolved: 2019,
    });
    expect(modelYearFromVin(vinWith("A", "L"), 2026)).toEqual({
      candidates: [1990, 2020],
      resolved: 2020,
    });
  });

  it("stays ambiguous when position 7 is a digit and both candidates survive", () => {
    expect(modelYearFromVin(vinWith("2", "T"), 2026)).toEqual({
      candidates: [1996, 2026],
      resolved: null,
    });
  });

  it.each([
    ["1FUJGLDR49SAV1234", 2009],
    ["1HTMMAAL67H412345", 2007],
    ["4V4NC9TJ98N412345", 2008],
    ["1FUJA6CK14LM12345", 2004],
  ])("resolves the heavy truck %s to %i, never the 2010–2039 candidate", (vin, year) => {
    expect(modelYearFromVin(vin, 2026)).toEqual({ candidates: [year], resolved: year });
  });

  it("keeps a candidate equal to currentYear + 1 and drops currentYear + 2", () => {
    // Code T is 1996/2026, so 2026 is the boundary year on both sides.
    expect(modelYearFromVin(vinWith("2", "T"), 2025)).toEqual({
      candidates: [1996, 2026],
      resolved: null,
    });
    expect(modelYearFromVin(vinWith("2", "T"), 2024)).toEqual({
      candidates: [1996],
      resolved: 1996,
    });
  });

  it("resolves the early candidate when the cap drops the late one, whatever position 7 holds", () => {
    expect(modelYearFromVin(vinWith("A", "T"), 2024)).toEqual({
      candidates: [1996],
      resolved: 1996,
    });
    expect(modelYearFromVin(vinWith("7", "T"), 2024)).toEqual({
      candidates: [1996],
      resolved: 1996,
    });
  });

  it("returns no candidates when the cap predates the whole cycle", () => {
    expect(modelYearFromVin(vinWith("A", "A"), 1900)).toEqual({ candidates: [], resolved: null });
    expect(modelYearFromVin(vinWith("2", "9"), 1900)).toEqual({ candidates: [], resolved: null });
  });

  it("holds the §4.4 invariants for every code, position-7 character and current year", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...VALID_CODES),
        fc.constantFrom(...VIN_ALPHABET),
        fc.integer({ min: 2008, max: 2200 }),
        (code, position7, currentYear) => {
          const { candidates, resolved } = modelYearFromVin(vinWith(position7, code), currentYear);
          const pair = EXPECTED_TABLE[code];

          expect(candidates.length).toBeGreaterThan(0);
          expect(candidates).toEqual(pair.filter((year) => year <= currentYear + 1));
          for (const year of candidates) expect(year).toBeLessThanOrEqual(currentYear + 1);
          if (resolved !== null) expect(candidates).toContain(resolved);
        },
      ),
    );
  });
});
