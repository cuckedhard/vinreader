import { describe, expect, it, vi } from "vitest";
import type { Region } from "./types";
import {
  countryFromVin,
  manufacturerFromWmi,
  REGION_RANGES,
  regionFromVin,
  wmiFromVin,
  wmiSeedRows,
} from "./wmi";

// The committed seed is `{}` until `bun run seed:wmi` runs on a host that can reach
// vPIC (D09), so the lookup's hit path is only reachable against a stand-in seed.
vi.mock("./wmi-seed.json", () => ({
  default: {
    "1FT": { manufacturer: "FORD MOTOR COMPANY, USA", make: "FORD" },
    "1HG": { manufacturer: "HONDA MFG OF INDIANA, LLC" },
  },
}));

/** §4.1 alphabet: all 33 characters a position 1 can hold. */
const ALPHABET = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789".split("");

/** §4.5 pinned as a literal, character by character, independent of the ranges in wmi.ts. */
const EXPECTED_REGION: Record<string, Region | null> = {
  A: "Africa",
  B: "Africa",
  C: "Africa",
  D: "Africa",
  E: "Africa",
  F: "Africa",
  G: "Africa",
  H: "Africa",
  J: "Asia",
  K: "Asia",
  L: "Asia",
  M: "Asia",
  N: "Asia",
  P: "Asia",
  R: "Asia",
  S: "Europe",
  T: "Europe",
  U: "Europe",
  V: "Europe",
  W: "Europe",
  X: "Europe",
  Y: "Europe",
  Z: "Europe",
  "0": null,
  "1": "North America",
  "2": "North America",
  "3": "North America",
  "4": "North America",
  "5": "North America",
  "6": "Oceania",
  "7": "Oceania",
  "8": "South America",
  "9": "South America",
};

/** §4.5: the only six first characters that name a country. */
const EXPECTED_COUNTRY: Record<string, string> = {
  "1": "United States",
  "2": "Canada",
  "3": "Mexico",
  "4": "United States",
  "5": "United States",
  J: "Japan",
  L: "China",
  W: "Germany",
};

/** A 17-character VIN with `first` at position 1. */
function vinStartingWith(first: string): string {
  return `${first}HGCM82633A004352`;
}

describe("REGION_RANGES", () => {
  it("is the §4.5 table verbatim", () => {
    expect(REGION_RANGES).toEqual([
      ["ABCDEFGH", "Africa"],
      ["JKLMNPR", "Asia"],
      ["STUVWXYZ", "Europe"],
      ["12345", "North America"],
      ["67", "Oceania"],
      ["89", "South America"],
    ]);
  });

  it("covers 32 distinct §4.1 characters and never I, O, Q or 0", () => {
    const chars = REGION_RANGES.flatMap(([range]) => [...range]);
    expect(chars).toHaveLength(32);
    expect(new Set(chars).size).toBe(32);
    expect(chars.filter((c) => !ALPHABET.includes(c))).toEqual([]);
    expect(chars).not.toContain("0");
  });
});

describe("regionFromVin", () => {
  it.each(ALPHABET)("maps position 1 = %s to its §4.5 region", (char) => {
    expect(regionFromVin(vinStartingWith(char))).toBe(EXPECTED_REGION[char]);
  });

  it("assigns a region to every §4.1 character except 0 (D06)", () => {
    const regions = ALPHABET.map((char) => regionFromVin(vinStartingWith(char)));
    expect(regions.filter((region) => region === null)).toHaveLength(1);
    expect(regionFromVin(vinStartingWith("0"))).toBeNull();
    expect(new Set(regions.filter((region) => region !== null)).size).toBe(6);
  });

  it("returns null for characters outside the §4.1 alphabet and for an empty string", () => {
    for (const char of ["I", "O", "Q", "a", "w", "-", " "]) {
      expect(regionFromVin(vinStartingWith(char))).toBeNull();
    }
    expect(regionFromVin("")).toBeNull();
  });
});

describe("countryFromVin", () => {
  it.each(ALPHABET)("maps position 1 = %s to its §4.5 country or null", (char) => {
    expect(countryFromVin(vinStartingWith(char))).toBe(EXPECTED_COUNTRY[char] ?? null);
  });

  it("names a country for exactly eight first characters", () => {
    const named = ALPHABET.filter((char) => countryFromVin(vinStartingWith(char)) !== null);
    expect(named).toEqual(["J", "L", "W", "1", "2", "3", "4", "5"]);
  });

  it("returns null for an empty string", () => {
    expect(countryFromVin("")).toBeNull();
  });
});

describe("wmiFromVin", () => {
  it.each([
    ["1HGCM82633A004352", "1HG"],
    ["WVWZZZ1JZ1W123456", "WVW"],
    ["1FUJGLDR49SAV1234", "1FU"],
  ])("takes characters 1–3 of %s", (vin, wmi) => {
    expect(wmiFromVin(vin)).toBe(wmi);
  });

  it("returns what is there when the string is shorter than the WMI", () => {
    expect(wmiFromVin("1H")).toBe("1H");
    expect(wmiFromVin("")).toBe("");
  });
});

describe("wmiSeedRows", () => {
  it("flattens the compiled seed into the rows §5.5 seeds its table from", () => {
    expect(wmiSeedRows()).toEqual([
      { wmi: "1FT", manufacturer: "FORD MOTOR COMPANY, USA", make: "FORD" },
      { wmi: "1HG", manufacturer: "HONDA MFG OF INDIANA, LLC", make: null },
    ]);
  });
});

describe("manufacturerFromWmi", () => {
  it("returns the seeded manufacturer, with or without a make", () => {
    expect(manufacturerFromWmi("1FT")).toBe("FORD MOTOR COMPANY, USA");
    expect(manufacturerFromWmi("1HG")).toBe("HONDA MFG OF INDIANA, LLC");
  });

  it("returns null for an unseeded WMI", () => {
    expect(manufacturerFromWmi("4V4")).toBeNull();
    expect(manufacturerFromWmi("")).toBeNull();
  });

  it("returns null for Object.prototype keys", () => {
    expect(manufacturerFromWmi("constructor")).toBeNull();
    expect(manufacturerFromWmi("toString")).toBeNull();
  });
});
