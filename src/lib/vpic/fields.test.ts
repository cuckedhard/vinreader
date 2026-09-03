import { describe, expect, it } from "vitest";
import { MAPPED_KEYS, NOTICE_KEYS, allFieldRows, noticeLines, renderGroups } from "./fields";

/**
 * Every field map below is SYNTHETIC. The network is unavailable in this environment
 * (vpic.nhtsa.dot.gov is refused), so no fixture here is a captured live response — each is
 * built from the §4.7 documented shape to exercise one rule of the §4.8 map.
 * The live check is `bun run scripts/verify-vpic-fields.ts`, run where vPIC is reachable.
 */

/** §4.8 pinned as a literal, independent of the implementation's own tables. */
const SPEC_KEYS = [
  "ModelYear",
  "Make",
  "Model",
  "Trim",
  "Series",
  "BodyClass",
  "VehicleType",
  "Doors",
  "EngineModel",
  "EngineCylinders",
  "DisplacementL",
  "FuelTypePrimary",
  "FuelTypeSecondary",
  "EngineHP",
  "Turbo",
  "DriveType",
  "TransmissionStyle",
  "TransmissionSpeeds",
  "GVWR",
  "GVWR_to",
  "Axles",
  "BrakeSystemType",
  "CabType",
  "BedType",
  "BedLengthIN",
  "Manufacturer",
  "PlantCity",
  "PlantState",
  "PlantCountry",
  "PlantCompanyName",
  "ErrorText",
  "AdditionalErrorText",
  "Note",
];

/** One value per §4.8 key, so every row and every group renders. */
const EVERY_FIELD: Record<string, string> = {
  ModelYear: "2003",
  Make: "HONDA",
  Model: "Accord",
  Trim: "EX",
  Series: "CM8",
  BodyClass: "Sedan/Saloon",
  VehicleType: "PASSENGER CAR",
  Doors: "4",
  EngineModel: "J30A4",
  EngineCylinders: "6",
  DisplacementL: "3.0",
  FuelTypePrimary: "Gasoline",
  FuelTypeSecondary: "Electric",
  EngineHP: "240",
  Turbo: "No",
  DriveType: "FWD",
  TransmissionStyle: "Automatic",
  TransmissionSpeeds: "5",
  GVWR: "Class 1C: 4,001 - 5,000 lb",
  GVWR_to: "Class 2E: 6,001 - 7,000 lb",
  Axles: "2",
  BrakeSystemType: "Hydraulic",
  CabType: "Crew",
  BedType: "Fleetside",
  BedLengthIN: "78.7",
  Manufacturer: "HONDA OF AMERICA MFG., INC.",
  PlantCity: "MARYSVILLE",
  PlantState: "OHIO",
  PlantCountry: "UNITED STATES (USA)",
  PlantCompanyName: "Marysville Auto Plant",
};

describe("MAPPED_KEYS", () => {
  it("names exactly the §4.8 keys, and no others", () => {
    expect([...MAPPED_KEYS].sort()).toEqual([...SPEC_KEYS].sort());
  });

  it("holds no duplicates, since the live check iterates it", () => {
    expect(new Set(MAPPED_KEYS).size).toBe(MAPPED_KEYS.length);
  });

  it("contains every notice key", () => {
    for (const key of NOTICE_KEYS) expect(MAPPED_KEYS).toContain(key);
  });
});

describe("NOTICE_KEYS", () => {
  it("is the §4.8 notice list in order", () => {
    expect(NOTICE_KEYS).toEqual(["ErrorText", "AdditionalErrorText", "Note"]);
  });
});

describe("renderGroups", () => {
  it("renders the four §4.8 groups, in order, with rows in §4.8 order", () => {
    expect(renderGroups(EVERY_FIELD)).toEqual([
      {
        title: "Identity",
        rows: [
          { label: "Year", value: "2003" },
          { label: "Make", value: "HONDA" },
          { label: "Model", value: "Accord" },
          { label: "Trim", value: "EX" },
          { label: "Series", value: "CM8" },
          { label: "Body", value: "Sedan/Saloon" },
          { label: "Type", value: "PASSENGER CAR" },
          { label: "Doors", value: "4" },
        ],
      },
      {
        title: "Powertrain",
        rows: [
          { label: "Engine", value: "J30A4" },
          { label: "Cylinders", value: "6" },
          { label: "Displacement (L)", value: "3.0" },
          { label: "Fuel", value: "Gasoline / Electric" },
          { label: "Horsepower", value: "240" },
          { label: "Turbo", value: "No" },
          { label: "Drive", value: "FWD" },
          { label: "Transmission", value: "Automatic, 5-speed" },
        ],
      },
      {
        title: "Weight & class",
        rows: [
          { label: "GVWR", value: "Class 1C: 4,001 - 5,000 lb – Class 2E: 6,001 - 7,000 lb" },
          { label: "Axles", value: "2" },
          { label: "Brakes", value: "Hydraulic" },
          { label: "Cab", value: "Crew" },
          { label: "Bed", value: "Fleetside, 78.7 in" },
        ],
      },
      {
        title: "Manufacturing",
        rows: [
          { label: "Manufacturer", value: "HONDA OF AMERICA MFG., INC." },
          { label: "Plant", value: "MARYSVILLE, OHIO, UNITED STATES (USA)" },
          { label: "Plant company", value: "Marysville Auto Plant" },
        ],
      },
    ]);
  });

  it("returns nothing at all for an empty field map", () => {
    expect(renderGroups({})).toEqual([]);
  });

  it("omits a group whose every key is missing, keeping the others in order", () => {
    const groups = renderGroups({ Make: "FREIGHTLINER", GVWR: "Class 8: 33,001 lb and above" });
    expect(groups.map((group) => group.title)).toEqual(["Identity", "Weight & class"]);
    expect(groups[0]?.rows).toEqual([{ label: "Make", value: "FREIGHTLINER" }]);
    expect(groups[1]?.rows).toEqual([{ label: "GVWR", value: "Class 8: 33,001 lb and above" }]);
  });

  it("omits a row whose value is empty or whitespace only (N2)", () => {
    const groups = renderGroups({ Make: "MACK", Model: "", Trim: "   ", Series: "Anthem" });
    expect(groups).toEqual([
      {
        title: "Identity",
        rows: [
          { label: "Make", value: "MACK" },
          { label: "Series", value: "Anthem" },
        ],
      },
    ]);
  });

  it("ignores keys the map does not name", () => {
    expect(renderGroups({ Make: "KENWORTH", NCSABodyType: "Truck", Windows: "2" })).toEqual([
      { title: "Identity", rows: [{ label: "Make", value: "KENWORTH" }] },
    ]);
  });

  /** The composites are the only rows with combining behaviour (§4.8). */
  function rowValue(fields: Record<string, string>, title: string, label: string): string | null {
    const group = renderGroups(fields).find((candidate) => candidate.title === title);
    return group?.rows.find((row) => row.label === label)?.value ?? null;
  }

  describe("Fuel", () => {
    it("joins a secondary fuel with ' / '", () => {
      const fields = { FuelTypePrimary: "Gasoline", FuelTypeSecondary: "Electric" };
      expect(rowValue(fields, "Powertrain", "Fuel")).toBe("Gasoline / Electric");
    });

    it("shows the primary alone when there is no secondary", () => {
      expect(rowValue({ FuelTypePrimary: "Diesel" }, "Powertrain", "Fuel")).toBe("Diesel");
    });

    it("shows a secondary alone rather than dropping it", () => {
      expect(rowValue({ FuelTypeSecondary: "Electric" }, "Powertrain", "Fuel")).toBe("Electric");
    });

    it("has no row when neither fuel is known", () => {
      expect(rowValue({ FuelTypePrimary: "", FuelTypeSecondary: "" }, "Powertrain", "Fuel")).toBe(
        null,
      );
    });
  });

  describe("Transmission", () => {
    it("joins speeds as 'N-speed' after the style", () => {
      const fields = { TransmissionStyle: "Manual", TransmissionSpeeds: "10" };
      expect(rowValue(fields, "Powertrain", "Transmission")).toBe("Manual, 10-speed");
    });

    it("shows the style alone when speeds are unknown", () => {
      expect(rowValue({ TransmissionStyle: "Automatic" }, "Powertrain", "Transmission")).toBe(
        "Automatic",
      );
    });

    it("shows speeds alone when the style is unknown", () => {
      expect(rowValue({ TransmissionSpeeds: "6" }, "Powertrain", "Transmission")).toBe("6-speed");
    });

    it("has no row when neither is known", () => {
      expect(rowValue({}, "Powertrain", "Transmission")).toBe(null);
    });
  });

  describe("GVWR", () => {
    it("shows a range when GVWR_to is present and different", () => {
      const fields = { GVWR: "Class 2E: 6,001 - 7,000 lb", GVWR_to: "Class 3: 10,001 - 14,000 lb" };
      expect(rowValue(fields, "Weight & class", "GVWR")).toBe(
        "Class 2E: 6,001 - 7,000 lb – Class 3: 10,001 - 14,000 lb",
      );
    });

    it("shows the plain value when GVWR_to repeats GVWR", () => {
      const fields = {
        GVWR: "Class 8: 33,001 lb and above",
        GVWR_to: "Class 8: 33,001 lb and above",
      };
      expect(rowValue(fields, "Weight & class", "GVWR")).toBe("Class 8: 33,001 lb and above");
    });

    it("shows the plain value when GVWR_to is absent", () => {
      expect(rowValue({ GVWR: "Class 1B: 3,001 - 4,000 lb" }, "Weight & class", "GVWR")).toBe(
        "Class 1B: 3,001 - 4,000 lb",
      );
    });

    it("has no row when only GVWR_to is known", () => {
      expect(rowValue({ GVWR_to: "Class 3: 10,001 - 14,000 lb" }, "Weight & class", "GVWR")).toBe(
        null,
      );
    });
  });

  describe("Bed", () => {
    it("joins a bed length with ', ' and an 'in' unit", () => {
      const fields = { BedType: "Fleetside", BedLengthIN: "98.3" };
      expect(rowValue(fields, "Weight & class", "Bed")).toBe("Fleetside, 98.3 in");
    });

    it("shows the type alone when the length is unknown", () => {
      expect(rowValue({ BedType: "Stepside" }, "Weight & class", "Bed")).toBe("Stepside");
    });

    it("shows the length alone when the type is unknown", () => {
      expect(rowValue({ BedLengthIN: "78.7" }, "Weight & class", "Bed")).toBe("78.7 in");
    });
  });

  describe("Plant", () => {
    it("joins city, state and country with ', '", () => {
      const fields = {
        PlantCity: "DEARBORN",
        PlantState: "MICHIGAN",
        PlantCountry: "UNITED STATES (USA)",
      };
      expect(rowValue(fields, "Manufacturing", "Plant")).toBe(
        "DEARBORN, MICHIGAN, UNITED STATES (USA)",
      );
    });

    it("leaves no stray comma when the state is missing", () => {
      const fields = { PlantCity: "OAKVILLE", PlantCountry: "CANADA" };
      expect(rowValue(fields, "Manufacturing", "Plant")).toBe("OAKVILLE, CANADA");
    });

    it("leaves no stray comma when only the country is known", () => {
      expect(rowValue({ PlantCountry: "JAPAN" }, "Manufacturing", "Plant")).toBe("JAPAN");
    });

    it("has no row when no part of the plant is known", () => {
      expect(rowValue({ Manufacturer: "TOYOTA" }, "Manufacturing", "Plant")).toBe(null);
    });
  });
});

describe("noticeLines", () => {
  it("returns the non-empty notice values in §4.8 order", () => {
    const fields = {
      Note: "Some fields are unavailable.",
      ErrorText: "6 - Incomplete VIN",
      AdditionalErrorText: "The check digit is invalid.",
    };
    expect(noticeLines(fields)).toEqual([
      "6 - Incomplete VIN",
      "The check digit is invalid.",
      "Some fields are unavailable.",
    ]);
  });

  it("drops empty and whitespace-only notices", () => {
    expect(noticeLines({ ErrorText: "", AdditionalErrorText: "  ", Note: "Kept" })).toEqual([
      "Kept",
    ]);
  });

  it("returns nothing when the record carries no notice", () => {
    expect(noticeLines({ Make: "HONDA" })).toEqual([]);
  });
});

describe("allFieldRows", () => {
  it("returns every field sorted by key, including keys the groups already show", () => {
    const fields = { Model: "Accord", Make: "HONDA", ErrorText: "", Doors: "4" };
    expect(allFieldRows(fields)).toEqual([
      { label: "Doors", value: "4" },
      { label: "ErrorText", value: "" },
      { label: "Make", value: "HONDA" },
      { label: "Model", value: "Accord" },
    ]);
  });

  it("keeps values untouched, unlike the group rows", () => {
    expect(allFieldRows({ Trim: "  EX  " })).toEqual([{ label: "Trim", value: "  EX  " }]);
  });

  it("returns nothing for an empty record", () => {
    expect(allFieldRows({})).toEqual([]);
  });

  it("sorts every §4.8 key deterministically, whatever the insertion order", () => {
    const reversed = Object.fromEntries([...Object.entries(EVERY_FIELD)].reverse()) as Record<
      string,
      string
    >;
    const keys = allFieldRows(reversed).map((row) => row.label);
    expect(keys).toEqual([...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(keys).toHaveLength(Object.keys(EVERY_FIELD).length);
  });
});
