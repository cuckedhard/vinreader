/**
 * §13.2 adversary, round 3 of `harden S1`. The scan path's write, attacked under
 * interleaving rather than under a repeated tap.
 *
 * Everything here is deterministic: no `Math.random`, no wall-clock assertion, no timer.
 * The only clock reads are the ones `upsertVehicle` makes for itself, and every test that
 * cares about ordering supplies its own `at`.
 *
 * Findings proved here:
 *   [R3-B] a scan cannot be saved at all in an insecure context — FAILS today
 *   [R3-E] `scanCount++` on a stored non-number concatenates — FAILS today
 * Invariants proved here (all pass; they are regression guards, not findings):
 *   [R3-P1] §5.3 / P4 — one row per VIN however the writers interleave
 *   [R3-P2] §5.2 / §5.3 — the log and the aggregate land together or not at all
 *   [R3-P3] §4.12 / §5.1 — a clock that jumps backwards mid-session
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "./db";
import { clearAllData, getSettings, updateSettings } from "./settings";
import { upsertVehicle, type UpsertInput } from "./upsert";
import { applyDecodeResult } from "./decodeQueue";
import type { VpicResult } from "../vpic/types";

/** §4.11 fixtures, all check-digit valid. */
const VIN_A = "1HGCM82633A004352";
const VIN_B = "1FUJGLDR49SAV1234";
const VIN_C = "1HTMMAAL67H412345";
const VIN_D = "4V4NC9TJ98N412345";

const T_EARLY = "2026-01-05T08:15:00.000-06:00";
const T_MID = "2026-02-11T09:30:00.000-06:00";
const T_LATE = "2026-03-20T14:45:00.000-06:00";

function scan(vin: string, overrides: Partial<UpsertInput> = {}): UpsertInput {
  return {
    vin,
    origin: "scan",
    symbology: "code_39",
    raw: `I${vin}`,
    checkDigitValid: true,
    ...overrides,
  };
}

const OK_DECODE: VpicResult = {
  status: "ok",
  fields: { Make: "HONDA", Model: "Accord", ModelYear: "2003" },
  errorText: null,
  lastError: null,
};

beforeEach(async () => {
  await db.open();
  await Promise.all(db.tables.map((table) => table.clear()));
});

describe("[R3-P1] §5.3 keeps one row per VIN under interleaved writers", () => {
  it("writes one row and two events when two reads of one VIN land together", async () => {
    await Promise.all([upsertVehicle(scan(VIN_A)), upsertVehicle(scan(VIN_A))]);

    const rows = await db.vehicles.toArray();
    const events = await db.scanEvents.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scanCount).toBe(2);
    // §5.2 is append-only: two physical reads are two events, and one vehicle (P4).
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.id)).size).toBe(2);
  });

  it("counts every one of ten simultaneous reads of the same VIN exactly once", async () => {
    await Promise.all(Array.from({ length: 10 }, () => upsertVehicle(scan(VIN_A))));

    expect(await db.vehicles.count()).toBe(1);
    expect((await db.vehicles.get(VIN_A))!.scanCount).toBe(10);
    expect(await db.scanEvents.count()).toBe(10);
  });

  it("keeps four VINs apart when twenty writers interleave across them", async () => {
    const vins = [VIN_A, VIN_B, VIN_C, VIN_D];
    await Promise.all(
      Array.from({ length: 20 }, (_unused, index) => upsertVehicle(scan(vins[index % 4]!))),
    );

    const rows = await db.vehicles.toArray();
    const events = await db.scanEvents.toArray();
    expect(rows.map((row) => row.vin).sort()).toEqual([...vins].sort());
    // The aggregate and the log agree per VIN — the invariant §5.3 exists to hold.
    for (const row of rows) {
      expect(row.scanCount).toBe(5);
      expect(events.filter((event) => event.vin === row.vin)).toHaveLength(5);
    }
    expect(new Set(events.map((event) => event.id)).size).toBe(20);
  });

  it("does not lose a decode that lands in the middle of a scan write, either order", async () => {
    await upsertVehicle(scan(VIN_A));
    await Promise.all([applyDecodeResult(VIN_A, OK_DECODE), upsertVehicle(scan(VIN_A))]);

    const forward = (await db.vehicles.get(VIN_A))!;
    expect(forward.scanCount).toBe(2);
    expect(forward.decode.status).toBe("ok");
    expect(forward.decode.fields.Make).toBe("HONDA");

    await upsertVehicle(scan(VIN_B));
    await Promise.all([upsertVehicle(scan(VIN_B)), applyDecodeResult(VIN_B, OK_DECODE)]);

    const reverse = (await db.vehicles.get(VIN_B))!;
    expect(reverse.scanCount).toBe(2);
    expect(reverse.decode.status).toBe("ok");
    expect(reverse.decode.fields.Make).toBe("HONDA");
  });

  it("lets a settings write and a scan write cross without either being lost", async () => {
    await Promise.all([upsertVehicle(scan(VIN_A)), updateSettings({ deviceLabel: "Truck 7" })]);

    expect((await getSettings()).deviceLabel).toBe("Truck 7");
    expect(await db.vehicles.count()).toBe(1);
    expect(await db.scanEvents.count()).toBe(1);
  });

  it("leaves no orphan when Clear all data crosses a scan write", async () => {
    await Promise.all([upsertVehicle(scan(VIN_A)), clearAllData()]);

    // Either order is a legitimate outcome; a vehicle without its event, or an event
    // without its vehicle, is not (§5.2, §5.3).
    const rows = await db.vehicles.toArray();
    const events = await db.scanEvents.toArray();
    expect(events.map((event) => event.vin)).toEqual(rows.map((row) => row.vin));
  });
});

/**
 * Fault injection at the IndexedDB boundary rather than at Dexie's, so the failure
 * travels the path a real `QuotaExceededError` travels. `store` is the object store the
 * fault applies to; every other store keeps working.
 */
function breakStore(method: "add" | "put", store: string, message: string): () => void {
  const original = IDBObjectStore.prototype[method];
  IDBObjectStore.prototype[method] = function patched(
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore["add"]>
  ): IDBRequest<IDBValidKey> {
    if (this.name === store) throw new Error(message);
    return original.apply(this, args);
  };
  return () => {
    IDBObjectStore.prototype[method] = original;
  };
}

describe("[R3-P2] §5.3's transaction keeps the log and the aggregate together", () => {
  it("rolls the vehicle back when the scan event cannot be appended", async () => {
    await upsertVehicle(scan(VIN_A));

    // §5.2 is append-only, so a half-written scan is the one shape it must never hold:
    // an aggregate that counts a read the log has no row for.
    const repair = breakStore("add", "scanEvents", "ConstraintError: key exists");
    try {
      await expect(upsertVehicle(scan(VIN_B))).rejects.toThrow(/ConstraintError/);
    } finally {
      repair();
    }

    expect(await db.vehicles.get(VIN_B)).toBeUndefined();
    expect(await db.vehicles.count()).toBe(1);
    expect(await db.scanEvents.count()).toBe(1);
  });

  it("appends no event when the vehicle row cannot be written", async () => {
    const repair = breakStore("put", "vehicles", "QuotaExceededError");
    try {
      await expect(upsertVehicle(scan(VIN_A))).rejects.toThrow(/QuotaExceededError/);
    } finally {
      repair();
    }

    expect(await db.vehicles.count()).toBe(0);
    expect(await db.scanEvents.count()).toBe(0);
  });

  it("leaves the earlier record exactly as it was when a re-scan fails", async () => {
    const first = await upsertVehicle(scan(VIN_A, { at: T_MID }));

    const repair = breakStore("add", "scanEvents", "QuotaExceededError");
    try {
      await expect(upsertVehicle(scan(VIN_A, { at: T_LATE }))).rejects.toThrow();
    } finally {
      repair();
    }

    // Not merely "no new row": the scan that failed must not have moved lastScannedAt or
    // scanCount either, or the sheet reports a read that was never stored.
    expect(await db.vehicles.get(VIN_A)).toEqual(first);
    expect(await db.scanEvents.count()).toBe(1);
  });
});

describe("[R3-P3] §4.12 aggregates survive a clock that moves backwards", () => {
  it("keeps first as the minimum and last as the maximum across a backwards jump", async () => {
    await upsertVehicle(scan(VIN_A, { at: T_MID }));
    // The phone corrects its clock backwards between two reads of the same truck.
    const record = await upsertVehicle(scan(VIN_A, { at: T_EARLY }));

    expect(record.firstScannedAt).toBe(T_EARLY);
    expect(record.lastScannedAt).toBe(T_MID);
    expect(record.scanCount).toBe(2);
    // §5.2 is append-only and stamps what the clock said, skew and all.
    expect((await db.scanEvents.toArray()).map((event) => event.at).sort()).toEqual(
      [T_EARLY, T_MID].sort(),
    );
  });

  it("takes an older `at` from an import without moving lastScannedAt back", async () => {
    await upsertVehicle(scan(VIN_A, { at: T_LATE }));
    const record = await upsertVehicle(
      scan(VIN_A, { origin: "import", symbology: "import", at: T_EARLY }),
    );

    expect(record.firstScannedAt).toBe(T_EARLY);
    expect(record.lastScannedAt).toBe(T_LATE);
    // §5.1: a re-scan does not rewrite provenance.
    expect(record.origin).toBe("scan");
  });

  it("heals a stored timestamp that no longer parses instead of propagating it", async () => {
    await upsertVehicle(scan(VIN_A, { at: T_MID }));
    const stored = (await db.vehicles.get(VIN_A))!;
    await db.vehicles.put({ ...stored, firstScannedAt: "yesterday", lastScannedAt: "yesterday" });

    const record = await upsertVehicle(scan(VIN_A, { at: T_LATE }));
    expect(Number.isNaN(Date.parse(record.firstScannedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(record.lastScannedAt))).toBe(false);
    expect(record.lastScannedAt).toBe(T_LATE);
  });
});

describe("[R3-E] §5.3 `scanCount++` trusts the type of what it read", () => {
  it("counts in numbers even when the stored row carries something else", async () => {
    await upsertVehicle(scan(VIN_A));
    const stored = (await db.vehicles.get(VIN_A))!;
    // The shape §4.12's sync and a half-written row can both deliver: the field is
    // present and wrong. `normalizeVehicle` guards the read path; the write path does not.
    await db.vehicles.put({ ...stored, scanCount: "3" as unknown as number });

    const record = await upsertVehicle(scan(VIN_A));

    // FAILS today: `("3") + 1` is the string "31", which is then stored and grows on
    // every later scan ("311", "3111"), and rides out to §S3's export.
    expect(typeof record.scanCount).toBe("number");
    expect(record.scanCount).toBeGreaterThanOrEqual(1);
  });
});

describe("[R3-B] §5.2 ids come from a secure-context-only API", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");

  beforeEach(() => {
    // Exactly what a browser presents over plain http: `crypto` is there, `randomUUID`
    // is not — it is [SecureContext]. §6.3 routes an insecure context to
    // `error(insecure_context)`, whose §6.4 line sends the user to the keyboard, and
    // the keyboard writes through this same path.
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    if (descriptor) Object.defineProperty(globalThis.crypto, "randomUUID", descriptor);
  });

  it("still stores the scan when randomUUID is unavailable", async () => {
    // FAILS today: `crypto.randomUUID()` throws `TypeError: crypto.randomUUID is not a
    // function` inside the transaction, so nothing is written and the screen shows
    // "Couldn't save this VIN" over the raw TypeError — on the one screen §6.4 points
    // the user to when the camera cannot be used at all.
    await expect(upsertVehicle(scan(VIN_A))).resolves.toMatchObject({ vin: VIN_A });

    const events = await db.scanEvents.toArray();
    expect(events).toHaveLength(1);
    expect(typeof events[0]!.id).toBe("string");
    expect(events[0]!.id.length).toBeGreaterThan(0);
  });

  it("gives every event a distinct id without randomUUID", async () => {
    await upsertVehicle(scan(VIN_A));
    await upsertVehicle(scan(VIN_A));

    const events = await db.scanEvents.toArray();
    expect(new Set(events.map((event) => event.id)).size).toBe(2);
  });
});
