import { describe, expect, it } from "vitest";
import { normalizeVehicle } from "./normalize";
import { buildStructural } from "../vin/structural";
import type { VehicleRecord } from "../vin/types";

const VIN = "1HGCM82633A004352";

/** The row shape §4.12 produces when `apply_scan_event` creates it before any meta push. */
function syncShaped(): VehicleRecord {
  return {
    vin: VIN,
    structural: {} as VehicleRecord["structural"],
    decode: {} as VehicleRecord["decode"],
    unit: null,
    notes: null,
    firstScannedAt: "2026-01-01T00:00:00.000+00:00",
    lastScannedAt: "2026-01-01T00:00:00.000+00:00",
    scanCount: 1,
    origin: "scan",
    metaUpdatedAt: "1970-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

describe("normalizeVehicle", () => {
  it("rebuilds an empty structural block from the VIN rather than defending against it", () => {
    const got = normalizeVehicle(syncShaped(), 2026);
    // The VIN is the primary key, so structural is always recoverable (§4.1–§4.5).
    expect(got.structural).toEqual(buildStructural(VIN, 2026));
    expect(got.structural.modelYear.resolved).toBe(2003);
    expect(got.structural.region).toBe("North America");
  });

  it("defaults an empty decode block to pending", () => {
    const got = normalizeVehicle(syncShaped(), 2026);
    expect(got.decode).toEqual({
      status: "pending",
      source: "nhtsa_vpic",
      fetchedAt: null,
      attempts: 0,
      lastError: null,
      fields: {},
    });
  });

  it("leaves a complete record untouched", () => {
    const complete: VehicleRecord = {
      ...syncShaped(),
      structural: buildStructural(VIN, 2026),
      decode: {
        status: "ok",
        source: "nhtsa_vpic",
        fetchedAt: "2026-01-02T00:00:00.000+00:00",
        attempts: 1,
        lastError: null,
        fields: { Make: "HONDA" },
      },
    };
    expect(normalizeVehicle(complete, 2026)).toEqual(complete);
  });

  it("keeps a populated decode that is missing its fields map", () => {
    const row = syncShaped();
    row.decode = {
      status: "partial",
      source: "nhtsa_vpic",
      fetchedAt: null,
      attempts: 2,
      lastError: "boom",
    } as VehicleRecord["decode"];
    const got = normalizeVehicle(row, 2026);
    expect(got.decode.status).toBe("partial");
    expect(got.decode.attempts).toBe(2);
    expect(got.decode.lastError).toBe("boom");
    expect(got.decode.fields).toEqual({});
  });

  it("carries every field outside the two blocks through unchanged", () => {
    const row = { ...syncShaped(), unit: "UNIT-42", notes: "rear light out", scanCount: 3 };
    const got = normalizeVehicle(row, 2026);
    expect(got.unit).toBe("UNIT-42");
    expect(got.notes).toBe("rear light out");
    expect(got.scanCount).toBe(3);
    expect(got.metaUpdatedAt).toBe("1970-01-01T00:00:00.000Z");
  });
});
