/**
 * §5.7 outbox — the queue itself, and the two properties the write path is built on.
 *
 * **Atomicity (§4.12).** A local write and its outbox row commit together or not at all.
 * The failure this rules out is silent: a vehicle saved with no queued row looks perfect
 * on the device that scanned it and never reaches the account, and nothing downstream can
 * detect the gap — the push engine can only push what it can see.
 *
 * **N7 / P1.** Nothing here reads a session, touches the network, or imports
 * `@supabase/supabase-js`. Signed out, a scan costs one more IndexedDB put than it did in
 * S3, and that put is the only way the append can fail — the same way `db.vehicles.put`
 * in the same transaction would fail — so atomicity costs a local write nothing it was
 * not already risking.
 */
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OutboxRow, ScanEvent, VehicleRecord } from "../vin/types";
import { db } from "./db";
import {
  OUTBOX_BATCH,
  appendOutbox,
  clearOutbox,
  deferOutboxRow,
  dueRows,
  pendingCount,
  removeOutboxRows,
  scanEventRow,
  vehicleDeleteRow,
  vehicleMetaRow,
} from "./outbox";
import { upsertVehicle, type UpsertInput } from "./upsert";

const VIN = "1HGCM82633A004352"; // §4.11 fixture: grammar ok, check digit valid.
const VIN_B = "1FUJGLDR49SAV1234";
const T1 = "2026-01-05T08:15:00.000-06:00";
const T2 = "2026-02-11T09:30:00.000-06:00";

function scan(overrides: Partial<UpsertInput> = {}): UpsertInput {
  return {
    vin: VIN,
    origin: "scan",
    symbology: "code_39",
    raw: `I${VIN}`,
    checkDigitValid: true,
    ...overrides,
  };
}

function event(overrides: Partial<ScanEvent> = {}): ScanEvent {
  return {
    id: "0189d3f0-0b6a-4f4e-9c2a-4d2f6a1b7c3e",
    vin: VIN,
    at: T1,
    symbology: "code_39",
    raw: `I${VIN}`,
    checkDigitValid: true,
    deviceLabel: "Bay 3",
    ...overrides,
  };
}

/**
 * Break one object store, the way `upsert.concurrency.test.ts` does. Deliberately a local
 * copy: a shared helper would put the two files' failure injection on one hinge, and this
 * one has to keep working while that one is edited.
 */
function breakStore(method: "add" | "put", store: string, message: string): () => void {
  const original = IDBObjectStore.prototype[method];
  IDBObjectStore.prototype[method] = function patched(
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore["put"]>
  ): IDBRequest<IDBValidKey> {
    if (this.name === store) throw new Error(message);
    return original.apply(this, args);
  };
  return () => {
    IDBObjectStore.prototype[method] = original;
  };
}

beforeEach(async () => {
  await db.open();
  await Promise.all(db.tables.map((table) => table.clear()));
});

describe("§4.12 payloads — an outbox row is the push call's argument, already built", () => {
  it("carries a scan_events row under the event's own id", () => {
    const row = scanEventRow(event(), "scan");

    // §4.12 makes `id` the primary key that makes a push idempotent, so the outbox row and
    // the §5.2 event share it: appending the same event twice cannot enqueue it twice.
    expect(row.id).toBe(event().id);
    expect(row).toMatchObject({ kind: "scan_event", vin: VIN, attempts: 0, nextAttemptAt: null });
    expect(row.payload).toEqual({
      id: event().id,
      vin: VIN,
      at: T1,
      symbology: "code_39",
      check_digit_valid: true,
      device_label: "Bay 3",
      origin: "scan",
    });
    // §4.12's table has no column for the raw scan, and N3 keeps it on the device.
    expect(row.payload).not.toHaveProperty("raw");
  });

  it("carries the upsert_vehicle_meta arguments, named as §4.12 names them", async () => {
    const record = await upsertVehicle(scan({ at: T1, unit: "TRK-118", notes: "spare key" }));
    const row = vehicleMetaRow(record);

    expect(row.kind).toBe("vehicle_meta");
    expect(row.payload).toEqual({
      p_vin: VIN,
      p_unit: "TRK-118",
      p_notes: "spare key",
      p_meta_updated_at: record.metaUpdatedAt,
      p_structural: record.structural,
      p_decode: record.decode,
    });
    // §4.12: `scan_count`, `first_scanned_at` and `last_scanned_at` are derived by trigger
    // and "clients never push them".
    for (const derived of ["scan_count", "first_scanned_at", "last_scanned_at", "scanCount"]) {
      expect(row.payload).not.toHaveProperty(derived);
    }
  });

  it("carries nothing but the VIN for a delete", () => {
    expect(vehicleDeleteRow(VIN)).toMatchObject({
      kind: "vehicle_delete",
      vin: VIN,
      payload: { p_vin: VIN },
    });
  });

  it("gives every row an id of its own, and a distinct one to each meta row", async () => {
    const record = await upsertVehicle(scan());
    const ids = new Set([vehicleMetaRow(record).id, vehicleMetaRow(record).id]);
    expect(ids.size).toBe(2);
  });
});

describe("§5.7 the queue", () => {
  it("appends rows and counts them for the sync chip", async () => {
    await appendOutbox([vehicleDeleteRow(VIN), vehicleDeleteRow(VIN_B)]);
    expect(await pendingCount()).toBe(2);
  });

  it("re-appending a row already queued replaces it instead of failing", async () => {
    // Why `bulkPut` and not `bulkAdd`: a repeated id is a row already queued, and a
    // `ConstraintError` there would abort the writer's transaction and lose the scan.
    const row = scanEventRow(event(), "scan");
    await appendOutbox([row]);
    await appendOutbox([row]);

    expect(await pendingCount()).toBe(1);
  });

  it("removes what the server accepted and leaves the rest", async () => {
    const [a, b] = [vehicleDeleteRow(VIN), vehicleDeleteRow(VIN_B)];
    await appendOutbox([a, b]);
    await removeOutboxRows([a.id]);

    expect((await db.outbox.toArray()).map((row) => row.vin)).toEqual([VIN_B]);
  });

  it("clears the queue without touching the records it describes", async () => {
    // §9-S4 sign-out, "keep this phone's records".
    await upsertVehicle(scan());
    await clearOutbox();

    expect(await pendingCount()).toBe(0);
    expect(await db.vehicles.count()).toBe(1);
    expect(await db.scanEvents.count()).toBe(1);
  });
});

describe("§4.12 backoff — attempts are persisted and rows are never dropped", () => {
  it("counts the attempt and holds the row until its next attempt is due", async () => {
    const row = vehicleDeleteRow(VIN);
    await appendOutbox([row]);
    await deferOutboxRow(row.id, { nextAttemptAt: T2, lastError: "503" });

    const stored = (await db.outbox.get(row.id))!;
    expect(stored).toMatchObject({ attempts: 1, nextAttemptAt: T2, lastError: "503" });
    expect(await dueRows({ now: T1 })).toEqual([]);
    expect(await dueRows({ now: T2 })).toHaveLength(1);

    await deferOutboxRow(row.id, { nextAttemptAt: T2, lastError: "503" });
    expect((await db.outbox.get(row.id))?.attempts).toBe(2);
  });

  it("counts from one again when a stored attempts field is not a count", async () => {
    const row = vehicleDeleteRow(VIN);
    await appendOutbox([{ ...row, attempts: "3" } as unknown as OutboxRow]);
    await deferOutboxRow(row.id, { nextAttemptAt: null, lastError: null });

    // The same guard §5.1's `scanCount` gets: `"3" + 1` is `"31"`, which then grows on
    // every failure and eventually outranks any cap the push engine applies.
    expect((await db.outbox.get(row.id))?.attempts).toBe(1);
  });

  it("does not recreate a row that was pushed and removed under it", async () => {
    await deferOutboxRow("never-queued", { nextAttemptAt: T2, lastError: "503" });
    expect(await pendingCount()).toBe(0);
  });

  it("treats a nextAttemptAt that does not parse as due rather than stranding the row", async () => {
    const row = { ...vehicleDeleteRow(VIN), nextAttemptAt: "soon" };
    await appendOutbox([row]);

    expect(await dueRows({ now: T1 })).toHaveLength(1);
  });
});

describe("§4.12 push order", () => {
  it("returns due rows oldest first, one kind at a time, capped at the batch size", async () => {
    const rows = [
      { ...vehicleDeleteRow(VIN), createdAt: T2 },
      { ...vehicleDeleteRow(VIN_B), createdAt: T1 },
      { ...vehicleMetaRow({ vin: VIN } as VehicleRecord), createdAt: T1 },
    ];
    await appendOutbox(rows);

    expect((await dueRows({ now: T2 })).map((row) => row.createdAt)).toEqual([T1, T1, T2]);
    expect(await dueRows({ kind: "vehicle_delete", now: T2 })).toHaveLength(2);
    expect(await dueRows({ kind: "vehicle_meta", now: T2 })).toHaveLength(1);
    expect(await dueRows({ now: T2, limit: 1 })).toHaveLength(1);
  });

  it("orders by instant, not by the text of the timestamp", async () => {
    // §5.1's stamps carry an offset, and offsets do not sort as strings: a device that
    // crosses a time zone between two scans queues them in an order the index disagrees
    // with. `+12:45` here is the *earlier* instant despite sorting last as text.
    const chatham = "2026-01-05T06:15:00.000+12:45";
    const chicago = "2026-01-04T12:30:00.000-06:00";
    expect(Date.parse(chatham)).toBeLessThan(Date.parse(chicago));

    await appendOutbox([
      { ...vehicleDeleteRow(VIN), createdAt: chicago },
      { ...vehicleDeleteRow(VIN_B), createdAt: chatham },
    ]);

    expect((await dueRows({ now: T2 })).map((row) => row.vin)).toEqual([VIN_B, VIN]);
  });

  it("keeps a row whose createdAt does not parse rather than hiding it", async () => {
    // §4.12: rows are "never dropped". A comparator that returned NaN would order the
    // batch by chance, and a row filtered out for a bad timestamp would sit in the queue
    // for ever while the chip counted it.
    await appendOutbox([
      { ...vehicleDeleteRow(VIN), createdAt: "whenever" },
      { ...vehicleDeleteRow(VIN_B), createdAt: "later" },
      { ...vehicleDeleteRow("1HTMMAAL67H412345"), createdAt: T1 },
    ]);

    expect(await dueRows({ now: T2 })).toHaveLength(3);
  });

  it("judges due against now when it is not told an instant", async () => {
    // What the push engine calls: no arguments at all, everything queued and never
    // deferred, capped at the batch.
    await upsertVehicle(scan());

    expect((await dueRows()).map((row) => row.kind).sort()).toEqual(["scan_event", "vehicle_meta"]);
  });

  it("defaults to §4.12's batch of 50", async () => {
    const many = Array.from({ length: OUTBOX_BATCH + 5 }, (_, index) => ({
      ...vehicleDeleteRow(`${index}`),
      createdAt: T1,
    }));
    await appendOutbox(many);

    expect(await dueRows({ now: T2 })).toHaveLength(OUTBOX_BATCH);
    expect(OUTBOX_BATCH).toBe(50);
  });
});

describe("§4.12 the write and its outbox row commit together", () => {
  it("rolls the whole scan back when the outbox row cannot be written", async () => {
    // The single most important property of this layer, and the reason the append shares
    // the writer's transaction. It cuts against N7 read narrowly — a broken outbox stops a
    // scan being saved — and that is the deliberate trade: a scan that saves without its
    // row never syncs and never says so, while this one fails loudly (P7) to a user who is
    // standing at the truck and can scan again. The store is the only thing that can fail
    // here: no session is read and no request is made.
    const repair = breakStore("put", "outbox", "QuotaExceededError");
    try {
      await expect(upsertVehicle(scan({ at: T1 }))).rejects.toThrow(/QuotaExceededError/);
    } finally {
      repair();
    }

    expect(await db.vehicles.count()).toBe(0);
    expect(await db.scanEvents.count()).toBe(0);
    expect(await pendingCount()).toBe(0);
  });

  it("queues nothing when the vehicle row cannot be written", async () => {
    const repair = breakStore("put", "vehicles", "QuotaExceededError");
    try {
      await expect(upsertVehicle(scan())).rejects.toThrow(/QuotaExceededError/);
    } finally {
      repair();
    }

    expect(await pendingCount()).toBe(0);
  });

  it("leaves the record and the queue exactly as they were when a re-scan fails", async () => {
    const first = await upsertVehicle(scan({ at: T1 }));
    const queued = await db.outbox.orderBy("createdAt").toArray();

    const repair = breakStore("put", "outbox", "QuotaExceededError");
    try {
      await expect(upsertVehicle(scan({ at: T2 }))).rejects.toThrow();
    } finally {
      repair();
    }

    // Not merely "nothing new": the failed scan must not have moved lastScannedAt or
    // scanCount either, and must not have replaced the meta row already waiting to go.
    expect(await db.vehicles.get(VIN)).toEqual(first);
    expect(await db.outbox.orderBy("createdAt").toArray()).toEqual(queued);
  });
});

describe("N7 / P1 — the queue fills with no account and no network", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves the scan and queues it without a single request", async () => {
    // Signed out is the only state this layer knows: there is no session to read, and a
    // `fetch` that would throw if called proves the write path never reaches for one.
    const fetched = vi.fn(() => {
      throw new Error("N1: a scan never blocks on the network");
    });
    vi.stubGlobal("fetch", fetched);

    await upsertVehicle(scan({ at: T1 }));

    expect(fetched).not.toHaveBeenCalled();
    expect(await db.vehicles.count()).toBe(1);
    expect(await pendingCount()).toBe(2);
  });

  it("keeps queuing while a backlog no one is draining piles up", async () => {
    // "Add the 14 records on this phone to your account?" (§6.4) only has 14 records to
    // offer because the queue filled while nobody was signed in. Nothing throttles it.
    for (let i = 0; i < 14; i += 1) await upsertVehicle(scan({ vin: VIN_B, at: T1 }));

    // Two rows per write, as §4.12 asks for: fourteen events, and fourteen meta rows that
    // each carry the record as it stood. The queue is not coalesced — the merge rules are
    // last-writer-wins, so a superseded meta row is harmless, and collapsing them would be
    // merge behaviour on the write path.
    expect(await pendingCount()).toBe(28);
    expect(await db.vehicles.count()).toBe(1);
  });
});

describe("§5 an existing database, opened by this build", () => {
  it("keeps the records an earlier run wrote and starts feeding the queue from the next write", async () => {
    // The upgrade case, stated as the device actually meets it: a database created by an
    // installed S0–S3 build — records, no outbox rows — reopened by this one. `db.ts` has
    // declared all six stores since the first S0 commit, so this build adds no version and
    // no migration; if a later slice needs one, this test is where it proves the records
    // survive it.
    const before = await upsertVehicle(scan({ at: T1, unit: "TRK-118" }));
    const events = await db.scanEvents.toArray();
    const stores = db.tables.map((table) => table.name).sort();

    db.close();
    await Dexie.delete("vinrelay");

    const earlier = new Dexie("vinrelay");
    earlier.version(1).stores({
      vehicles: "vin, lastScannedAt, unit, decode.status, deletedAt",
      scanEvents: "id, vin, at",
      wmi: "wmi",
      settings: "id",
      outbox: "id, createdAt, kind",
      syncState: "id",
    });
    await earlier.open();
    await earlier.table<VehicleRecord>("vehicles").put(before);
    await earlier.table<ScanEvent>("scanEvents").bulkPut(events);
    earlier.close();

    await db.open();

    expect(await db.vehicles.get(VIN)).toEqual(before);
    expect(await db.scanEvents.toArray()).toEqual(events);
    expect(db.tables.map((table) => table.name).sort()).toEqual(stores);
    expect(db.verno).toBe(1);
    expect(await pendingCount()).toBe(0);

    // And the S4 tables are usable on the spot — no first-run step, no backfill needed
    // for the writes that come after the upgrade.
    await upsertVehicle(scan({ at: T2 }));
    expect((await dueRows({ now: T2 })).map((row) => row.kind).sort()).toEqual([
      "scan_event",
      "vehicle_meta",
    ]);
  });
});
