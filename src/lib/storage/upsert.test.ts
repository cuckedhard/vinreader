import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { META_NEVER_EDITED } from "../vin/types";
import type { VehicleRecord } from "../vin/types";
import { db } from "./db";
import { setVehicleMeta, softDeleteVehicle, upsertVehicle, type UpsertInput } from "./upsert";

const VIN = "1HGCM82633A004352"; // §4.11 fixture: grammar ok, check digit valid.
const OTHER_VIN = "1FUJGLDR49SAV1234"; // §4.11 heavy truck, also check-digit valid.
const T1 = "2026-01-05T08:15:00.000-06:00";
const T2 = "2026-02-11T09:30:00.000-06:00";
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

function scan(overrides: Partial<UpsertInput> = {}): UpsertInput {
  return {
    vin: VIN,
    origin: "scan",
    symbology: "code_39",
    raw: VIN,
    checkDigitValid: true,
    ...overrides,
  };
}

beforeEach(async () => {
  await db.open();
  await Promise.all(db.tables.map((table) => table.clear()));
});

describe("upsertVehicle", () => {
  it("creates the record on a first scan", async () => {
    const record = await upsertVehicle(scan({ at: T1 }));

    expect(record.vin).toBe(VIN);
    expect(record.scanCount).toBe(1);
    expect(record.firstScannedAt).toBe(T1);
    expect(record.lastScannedAt).toBe(T1);
    expect(record.origin).toBe("scan");
    expect(record.deletedAt).toBeNull();
    expect(record.structural.wmi).toBe("1HG");
    expect(record.structural.checkDigitValid).toBe(true);
    expect(record.decode).toEqual({
      status: "pending",
      source: "nhtsa_vpic",
      fetchedAt: null,
      attempts: 0,
      lastError: null,
      fields: {},
    });
    // D11: never the scan time, or a later scan outranks a real edit under §4.12 LWW.
    expect(record.metaUpdatedAt).toBe(META_NEVER_EDITED);

    expect(await db.vehicles.count()).toBe(1);
    expect(await db.scanEvents.count()).toBe(1);
  });

  it("defaults both timestamps to ISO 8601 with offset", async () => {
    const record = await upsertVehicle(scan());

    expect(record.firstScannedAt).toMatch(ISO_WITH_OFFSET);
    expect(record.lastScannedAt).toBe(record.firstScannedAt);
  });

  it("upserts the same VIN instead of duplicating it", async () => {
    await upsertVehicle(scan({ at: T1 }));
    const record = await upsertVehicle(scan({ at: T2, symbology: "code_128" }));

    expect(record.scanCount).toBe(2);
    expect(record.firstScannedAt).toBe(T1);
    expect(record.lastScannedAt).toBe(T2);
    expect(await db.vehicles.count()).toBe(1);
    expect(await db.scanEvents.count()).toBe(2);
  });

  it("keeps the earlier firstScannedAt when an import arrives out of order", async () => {
    await upsertVehicle(scan({ at: T2 }));
    const record = await upsertVehicle(scan({ at: T1, origin: "import", symbology: "import" }));

    expect(record.firstScannedAt).toBe(T1);
    expect(record.lastScannedAt).toBe(T2);
    expect(record.origin).toBe("scan");
  });

  it("leaves metaUpdatedAt alone on a re-scan of an edited record", async () => {
    await upsertVehicle(scan({ at: T1 }));
    const edited = await setVehicleMeta(VIN, { unit: "TRK-118" });
    const rescanned = await upsertVehicle(scan({ at: T2 }));

    expect(rescanned.metaUpdatedAt).toBe(edited.metaUpdatedAt);
    expect(rescanned.unit).toBe("TRK-118");
  });

  it("takes a non-empty unit from an import and keeps it through later scans", async () => {
    const imported = await upsertVehicle(
      scan({ at: T1, origin: "import", symbology: "import", unit: "TRK-204", notes: "spare key" }),
    );

    expect(imported.unit).toBe("TRK-204");
    expect(imported.notes).toBe("spare key");
    expect(imported.metaUpdatedAt).not.toBe(META_NEVER_EDITED);

    const rescanned = await upsertVehicle(scan({ at: T2, unit: "   " }));

    expect(rescanned.unit).toBe("TRK-204");
    expect(rescanned.notes).toBe("spare key");
    expect(rescanned.metaUpdatedAt).toBe(imported.metaUpdatedAt);
  });

  it("logs the symbology and raw text it was given", async () => {
    const raw = `  ${VIN}  `;
    await upsertVehicle(
      scan({ at: T1, symbology: "data_matrix", raw, checkDigitValid: false, deviceLabel: "Bay 3" }),
    );

    const events = await db.scanEvents.where("vin").equals(VIN).toArray();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      vin: VIN,
      at: T1,
      symbology: "data_matrix",
      raw,
      checkDigitValid: false,
      deviceLabel: "Bay 3",
    });
    expect(events[0]?.id).toBeTypeOf("string");
  });

  it("clears a tombstone when the VIN is scanned again", async () => {
    await upsertVehicle(scan({ at: T1 }));
    await db.vehicles.update(VIN, { deletedAt: T1 });

    const record = await upsertVehicle(scan({ at: T2 }));

    expect(record.deletedAt).toBeNull();
  });
});

describe("setVehicleMeta", () => {
  it("sets the unit and stamps the device clock", async () => {
    await upsertVehicle(scan({ at: T1 }));
    const record = await setVehicleMeta(VIN, { unit: "TRK-118" });

    expect(record.unit).toBe("TRK-118");
    expect(record.notes).toBeNull();
    expect(record.metaUpdatedAt).not.toBe(META_NEVER_EDITED);
    expect(record.metaUpdatedAt).toMatch(ISO_WITH_OFFSET);
    expect((await db.vehicles.get(VIN))?.unit).toBe("TRK-118");
  });

  it("clears a field on an explicit empty value and leaves an absent one alone", async () => {
    await upsertVehicle(scan({ at: T1 }));
    await setVehicleMeta(VIN, { unit: "TRK-118", notes: "spare key" });
    const record = await setVehicleMeta(VIN, { unit: "" });

    expect(record.unit).toBeNull();
    expect(record.notes).toBe("spare key");
  });

  it("edits the notes without touching the unit", async () => {
    // The mirror of the case above, and the one the Sheet actually performs: unit and
    // notes are two separate fields, so saving one sends a patch with the other absent.
    // `undefined` means "leave it as it was" — a patch that read absence as a clear would
    // wipe the unit number off a truck every time someone typed a note about it (§5.6).
    await upsertVehicle(scan({ at: T1 }));
    await setVehicleMeta(VIN, { unit: "TRK-118", notes: "spare key" });
    const record = await setVehicleMeta(VIN, { notes: "rear light out" });

    expect(record.unit).toBe("TRK-118");
    expect(record.notes).toBe("rear light out");
    expect(await db.vehicles.get(VIN)).toMatchObject({ unit: "TRK-118" });
  });

  it("rejects a VIN it has never seen", async () => {
    await expect(setVehicleMeta(VIN, { unit: "TRK-118" })).rejects.toThrow(VIN);
  });
});

/** RFC 4122 v4: version nibble 4, variant nibble 8–b. §5.2 says the id is a UUID. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("§5.2 event ids on an origin without a secure context", () => {
  const randomUUID = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");
  const getRandomValues = Object.getOwnPropertyDescriptor(globalThis.crypto, "getRandomValues");

  function hide(name: "randomUUID" | "getRandomValues") {
    Object.defineProperty(globalThis.crypto, name, {
      configurable: true,
      writable: true,
      value: undefined,
    });
  }

  afterEach(() => {
    if (randomUUID) Object.defineProperty(globalThis.crypto, "randomUUID", randomUUID);
    if (getRandomValues)
      Object.defineProperty(globalThis.crypto, "getRandomValues", getRandomValues);
  });

  it("prefers crypto.randomUUID wherever it exists", async () => {
    const fixed = "0189d3f0-0b6a-4f4e-9c2a-4d2f6a1b7c3e";
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      writable: true,
      value: () => fixed,
    });

    await upsertVehicle(scan());
    expect((await db.scanEvents.toArray())[0]!.id).toBe(fixed);
  });

  it("keeps the UUID shape when randomUUID is [SecureContext]-gated away", async () => {
    hide("randomUUID");

    await upsertVehicle(scan());
    expect((await db.scanEvents.toArray())[0]!.id).toMatch(UUID_V4);
  });

  it("still writes distinct UUIDs with no crypto randomness at all", async () => {
    // The last resort. §5.2's log is append-only and S4 pushes `id` as the primary key
    // that makes a push idempotent (§4.12), so a repeat here is a lost scan event.
    hide("randomUUID");
    hide("getRandomValues");

    for (let i = 0; i < 25; i += 1) await upsertVehicle(scan());

    const ids = (await db.scanEvents.toArray()).map((event) => event.id);
    expect(ids.every((id) => UUID_V4.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(25);
  });
});

describe("§5.1 fields a stored row got wrong", () => {
  /** The shapes §4.12's `jsonb` defaults and a half-written row deliver — the read path's
   * `normalizeVehicle` guards them, and this is the write path's half. */
  async function store(patch: Record<string, unknown>) {
    const stored = (await db.vehicles.get(VIN))!;
    await db.vehicles.put({ ...stored, ...patch } as VehicleRecord);
  }

  it("counts in numbers from a scanCount that is not one", async () => {
    await upsertVehicle(scan({ at: T1 }));
    await store({ scanCount: "3" });

    expect((await upsertVehicle(scan({ at: T2 }))).scanCount).toBe(1);
    // And the count keeps counting from there rather than concatenating again.
    expect((await upsertVehicle(scan({ at: T2 }))).scanCount).toBe(2);
  });

  it("treats a fractional or negative count as absent", async () => {
    await upsertVehicle(scan({ at: T1 }));
    await store({ scanCount: -4 });
    expect((await upsertVehicle(scan({ at: T2 }))).scanCount).toBe(1);

    await store({ scanCount: 2.5 });
    expect((await upsertVehicle(scan({ at: T2 }))).scanCount).toBe(1);
  });

  it("heals a timestamp that is not a string instead of writing it back", async () => {
    await upsertVehicle(scan({ at: T2 }));
    // `Date.parse` coerces before it parses, so `Date.parse(0)` is a real instant in 2000
    // and a number here would otherwise win §4.12's min and land in a `string` field.
    await store({ firstScannedAt: 0, lastScannedAt: 0 });

    const record = await upsertVehicle(scan({ at: T1 }));
    expect(record.firstScannedAt).toBe(T1);
    expect(record.lastScannedAt).toBe(T1);
  });
});

/**
 * §4.12: "Every local write in the S0–S3 paths (scan, manual, import, unit/notes edit,
 * delete) also appends an outbox row." Those five paths are four functions and one screen
 * apart, but they all reach storage through this file, so this is where the rule is kept
 * and the only place it can be dropped. `outbox.test.ts` covers the queue itself and the
 * transaction the rows share with the write; this covers what each write queues.
 */
describe("§4.12 what a local write queues", () => {
  /**
   * Sorted by kind, not by `createdAt`: two rows written by one transaction share a
   * millisecond, and §5.7 has no sequence field to break the tie with, so their relative
   * order is not defined and nothing in §4.12 depends on it (`outbox.ts`).
   */
  async function queued() {
    return (await db.outbox.toArray())
      .sort((a, b) => a.kind.localeCompare(b.kind))
      .map((row) => ({ kind: row.kind, vin: row.vin, payload: row.payload }));
  }

  it("queues the scan event and the vehicle's own fields on a scan", async () => {
    const record = await upsertVehicle(scan({ at: T1, deviceLabel: "Bay 3" }));
    const event = (await db.scanEvents.toArray())[0]!;

    expect(await queued()).toEqual([
      {
        kind: "scan_event",
        vin: VIN,
        payload: {
          id: event.id,
          vin: VIN,
          at: T1,
          symbology: "code_39",
          check_digit_valid: true,
          device_label: "Bay 3",
          origin: "scan",
        },
      },
      {
        kind: "vehicle_meta",
        vin: VIN,
        payload: {
          p_vin: VIN,
          p_unit: null,
          p_notes: null,
          p_meta_updated_at: META_NEVER_EDITED,
          p_structural: record.structural,
          p_decode: record.decode,
        },
      },
    ]);
  });

  it("names the origin the write carried, which §5.2's row does not hold", async () => {
    await upsertVehicle(scan({ origin: "manual", symbology: "manual" }));
    await upsertVehicle(scan({ origin: "import", symbology: "import", vin: OTHER_VIN }));

    const origins = (await db.outbox.where("kind").equals("scan_event").toArray()).map(
      (row) => row.payload.origin,
    );
    expect(origins.sort()).toEqual(["import", "manual"]);
  });

  it("queues the record as saved on a unit edit, not the patch", async () => {
    await upsertVehicle(scan({ at: T1, notes: "spare key" }));
    await db.outbox.clear();

    const record = await setVehicleMeta(VIN, { unit: "TRK-118" });

    // The patch says nothing about the notes, and §4.12 resolves the whole row by one
    // clock: a payload built from the patch would push the edit with the other field
    // blank and last-writer-wins would erase it on every device.
    expect(await queued()).toEqual([
      {
        kind: "vehicle_meta",
        vin: VIN,
        payload: {
          p_vin: VIN,
          p_unit: "TRK-118",
          p_notes: "spare key",
          p_meta_updated_at: record.metaUpdatedAt,
          p_structural: record.structural,
          p_decode: record.decode,
        },
      },
    ]);
  });

  it("queues nothing when the edit is rejected", async () => {
    await expect(setVehicleMeta(VIN, { unit: "TRK-118" })).rejects.toThrow(VIN);
    expect(await db.outbox.count()).toBe(0);
  });
});

describe("§4.12 delete — a tombstone here, a delete_vehicle there", () => {
  it("stamps deletedAt, keeps the log, and queues the delete", async () => {
    await upsertVehicle(scan({ at: T1 }));
    await db.outbox.clear();

    const record = await softDeleteVehicle(VIN);

    expect(record?.deletedAt).toMatch(ISO_WITH_OFFSET);
    expect((await db.vehicles.get(VIN))?.deletedAt).toBe(record?.deletedAt);
    // §5.2 is append-only: the scans that produced the row are still what happened.
    expect(await db.scanEvents.count()).toBe(1);
    expect(await db.outbox.toArray()).toMatchObject([
      { kind: "vehicle_delete", vin: VIN, payload: { p_vin: VIN } },
    ]);
  });

  it("does not queue a second delete for a record already deleted", async () => {
    await upsertVehicle(scan({ at: T1 }));
    const first = await softDeleteVehicle(VIN);
    await db.outbox.clear();

    expect(await softDeleteVehicle(VIN)).toEqual(first);
    expect(await db.outbox.count()).toBe(0);
  });

  it("queues nothing for a VIN this device has never held", async () => {
    // Nothing to hide locally, and a delete pushed for a row this device never saw could
    // only act on another device's record.
    expect(await softDeleteVehicle(VIN)).toBeNull();
    expect(await db.outbox.count()).toBe(0);
    expect(await db.vehicles.count()).toBe(0);
  });

  it("lets a later scan revive the record, and queues the event that revives it", async () => {
    await upsertVehicle(scan({ at: T1 }));
    await softDeleteVehicle(VIN);
    await db.outbox.clear();

    const record = await upsertVehicle(scan({ at: T2 }));

    // §4.12: "any later scan event clears it" — the server does that from the event, so
    // the queued event is the whole of the fix; nothing pushes `deleted_at = null`.
    expect(record.deletedAt).toBeNull();
    expect((await db.outbox.toArray()).map((row) => row.kind).sort()).toEqual([
      "scan_event",
      "vehicle_meta",
    ]);
  });
});
