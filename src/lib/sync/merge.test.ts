/**
 * §4.12's merge rules, which the spec requires to be "identical on server and client".
 *
 * Every case below is written against the SQL in `supabase/migrations/0001_init.sql` —
 * `upsert_vehicle_meta`'s conflict body, `better_decode`, `decode_rank` — and the
 * scenario tests then run the same rules through the transcription of that SQL in
 * `supabaseFake.testutil.ts`, so a rule that drifts here fails twice.
 */
import { describe, expect, it } from "vitest";

import { buildStructural } from "../vin/structural";
import type { VehicleDecode, VehicleRecord } from "../vin/types";
import { NO_PENDING, betterDecode, decodeRank, mergeVehicle } from "./merge";
import type { RemoteVehicle } from "./types";

const VIN = "1HGCM82633A004352"; // §4.11 fixture.
const YEAR = 2026;

const T = {
  early: "2026-01-05T08:00:00.000-06:00",
  mid: "2026-02-05T08:00:00.000-06:00",
  late: "2026-03-05T08:00:00.000-06:00",
};

function decode(overrides: Partial<VehicleDecode> = {}): VehicleDecode {
  return {
    status: "pending",
    source: "nhtsa_vpic",
    fetchedAt: null,
    attempts: 0,
    lastError: null,
    fields: {},
    ...overrides,
  };
}

function local(overrides: Partial<VehicleRecord> = {}): VehicleRecord {
  return {
    vin: VIN,
    structural: buildStructural(VIN, YEAR),
    decode: decode(),
    unit: null,
    notes: null,
    paint: null,
    firstScannedAt: T.mid,
    lastScannedAt: T.mid,
    scanCount: 1,
    origin: "scan",
    metaUpdatedAt: T.mid,
    deletedAt: null,
    ...overrides,
  };
}

function remote(overrides: Partial<RemoteVehicle> = {}): RemoteVehicle {
  return {
    vin: VIN,
    unit: null,
    notes: null,
    metaUpdatedAt: T.mid,
    structural: null,
    decode: null,
    firstScannedAt: T.mid,
    lastScannedAt: T.mid,
    scanCount: 1,
    deletedAt: null,
    updatedAt: T.mid,
    ...overrides,
  };
}

describe("decode_rank / better_decode (§4.12)", () => {
  it("ranks ok 3 > partial 2 > unsupported 1 > pending and failed 0", () => {
    expect(decodeRank({ status: "ok" })).toBe(3);
    expect(decodeRank({ status: "partial" })).toBe(2);
    expect(decodeRank({ status: "unsupported" })).toBe(1);
    expect(decodeRank({ status: "pending" })).toBe(0);
    expect(decodeRank({ status: "failed" })).toBe(0);
    // The `else` arm of the SQL `case`: an absent or unreadable block scores 0.
    expect(decodeRank(null)).toBe(0);
    expect(decodeRank({ status: "something-else" })).toBe(0);
  });

  it("takes the higher rank whatever the timestamps say", () => {
    const stored = decode({ status: "ok", fetchedAt: T.late });
    const incoming = decode({ status: "partial", fetchedAt: T.late });
    expect(betterDecode(stored, incoming)).toBe(stored);
    expect(betterDecode(incoming, stored)).toBe(stored);
  });

  it("breaks an equal rank on the newer fetchedAt, and keeps the existing one on a tie", () => {
    const older = decode({ status: "ok", fetchedAt: T.early });
    const newerBlock = decode({ status: "ok", fetchedAt: T.late });
    expect(betterDecode(older, newerBlock)).toBe(newerBlock);
    expect(betterDecode(newerBlock, older)).toBe(newerBlock);
    // `coalesce(..., '-infinity')`: a null fetchedAt never wins a tie.
    expect(betterDecode(decode({ status: "ok" }), decode({ status: "ok" }))).toEqual(
      decode({ status: "ok" }),
    );
    expect(betterDecode(older, decode({ status: "ok", fetchedAt: null }))).toBe(older);
  });

  it("keeps the local block when the account has none", () => {
    const stored = decode({ status: "partial", fetchedAt: T.mid });
    expect(betterDecode(stored, null)).toBe(stored);
  });
});

describe("unit and notes — last writer wins by meta_updated_at (§4.12)", () => {
  it("takes the account's values when its clock is newer", () => {
    const merged = mergeVehicle(
      local({ unit: "TRK-1", notes: "mine" }),
      remote({ unit: "TRK-9", notes: "theirs", metaUpdatedAt: T.late }),
      { currentYear: YEAR },
    );
    expect(merged).toMatchObject({ unit: "TRK-9", notes: "theirs", metaUpdatedAt: T.late });
  });

  it("keeps this device's values when its clock is newer", () => {
    const merged = mergeVehicle(
      local({ unit: "TRK-1", notes: "mine", metaUpdatedAt: T.late }),
      remote({ unit: "TRK-9", notes: "theirs", metaUpdatedAt: T.early }),
      { currentYear: YEAR },
    );
    // `meta_updated_at = greatest(...)`: the clock still moves to the newest either side saw.
    expect(merged).toMatchObject({ unit: "TRK-1", notes: "mine", metaUpdatedAt: T.late });
  });

  it("keeps the existing value on a tie", () => {
    const merged = mergeVehicle(
      local({ unit: "TRK-1", metaUpdatedAt: T.mid }),
      remote({ unit: "TRK-9", metaUpdatedAt: T.mid }),
      { currentYear: YEAR },
    );
    expect(merged?.unit).toBe("TRK-1");
  });

  it("keeps local unit and notes while a newer vehicle_meta is still unpushed", () => {
    // §4.12: "a local vehicle that still has an unpushed vehicle_meta newer than the
    // server's meta_updated_at keeps its local unit/notes until pushed."
    const merged = mergeVehicle(
      local({ unit: "TRK-1", metaUpdatedAt: T.early }),
      remote({ unit: "TRK-9", metaUpdatedAt: T.mid }),
      { currentYear: YEAR, pending: { ...NO_PENDING, metaUpdatedAt: T.late } },
    );
    expect(merged?.unit).toBe("TRK-1");
  });

  it("does not let a queued row older than the account's clock hold the merge back", () => {
    const merged = mergeVehicle(
      local({ unit: "TRK-1", metaUpdatedAt: T.early }),
      remote({ unit: "TRK-9", metaUpdatedAt: T.late }),
      { currentYear: YEAR, pending: { ...NO_PENDING, metaUpdatedAt: T.mid } },
    );
    expect(merged?.unit).toBe("TRK-9");
  });
});

describe("aggregates and structural (§4.12)", () => {
  it("takes first = min and last = max across the two sides", () => {
    const merged = mergeVehicle(
      local({ firstScannedAt: T.mid, lastScannedAt: T.mid }),
      remote({ firstScannedAt: T.early, lastScannedAt: T.late }),
      { currentYear: YEAR },
    );
    expect(merged).toMatchObject({ firstScannedAt: T.early, lastScannedAt: T.late });
  });

  it("never moves the scan count backwards", () => {
    // Each side counts only the events it holds: the account has not seen what is still in
    // the outbox, and this device has not seen another phone's scans until it pulls.
    expect(
      mergeVehicle(local({ scanCount: 7 }), remote({ scanCount: 2 }), { currentYear: YEAR }),
    ).toMatchObject({ scanCount: 7 });
    expect(
      mergeVehicle(local({ scanCount: 2 }), remote({ scanCount: 7 }), { currentYear: YEAR }),
    ).toMatchObject({ scanCount: 7 });
    // A count that is not a whole number of scans is treated as absent, not repaired.
    expect(
      mergeVehicle(local({ scanCount: -3 }), remote({ scanCount: 4 }), { currentYear: YEAR }),
    ).toMatchObject({ scanCount: 4 });
  });

  it("rebuilds structural from the VIN rather than trusting either side", () => {
    const merged = mergeVehicle(local(), remote({ structural: { wmi: "XXX" } }), {
      currentYear: YEAR,
    });
    expect(merged?.structural).toEqual(buildStructural(VIN, YEAR));
  });

  it("creates a record for a VIN this device has never seen, marked origin cloud", () => {
    const merged = mergeVehicle(undefined, remote({ unit: "TRK-9", scanCount: 3 }), {
      currentYear: YEAR,
    });
    expect(merged).toMatchObject({
      vin: VIN,
      unit: "TRK-9",
      scanCount: 3,
      origin: "cloud",
      deletedAt: null,
    });
    expect(merged?.structural).toEqual(buildStructural(VIN, YEAR));
  });

  it("falls back to the meta clock for a row the account created without any scan", () => {
    // `upsert_vehicle_meta` creates rows with null first/last_scanned_at; §5.1 types both
    // as strings, so the one timestamp such a row does carry stands in for them.
    const merged = mergeVehicle(
      undefined,
      remote({ firstScannedAt: null, lastScannedAt: null, scanCount: 0, metaUpdatedAt: T.late }),
      { currentYear: YEAR },
    );
    expect(merged).toMatchObject({ firstScannedAt: T.late, lastScannedAt: T.late });
  });
});

describe("deleted_at (§4.12)", () => {
  it("tombstones a record the account has deleted", () => {
    const merged = mergeVehicle(local(), remote({ deletedAt: T.late }), { currentYear: YEAR });
    expect(merged?.deletedAt).toBe(T.late);
  });

  it("writes nothing at all for a tombstone this device has never held", () => {
    expect(
      mergeVehicle(undefined, remote({ deletedAt: T.late }), { currentYear: YEAR }),
    ).toBeNull();
  });

  it("clears a local tombstone the account has already cleared", () => {
    const merged = mergeVehicle(local({ deletedAt: T.early }), remote(), { currentYear: YEAR });
    expect(merged?.deletedAt).toBeNull();
  });

  it("keeps a local tombstone whose delete has not been pushed yet", () => {
    const merged = mergeVehicle(local({ deletedAt: T.late }), remote(), {
      currentYear: YEAR,
      pending: { ...NO_PENDING, deleteQueued: true },
    });
    expect(merged?.deletedAt).toBe(T.late);
  });

  it("keeps a record alive when an unpushed scan is later than the account's tombstone", () => {
    // §4.12's own rule — "any later scan event clears it" — applied to an event the server
    // has not received yet. Without it a re-scan vanishes from History until it is pushed.
    const merged = mergeVehicle(local(), remote({ deletedAt: T.mid }), {
      currentYear: YEAR,
      pending: { ...NO_PENDING, scanAt: T.late },
    });
    expect(merged?.deletedAt).toBeNull();
  });

  it("still tombstones when the unpushed scan is older than the tombstone", () => {
    const merged = mergeVehicle(local(), remote({ deletedAt: T.late }), {
      currentYear: YEAR,
      pending: { ...NO_PENDING, scanAt: T.early },
    });
    expect(merged?.deletedAt).toBe(T.late);
  });
});
