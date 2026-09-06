import { describe, expect, it } from "vitest";
import { buildStructural } from "../vin/structural";
import type { VehicleDecode, VehicleRecord } from "../vin/types";
import { META_NEVER_EDITED } from "../vin/types";
import { shareText } from "./shareText";

/** §4.11 fixture: check digit valid, year resolves to 2003 against a 2026 clock. */
const VIN = "1HGCM82633A004352";
const AT = "2026-09-03T14:12:00-08:00";

function decode(fields: Record<string, string>): VehicleDecode {
  return {
    status: "ok",
    source: "nhtsa_vpic",
    fetchedAt: AT,
    attempts: 1,
    lastError: null,
    fields,
  };
}

function makeRecord(overrides: Partial<VehicleRecord> = {}): VehicleRecord {
  return {
    vin: VIN,
    structural: buildStructural(VIN, 2026),
    decode: decode({}),
    unit: null,
    notes: null,
    paint: null,
    paintSource: null,
    paintConfidence: null,
    firstScannedAt: AT,
    lastScannedAt: AT,
    scanCount: 1,
    origin: "scan",
    metaUpdatedAt: META_NEVER_EDITED,
    deletedAt: null,
    ...overrides,
  };
}

/** The §4.9 example with its "…" placeholders filled in; the labels and order are the spec's. */
const EXAMPLE_FIELDS: Record<string, string> = {
  ModelYear: "2003",
  Make: "HONDA",
  Model: "Accord",
  BodyClass: "Sedan/Saloon",
  EngineModel: "J30A4",
  FuelTypePrimary: "Gasoline",
  DriveType: "FWD",
  GVWR: "Class 1C: 4,001 - 5,000 lb",
  PlantCity: "MARYSVILLE",
  PlantState: "OHIO",
  PlantCountry: "UNITED STATES (USA)",
};

function example(overrides: Partial<VehicleRecord> = {}): VehicleRecord {
  return makeRecord({ decode: decode({ ...EXAMPLE_FIELDS }), unit: "UNIT-42", ...overrides });
}

function without(...keys: string[]): Record<string, string> {
  const fields = { ...EXAMPLE_FIELDS };
  for (const key of keys) delete fields[key];
  return fields;
}

describe("shareText — the §4.9 block", () => {
  it("reproduces the §4.9 example exactly", () => {
    expect(shareText(example())).toBe(
      [
        "2003 HONDA Accord (Sedan/Saloon)",
        "VIN 1HG CM826 3 3 A 004352",
        "Engine J30A4 · Gasoline · FWD · GVWR Class 1C: 4,001 - 5,000 lb",
        "Plant: MARYSVILLE, OHIO, UNITED STATES (USA)",
        "Unit UNIT-42 · Scanned 2026-09-03 14:12 · VIN Relay",
      ].join("\n"),
    );
  });

  it("keeps the paint code out of the text, as §4.9 keeps it out of this block", () => {
    // Decided from the spec, not from taste. §4.9 fixes this block line by line and its
    // last line ends at "VIN Relay"; the amendment that added `pc` on 2026-09-06 changed
    // the JSON field list and the drop order and left the share text exactly as it was.
    // Adding a line here would be re-deriving a §4 constant (rule 2), and the summary is
    // §6.5's "Summary" button and the text `parseShareTextVin` reads back — a sixth line
    // would change both. The paint code travels in the payload beside it, which is what
    // Share attaches and what Copy link carries.
    const text = shareText(example({ paint: "NH-731P" }));
    expect(text).not.toContain("NH-731P");
    expect(text.split("\n")).toHaveLength(5);
  });

  it("keeps the device label out of the text (§4.9 carries it in the payload's `by`)", () => {
    expect(shareText(example())).toBe(shareText(example()));
  });
});

describe("shareText — rows with no data are omitted", () => {
  it("drops the identity line when year, make, model and body are all unknown", () => {
    const record = example({
      decode: decode(without("ModelYear", "Make", "Model", "BodyClass")),
      // N2: two candidates and no resolution, so the structural year is not a fact to print.
      structural: {
        ...buildStructural(VIN, 2026),
        modelYear: { candidates: [2003, 2033], resolved: null },
      },
    });
    const lines = shareText(record).split("\n");
    expect(lines[0]).toBe("VIN 1HG CM826 3 3 A 004352");
    expect(lines).toHaveLength(4);
  });

  it("drops the powertrain line when engine, fuel, drive and GVWR are all unknown", () => {
    const text = shareText(
      example({ decode: decode(without("EngineModel", "FuelTypePrimary", "DriveType", "GVWR")) }),
    );
    expect(text.split("\n")).toEqual([
      "2003 HONDA Accord (Sedan/Saloon)",
      "VIN 1HG CM826 3 3 A 004352",
      "Plant: MARYSVILLE, OHIO, UNITED STATES (USA)",
      "Unit UNIT-42 · Scanned 2026-09-03 14:12 · VIN Relay",
    ]);
  });

  it("keeps the powertrain line when only some parts are known", () => {
    const text = shareText(example({ decode: decode(without("FuelTypePrimary", "GVWR")) }));
    expect(text.split("\n")[2]).toBe("Engine J30A4 · FWD");
  });

  it("drops the plant line when vPIC gave no plant, and skips the empty parts otherwise", () => {
    const none = shareText(
      example({ decode: decode(without("PlantCity", "PlantState", "PlantCountry")) }),
    );
    expect(none).not.toContain("Plant");
    expect(shareText(example({ decode: decode(without("PlantState")) }))).toContain(
      "Plant: MARYSVILLE, UNITED STATES (USA)",
    );
  });

  it("drops the unit when the record has none, keeping the scan time and the app name", () => {
    const lines = shareText(example({ unit: null })).split("\n");
    expect(lines[lines.length - 1]).toBe("Scanned 2026-09-03 14:12 · VIN Relay");
  });

  it("drops a whitespace-only unit and drops the body from the identity line", () => {
    const record = example({ unit: "   ", decode: decode(without("BodyClass")) });
    const lines = shareText(record).split("\n");
    expect(lines[0]).toBe("2003 HONDA Accord");
    expect(lines[lines.length - 1]).toBe("Scanned 2026-09-03 14:12 · VIN Relay");
  });

  it("prints nothing but the VIN and the trailer for a record with nothing else", () => {
    const record = makeRecord({
      structural: {
        ...buildStructural(VIN, 2026),
        modelYear: { candidates: [2003, 2033], resolved: null },
      },
    });
    expect(shareText(record)).toBe(
      ["VIN 1HG CM826 3 3 A 004352", "Scanned 2026-09-03 14:12 · VIN Relay"].join("\n"),
    );
  });

  it("falls back to the resolved structural year when vPIC has not answered", () => {
    // Same record, structural year left as `buildStructural` resolved it: 2003.
    expect(shareText(makeRecord()).split("\n")[0]).toBe("2003");
  });
});

describe("shareText — the scan time keeps the record's own offset (§5.1)", () => {
  it("prints the wall clock of a +05:30 scan, not the UTC or reader-zone hour", () => {
    const record = example({ lastScannedAt: "2026-01-15T23:45:10.250+05:30" });
    const last = shareText(record).split("\n").pop();
    expect(last).toBe("Unit UNIT-42 · Scanned 2026-01-15 23:45 · VIN Relay");
    // 23:45+05:30 is 18:15Z on the same day; re-zoning would also move a late scan a day.
    expect(last).not.toContain("18:15");
  });

  it("prints the wall clock of a -08:00 scan and of a Z scan alike", () => {
    expect(shareText(example({ lastScannedAt: "2026-09-03T23:59:00-08:00" }))).toContain(
      "Scanned 2026-09-03 23:59",
    );
    expect(shareText(example({ lastScannedAt: "2026-09-03T07:05:00Z" }))).toContain(
      "Scanned 2026-09-03 07:05",
    );
  });

  it("omits the scan time rather than printing a malformed one", () => {
    const last = shareText(example({ lastScannedAt: "not a timestamp" }))
      .split("\n")
      .pop();
    expect(last).toBe("Unit UNIT-42 · VIN Relay");
  });
});
