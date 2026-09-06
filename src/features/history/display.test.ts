import { describe, expect, it } from "vitest";
import { buildStructural } from "../../lib/vin/structural";
import { META_NEVER_EDITED } from "../../lib/vin/types";
import type { VehicleDecode, VehicleRecord } from "../../lib/vin/types";
import { decodeChip, headline, matchesQuery, normalizeQuery, yearText } from "./display";

const AT = "2026-09-03T14:12:00-08:00";
/** §4.11's synthetic year case: pos 10 `T`, pos 7 a digit → 1996 or 2026, unresolved. */
const AMBIGUOUS = "1FTSW2160TEA12345";
/** §4.11: resolves to 2003 under the §4.4 cap. */
const RESOLVED = "1HGCM82633A004352";

function record(vin: string, fields: Record<string, string> = {}): VehicleRecord {
  const decode: VehicleDecode = {
    status: "ok",
    source: "nhtsa_vpic",
    fetchedAt: AT,
    attempts: 1,
    lastError: null,
    fields,
  };
  return {
    vin,
    structural: buildStructural(vin, 2026),
    decode,
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
  };
}

describe("yearText", () => {
  it("prefers vPIC's ModelYear, which §4.4 says overrides the structural candidates", () => {
    expect(yearText(record(AMBIGUOUS, { ModelYear: "1996" }))).toBe("1996");
  });

  it("shows a resolved structural year on its own", () => {
    expect(yearText(record(RESOLVED))).toBe("2003");
  });

  it("shows both candidates when nothing has resolved them (N2)", () => {
    const structural = record(AMBIGUOUS).structural;
    expect(structural.modelYear.resolved).toBeNull();
    expect(yearText(record(AMBIGUOUS))).toBe("1996 or 2026");
  });

  it("shows nothing rather than a placeholder when there is no year at all", () => {
    const row = record(RESOLVED);
    row.structural.modelYear = { candidates: [], resolved: null };
    expect(yearText(row)).toBeNull();
  });
});

describe("headline", () => {
  it("drops the year the table would show as two candidates", () => {
    expect(headline(record(AMBIGUOUS, { Make: "FORD" }))).toBe("FORD");
  });
});

describe("decodeChip", () => {
  it("says nothing about a healthy decode, in the list and in §6.6's Status column", () => {
    expect(decodeChip("ok")).toBeNull();
  });

  it("names the three statuses worth reading", () => {
    expect(decodeChip("pending")?.label).toBe("Details pending");
    expect(decodeChip("partial")?.tone).toBe("warn");
    expect(decodeChip("unsupported")?.tone).toBe("neutral");
    expect(decodeChip("failed")?.tone).toBe("warn");
  });

  it("renders no chip for a status outside §4.10 instead of throwing (P7)", () => {
    // A row written by a future schema, or a corrupt one.
    expect(decodeChip("weird" as never)).toBeNull();
  });
});

describe("matchesQuery", () => {
  it("matches a VIN pasted back in its §4.1 display groups", () => {
    expect(matchesQuery(record(RESOLVED), normalizeQuery("1HG CM826 3 3 A 004352"))).toBe(true);
  });

  it("matches the unit and the vPIC make and model", () => {
    const row = { ...record(RESOLVED, { Make: "HONDA", Model: "Accord" }), unit: "Truck 12" };
    expect(matchesQuery(row, normalizeQuery("truck 12"))).toBe(true);
    expect(matchesQuery(row, normalizeQuery("accord"))).toBe(true);
    expect(matchesQuery(row, normalizeQuery("peterbilt"))).toBe(false);
  });
});
