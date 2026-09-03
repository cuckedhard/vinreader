import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { buildStructural } from "./structural";
import { manufacturerFromWmi } from "./wmi";

/** §4.1 alphabet. */
const ALPHABET = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789".split("");

const vinArb = fc
  .array(fc.constantFrom(...ALPHABET), { minLength: 17, maxLength: 17 })
  .map((chars) => chars.join(""));

describe("buildStructural", () => {
  it("splits the §4.11 fixture 1HGCM82633A004352", () => {
    expect(buildStructural("1HGCM82633A004352", 2026)).toEqual({
      wmi: "1HG",
      vds: "CM826",
      checkDigit: "3",
      checkDigitValid: true,
      yearCode: "3",
      modelYear: { candidates: [2003], resolved: 2003 },
      plantCode: "A",
      serial: "004352",
      region: "North America",
      country: "United States",
      // Whatever the committed seed holds for 1HG — `null` before `seed:wmi` runs (D09).
      manufacturerFromWmi: manufacturerFromWmi("1HG"),
    });
  });

  it("splits WVWZZZ1JZ1W123456, whose position 9 is a letter and so cannot match (§4.3)", () => {
    expect(buildStructural("WVWZZZ1JZ1W123456", 2026)).toEqual({
      wmi: "WVW",
      vds: "ZZZ1J",
      checkDigit: "Z",
      checkDigitValid: false,
      yearCode: "1",
      modelYear: { candidates: [2001], resolved: 2001 },
      plantCode: "W",
      serial: "123456",
      region: "Europe",
      country: "Germany",
      manufacturerFromWmi: manufacturerFromWmi("WVW"),
    });
  });

  it("leaves region and country null for a position-1 0 (D06)", () => {
    const structural = buildStructural("0HGCM82633A004352", 2026);
    expect(structural.region).toBeNull();
    expect(structural.country).toBeNull();
    expect(structural.wmi).toBe("0HG");
  });

  it("takes the current year as an argument, never a clock (P3)", () => {
    expect(buildStructural("1HGCM82633A004352", 2005).modelYear).toEqual({
      candidates: [2003],
      resolved: 2003,
    });
    expect(buildStructural("1HGCM82633A004352", 2035).modelYear).toEqual({
      candidates: [2003, 2033],
      resolved: null,
    });
  });

  it("reassembles the VIN from its parts for any grammar-valid input", () => {
    fc.assert(
      fc.property(vinArb, fc.integer({ min: 1980, max: 2100 }), (vin, currentYear) => {
        const s = buildStructural(vin, currentYear);
        expect(s.wmi + s.vds + s.checkDigit + s.yearCode + s.plantCode + s.serial).toBe(vin);
        expect([s.wmi, s.vds, s.serial].map((part) => part.length)).toEqual([3, 5, 6]);
        expect(s.region === null).toBe(vin.charAt(0) === "0");
        expect(s.country === null || s.region !== null).toBe(true);
      }),
    );
  });
});
