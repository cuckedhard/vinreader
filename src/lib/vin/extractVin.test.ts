import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { expectedCheckDigit } from "./checkDigit";
import { extractVin } from "./extractVin";
import { VIN_LENGTH } from "./grammar";

const VALID = "1HGCM82633A004352";
const BAD_CHECK = "1HGCM82633A004353";
/** A Volkswagen VIN with a letter at position 9: no ISO 3779 check digit (D17). */
const NO_CHECK_DIGIT = "WVWZZZ1JZ1W123456";

describe("extractVin", () => {
  it("returns a bare valid VIN unchanged", () => {
    expect(extractVin(VALID)).toEqual({ vin: VALID, raw: VALID, checkDigitValid: true });
  });

  it("drops the ANSI MH10.8.2 `I` data identifier printed on door labels", () => {
    // `I` is outside the §4.1 alphabet, so it splits off as a separator.
    expect(extractVin(`I${VALID}`)?.vin).toBe(VALID);
  });

  it("picks the check-valid window out of an 18-character run", () => {
    const raw = `${VALID}1`;
    expect(extractVin(raw)).toEqual({ vin: VALID, raw, checkDigitValid: true });
  });

  it("returns null for 16 characters", () => {
    expect(extractVin(VALID.slice(0, 16))).toBeNull();
  });

  it("returns null when a disallowed letter breaks the run below 17", () => {
    // 9 + 7 characters either side of the `I`.
    expect(extractVin("1HGCM8263IA004352")).toBeNull();
  });

  it("rejoins the grouped display form a user pastes", () => {
    const raw = "1HG CM826 3 3 A 004352";
    expect(extractVin(raw)).toEqual({ vin: VALID, raw, checkDigitValid: true });
  });

  it("strips Code 39 start and stop characters", () => {
    expect(extractVin(`*${VALID}*`)?.vin).toBe(VALID);
  });

  it("uppercases lowercase input", () => {
    expect(extractVin(VALID.toLowerCase())?.vin).toBe(VALID);
  });

  it("finds a VIN inside a JSON payload", () => {
    expect(extractVin(`{"vin":"${VALID}","unit":"UNIT-42"}`)?.vin).toBe(VALID);
  });

  it("refuses a run holding more than one plausible VIN (Z1)", () => {
    // Several distinct windows pass the check digit here, so §4.2 4(a) yields NO_VIN
    // rather than ranking them and showing the winner as fact (N2).
    expect(extractVin("1HGCM82633A0043531HGCM82633A004352")).toBeNull();
  });

  it("falls back to the only interior window when nothing is run-aligned", () => {
    // A 19-character run whose only check-valid window sits at offset 1.
    const raw = `A${VALID}A`;
    expect(extractVin(raw)).toEqual({ vin: VALID, raw, checkDigitValid: true });
  });

  it("returns a lone grammar-valid window with a bad check digit", () => {
    expect(extractVin(BAD_CHECK)).toEqual({
      vin: BAD_CHECK,
      raw: BAD_CHECK,
      checkDigitValid: false,
    });
  });

  it("reads an identifier that carries no check digit at all", () => {
    expect(extractVin(NO_CHECK_DIGIT)).toEqual({
      vin: NO_CHECK_DIGIT,
      raw: NO_CHECK_DIGIT,
      checkDigitValid: false,
    });
  });

  it("returns null when several windows exist and none is check-valid", () => {
    expect(extractVin(`${BAD_CHECK}1`)).toBeNull();
  });

  it("returns null for garbage with no run of 17", () => {
    expect(extractVin("QQQ-000/ 12345 *** IOI")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(extractVin("")).toBeNull();
  });

  it("echoes the original unmodified input as `raw`", () => {
    const raw = `  *i${VALID.toLowerCase()}*  `;
    expect(extractVin(raw)?.raw).toBe(raw);
  });
});

const VIN_ALPHABET = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789".split("");
/** Non-alphabet and uppercase-stable, so these can only ever separate runs. */
const SEPARATORS = "IOQ-_.,:;/|()[]{}<>?!@#$%&+=~^".split("");

const checkValidVin = fc
  .array(fc.constantFrom(...VIN_ALPHABET), { minLength: VIN_LENGTH, maxLength: VIN_LENGTH })
  .map((chars) => {
    const body = chars.join("");
    // Position 9 weighs 0 (§4.3), so overwriting it cannot change the expected digit.
    return body.slice(0, 8) + expectedCheckDigit(body) + body.slice(9);
  });

const separatorRun = fc
  .array(fc.constantFrom(...SEPARATORS), { maxLength: 8 })
  .map((c) => c.join(""));

describe("extractVin property", () => {
  it("finds exactly the VIN when a check-valid VIN is surrounded by separators", () => {
    fc.assert(
      fc.property(separatorRun, checkValidVin, separatorRun, (before, vin, after) => {
        const raw = before + vin + after;
        expect(extractVin(raw)).toEqual({ vin, raw, checkDigitValid: true });
      }),
    );
  });
});
