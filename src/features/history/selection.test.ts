import { describe, expect, it } from "vitest";
import { buildStructural } from "../../lib/vin/structural";
import { META_NEVER_EDITED } from "../../lib/vin/types";
import type { VehicleRecord } from "../../lib/vin/types";
import { allSelected, selectedRecords, toggleVin, withAll } from "./selection";

const AT = "2026-09-03T14:12:00-08:00";
const A = "1HGCM82633A004352";
const B = "1HGCM826X3A004350";
const C = "WVWZZZ1JZ1W123456";

function record(vin: string): VehicleRecord {
  return {
    vin,
    structural: buildStructural(vin, 2026),
    decode: {
      status: "pending",
      source: "nhtsa_vpic",
      fetchedAt: null,
      attempts: 0,
      lastError: null,
      fields: {},
    },
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

describe("toggleVin", () => {
  it("adds what is absent and removes what is present", () => {
    const once = toggleVin(new Set<string>(), A);
    expect([...once]).toEqual([A]);
    expect([...toggleVin(once, A)]).toEqual([]);
  });

  it("returns a new set, so React sees the change", () => {
    const before = new Set([A]);
    expect(toggleVin(before, B)).not.toBe(before);
    expect([...before]).toEqual([A]);
  });
});

describe("withAll", () => {
  it("adds without dropping what was already selected", () => {
    expect([...withAll(new Set([A]), [B, C, B])].sort()).toEqual([A, B, C].sort());
  });
});

describe("selectedRecords", () => {
  it("keeps the screen's order, not the order the rows were picked in", () => {
    const rows = [record(A), record(B), record(C)];
    expect(selectedRecords(rows, new Set([C, A])).map((row) => row.vin)).toEqual([A, C]);
  });

  it("drops a VIN whose record is gone, so the count matches what a copy would write", () => {
    // §4.12: another device can delete a vehicle while it sits selected here.
    expect(selectedRecords([record(A)], new Set([A, B]))).toHaveLength(1);
  });
});

describe("allSelected", () => {
  it("is false for an empty list — nothing selected is not everything selected", () => {
    expect(allSelected([], new Set([A]))).toBe(false);
  });

  it("is true only when every listed record is in the set", () => {
    const rows = [record(A), record(B)];
    expect(allSelected(rows, new Set([A]))).toBe(false);
    expect(allSelected(rows, new Set([A, B]))).toBe(true);
    // A selection can hold VINs the search has filtered out; that does not make the
    // filtered list partly selected.
    expect(allSelected([record(A)], new Set([A, C]))).toBe(true);
  });
});
