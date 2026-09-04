import { describe, expect, it } from "vitest";
import { buildStructural } from "./structural";
import { extractVin } from "./extractVin";

/** §9-S0 definition of done: the §4.11 fixtures produce the stated structural results. */
describe("§4.11 fixtures end to end", () => {
  it("decodes the reference VIN", () => {
    const s = buildStructural("1HGCM82633A004352", 2026);
    expect(s).toMatchObject({
      wmi: "1HG",
      vds: "CM826",
      checkDigit: "3",
      checkDigitValid: true,
      yearCode: "3",
      plantCode: "A",
      serial: "004352",
      region: "North America",
      country: "United States",
    });
    expect(s.modelYear.resolved).toBe(2003);
  });

  it.each([
    ["1FUJGLDR49SAV1234", 2009],
    ["1HTMMAAL67H412345", 2007],
    ["4V4NC9TJ98N412345", 2008],
    ["1FUJA6CK14LM12345", 2004],
  ])("resolves heavy truck %s to %i, not a future year", (vin, year) => {
    const s = buildStructural(vin, 2026);
    expect(s.checkDigitValid).toBe(true);
    expect(s.modelYear.resolved).toBe(year);
  });

  it("keeps an ambiguous year ambiguous", () => {
    const s = buildStructural("1HGCM82613A004352".slice(0, 9) + "T" + "A004352", 2026);
    expect(s.modelYear.candidates).toEqual([1996, 2026]);
    expect(s.modelYear.resolved).toBeNull();
  });

  it("reads a vehicle that carries no check digit", () => {
    const r = extractVin("WVWZZZ1JZ1W123456");
    expect(r?.vin).toBe("WVWZZZ1JZ1W123456");
    expect(r?.checkDigitValid).toBe(false);
    expect(buildStructural("WVWZZZ1JZ1W123456", 2026).region).toBe("Europe");
  });

  it.each([
    ["I1HGCM82633A004352", "1HGCM82633A004352"],
    ["1HG CM826 3 3 A 004352", "1HGCM82633A004352"],
  ])("extracts %s", (raw, vin) => {
    expect(extractVin(raw)?.vin).toBe(vin);
  });

  it.each([
    "1HGCM82633A00435",
    "1HGCM8263IA004352",
    // Z1: a run holding more than one plausible VIN is refused, not ranked.
    "1HGCM82633A0043531HGCM82633A004352",
    "UNIT B\n1HGCM82633A004352",
  ])("rejects %s", (raw) => {
    expect(extractVin(raw)).toBeNull();
  });
});
