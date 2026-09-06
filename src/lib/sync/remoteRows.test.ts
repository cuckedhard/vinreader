/**
 * Reading rows that came back from the account.
 *
 * The rows belong to the user and RLS keeps everyone else's out, but they were written by
 * *some* build of this app — older, newer, or on a phone whose schema is not this one's.
 * A row that cannot be read is dropped, never coerced: a coerced symbology would put an
 * invented fact in an append-only log (N2), and a coerced decode block could outrank a real
 * one under §4.12's ranking.
 */
import { describe, expect, it } from "vitest";

import {
  parseRemoteDecode,
  parseRemoteScanEvent,
  parseRemoteVehicle,
  toLocalScanEvent,
} from "./remoteRows";

const VIN = "1HGCM82633A004352";
const AT = "2026-09-04T06:00:00.000-06:00";

function vehicleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_id: "user-1",
    vin: VIN,
    unit: "TRK-118",
    notes: null,
    meta_updated_at: AT,
    structural: {},
    decode: {},
    first_scanned_at: AT,
    last_scanned_at: AT,
    scan_count: 2,
    deleted_at: null,
    updated_at: AT,
    ...overrides,
  };
}

function eventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "event-1",
    user_id: "user-1",
    vin: VIN,
    at: AT,
    symbology: "code_39",
    check_digit_valid: true,
    device_label: "Bay 3",
    origin: "scan",
    inserted_at: AT,
    ...overrides,
  };
}

describe("parseRemoteVehicle", () => {
  it("reads the paint code, and reads a row from before the column as having none", () => {
    // S5's column (migration 0002). An account that has not been migrated, or a row written
    // by a build older than S5, simply has no `paint` key — which is null, the same value a
    // record starts with, and never a rendered fact (N2).
    expect(parseRemoteVehicle(vehicleRow({ paint: "NH-731P" }))?.paint).toBe("NH-731P");
    expect(parseRemoteVehicle(vehicleRow())?.paint).toBeNull();
    expect(parseRemoteVehicle(vehicleRow({ paint: 7 }))?.paint).toBeNull();
  });

  it("reads a row §4.12 wrote", () => {
    expect(parseRemoteVehicle(vehicleRow())).toMatchObject({
      vin: VIN,
      unit: "TRK-118",
      notes: null,
      metaUpdatedAt: AT,
      structural: null,
      decode: null,
      scanCount: 2,
      deletedAt: null,
      updatedAt: AT,
    });
  });

  it("refuses a row with no usable VIN, LWW clock or cursor", () => {
    expect(parseRemoteVehicle(vehicleRow({ vin: "not-a-vin" }))).toBeNull();
    expect(parseRemoteVehicle(vehicleRow({ vin: 17 }))).toBeNull();
    // `I`, `O` and `Q` are not §4.1 characters.
    expect(parseRemoteVehicle(vehicleRow({ vin: "1HGCM8263IA004352" }))).toBeNull();
    expect(parseRemoteVehicle(vehicleRow({ meta_updated_at: "yesterday" }))).toBeNull();
    expect(parseRemoteVehicle(vehicleRow({ updated_at: null }))).toBeNull();
  });

  it("treats an empty structural block as absent and keeps a populated one", () => {
    expect(parseRemoteVehicle(vehicleRow({ structural: { wmi: "1HG" } }))?.structural).toEqual({
      wmi: "1HG",
    });
    expect(parseRemoteVehicle(vehicleRow({ structural: [] }))?.structural).toBeNull();
    expect(parseRemoteVehicle(vehicleRow({ structural: null }))?.structural).toBeNull();
  });

  it("treats a count that is not a whole number of scans as zero", () => {
    expect(parseRemoteVehicle(vehicleRow({ scan_count: "7" }))?.scanCount).toBe(0);
    expect(parseRemoteVehicle(vehicleRow({ scan_count: 2.5 }))?.scanCount).toBe(0);
    expect(parseRemoteVehicle(vehicleRow({ scan_count: -1 }))?.scanCount).toBe(0);
  });
});

describe("parseRemoteDecode", () => {
  it("reads a §5.1 block and drops the empty vPIC fields (N2)", () => {
    const decode = parseRemoteDecode({
      status: "ok",
      source: "nhtsa_vpic",
      fetchedAt: AT,
      attempts: 3,
      lastError: null,
      fields: { Make: "HONDA", Model: "", Trim: 7 },
    });
    expect(decode).toMatchObject({ status: "ok", fetchedAt: AT, attempts: 3 });
    expect(decode?.fields).toEqual({ Make: "HONDA" });
  });

  it("returns nothing for a block that carries no §4.10 status", () => {
    // `'{}'::jsonb` is what `apply_scan_event` leaves behind, and a status this build does
    // not know scores the same 0 that `pending` and `failed` already score.
    expect(parseRemoteDecode({})).toBeNull();
    expect(parseRemoteDecode(null)).toBeNull();
    expect(parseRemoteDecode("ok")).toBeNull();
    expect(parseRemoteDecode({ status: "brilliant" })).toBeNull();
  });

  it("defaults the fields it cannot read rather than dropping the block", () => {
    expect(
      parseRemoteDecode({ status: "partial", fields: "nonsense", attempts: -2 }),
    ).toMatchObject({ status: "partial", fields: {}, attempts: 0, fetchedAt: null });
  });
});

describe("parseRemoteScanEvent", () => {
  it("reads a row §4.12 wrote", () => {
    expect(parseRemoteScanEvent(eventRow())).toMatchObject({
      id: "event-1",
      vin: VIN,
      at: AT,
      symbology: "code_39",
      checkDigitValid: true,
      deviceLabel: "Bay 3",
      origin: "scan",
      insertedAt: AT,
    });
  });

  it("refuses a row it cannot read", () => {
    expect(parseRemoteScanEvent(eventRow({ id: null }))).toBeNull();
    expect(parseRemoteScanEvent(eventRow({ vin: "short" }))).toBeNull();
    expect(parseRemoteScanEvent(eventRow({ at: "" }))).toBeNull();
    expect(parseRemoteScanEvent(eventRow({ inserted_at: undefined }))).toBeNull();
    expect(parseRemoteScanEvent(eventRow({ origin: null }))).toBeNull();
    // A symbology from a build this one does not know. Coercing it would invent a fact.
    expect(parseRemoteScanEvent(eventRow({ symbology: "pdf_417" }))).toBeNull();
  });

  it("reads a check digit column that is not a boolean as false", () => {
    expect(parseRemoteScanEvent(eventRow({ check_digit_valid: "true" }))?.checkDigitValid).toBe(
      false,
    );
  });

  it("lands as a §5.2 row with no raw read (N3) and no origin", () => {
    const local = toLocalScanEvent(parseRemoteScanEvent(eventRow())!);
    expect(local).toEqual({
      id: "event-1",
      vin: VIN,
      at: AT,
      symbology: "code_39",
      raw: "",
      checkDigitValid: true,
      deviceLabel: "Bay 3",
    });
  });
});
