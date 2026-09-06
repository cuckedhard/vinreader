/**
 * [M4] §4.12's unpushed-`vehicle_meta` suppression, which `pull.ts` reads and no test
 * exercises. Measured, on this tree, by hand-applying the mutants the report names:
 *
 *   pull.ts  `if (row.kind === "vehicle_meta")` → `if (false)`      survives
 *   pull.ts  the fold's `entry.metaUpdatedAt === null || …` → true  survives
 *   pull.ts  `typeof at === "string" && …` → true                   survives
 *
 * All three erase the local unit and notes that a pull is supposed to leave alone:
 *
 *   §4.12: "a local vehicle that still has an unpushed `vehicle_meta` newer than the
 *   server's `meta_updated_at` keeps its local unit/notes until pushed."
 *
 * The state below is built directly rather than through `upsertVehicle`, and that is the
 * point of the guard rather than a shortcut around it: `upsert.ts` keeps the invariant that
 * a record's `metaUpdatedAt` is never older than a row queued for it, so under that
 * invariant the guard cannot fire — `merge.ts` says so in as many words. It is written
 * because §4.12 states it and because the invariant is one file's discipline, not a type.
 * A test that can only reach the guard through the one file that upholds the invariant is
 * a test of that file, not of this rule.
 *
 * What is at stake is a user-typed unit or note — §5.3 protects them from an import, and
 * this is the same value on the pull path.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../storage/db";
import { scanEventRow, vehicleMetaRow } from "../storage/outbox";
import { upsertVehicle } from "../storage/upsert";
import { applyPulled } from "./pull";
import type { OutboxRow } from "../vin/types";
import type { RemoteVehicle } from "./types";

const VIN = "1FUJGLDR49SAV1234";
const YEAR = 2026;

/** local record ← T1 · the server's row ← T2 · the queued edit ← T3. */
const T1 = "2026-09-04T06:00:00.000-06:00";
const T2 = "2026-09-04T07:00:00.000-06:00";
const T3 = "2026-09-04T08:00:00.000-06:00";

function remote(over: Partial<RemoteVehicle> = {}): RemoteVehicle {
  return {
    vin: VIN,
    unit: "SERVER-UNIT",
    notes: "server notes",
    metaUpdatedAt: T2,
    structural: null,
    decode: null,
    firstScannedAt: T1,
    lastScannedAt: T2,
    scanCount: 1,
    deletedAt: null,
    updatedAt: T2,
    ...over,
  };
}

/**
 * A local record holding what the user typed, stamped older than the row queued for it.
 * `queued` are the `p_meta_updated_at` values of the `vehicle_meta` rows still in the
 * outbox, in the order they were appended.
 */
async function seedLocal(queued: unknown[]): Promise<void> {
  const record = await upsertVehicle({
    vin: VIN,
    origin: "scan",
    symbology: "code_39",
    raw: VIN,
    checkDigitValid: true,
    at: T1,
    unit: "UNIT-42",
    notes: "left tank leaks",
  });
  await db.vehicles.put({ ...record, metaUpdatedAt: T1 });
  await db.outbox.clear();
  await db.outbox.bulkPut(
    queued.map((metaUpdatedAt, index) => {
      // Built through the real row builder so the payload shape is the one that is pushed,
      // then the one field this rule reads is set — including to values a string field
      // should never hold, which is the case the `typeof` test exists for.
      //
      // [G3] The id is overridden because `vehicleMetaRow` now keys a meta row by its VIN,
      // so a write path can no longer queue two of them for one vehicle. This fold still
      // has to handle several: a database written by a build before that change holds one
      // row per scan, and it is still there after the app updates. The state below is that
      // database, which is the state a real device upgrades from.
      const row = vehicleMetaRow(record);
      return {
        ...row,
        id: `legacy-${index}-${row.id}`,
        payload: { ...row.payload, p_meta_updated_at: metaUpdatedAt },
      };
    }),
  );
}

beforeEach(async () => {
  await db.open();
  await Promise.all(db.tables.map((table) => table.clear()));
});

describe("[M4] §4.12: a pull does not erase an edit still sitting in the outbox", () => {
  it("keeps the local unit and notes while a newer vehicle_meta is unpushed", async () => {
    await seedLocal([T3]);

    await applyPulled({ vehicles: [remote()] }, YEAR);

    const row = (await db.vehicles.get(VIN))!;
    expect(row.unit).toBe("UNIT-42");
    expect(row.notes).toBe("left tank leaks");
    // The clock still takes the greatest of the two, because §4.12's own SQL says
    // `meta_updated_at = greatest(vehicles.meta_updated_at, excluded.meta_updated_at)`
    // and this guard is an exception about the *values*, not about the clock. The queued
    // row carries T3 of its own, so the push that follows still wins on the server.
    expect(row.metaUpdatedAt).toBe(T2);
  });

  it("takes the server's unit when nothing is queued, so the guard is what did it", async () => {
    // The control. Without this, the case above would pass under an implementation that
    // never applied a pulled unit at all.
    await seedLocal([]);

    await applyPulled({ vehicles: [remote()] }, YEAR);

    const row = (await db.vehicles.get(VIN))!;
    expect(row.unit).toBe("SERVER-UNIT");
    expect(row.notes).toBe("server notes");
    expect(row.metaUpdatedAt).toBe(T2);
  });

  it("folds the queued rows to the newest, not to the last one appended", async () => {
    // Two edits are queued and neither has been pushed — the ordinary shape, since every
    // write appends a row. The second is older than the first (a device whose clock stepped
    // back, or two writes racing), and it is exactly as old as the server's row. A fold
    // that keeps the last row it saw rather than the newest would let the server win the
    // tie and take the user's text with it.
    await seedLocal([T3, T2]);

    await applyPulled({ vehicles: [remote()] }, YEAR);

    expect((await db.vehicles.get(VIN))!.unit).toBe("UNIT-42");
  });

  it("still lets the server win when every queued row is older than its stamp", async () => {
    // The other side of the same comparison: a queued edit older than the server's means
    // another device edited afterwards, and §4.12's LWW gives it the field.
    await seedLocal([T1]);

    await applyPulled({ vehicles: [remote()] }, YEAR);

    expect((await db.vehicles.get(VIN))!.unit).toBe("SERVER-UNIT");
  });

  it("is not disabled for the whole VIN by one unreadable queued row", async () => {
    // §4.12 never drops an outbox row, so a row written by an older build or half-written
    // by a crash stays in the queue for ever. Reading its stamp as if it were a timestamp
    // would fix `entry.metaUpdatedAt` at something no later row can beat — and then every
    // pull erases the edit sitting behind it. The unreadable row is simply not a stamp.
    await seedLocal([{ broken: true }, T3]);

    await applyPulled({ vehicles: [remote()] }, YEAR);

    expect((await db.vehicles.get(VIN))!.unit).toBe("UNIT-42");
  });
});

/**
 * [M4] The other half of the same fold, and the half nothing was reaching: the queued
 * **scan**. `pull.ts` builds `pending.scanAt` from the outbox exactly as it builds
 * `pending.metaUpdatedAt`, and `merge.ts` reads it for §4.12's tombstone rule — "any later
 * scan event clears it — including an event still in the outbox, because that event will
 * clear the tombstone server-side the moment it is pushed".
 *
 * `bun run mutate` reported the whole `if (row.kind === "scan_event")` block as NoCoverage
 * or Survived: with the fold emptied, or fixed at the first row it sees, or reading a
 * non-string as a stamp, no test failed. What each of those costs is one truck: the user
 * deleted it, scanned it again at the gate, and the next pull — before the queue drains —
 * puts the tombstone back on the record they are looking at.
 */
describe("[M4] §4.12: a scan still in the outbox clears the tombstone a pull carries", () => {
  /** A §5.2 event as the scan path writes it, queued the way `upsert.ts` queues it. */
  function queuedScan(id: string, at: unknown): OutboxRow {
    const row = scanEventRow(
      {
        id,
        vin: VIN,
        at: T1,
        symbology: "code_39",
        raw: VIN,
        checkDigitValid: true,
        deviceLabel: null,
      },
      "scan",
    );
    // The one field this fold reads, set after the fact so a value a string field should
    // never hold can be put there — the case the `typeof` test in the fold exists for.
    return { ...row, payload: { ...row.payload, at } };
  }

  /**
   * `db.outbox.toArray()` reads in primary-key order, so the ids below are what fixes the
   * order the fold sees these rows in — which is the whole subject here. They are named so
   * that the intended reading order is the sorted order.
   */
  async function seedQueued(rows: OutboxRow[]): Promise<void> {
    const record = await upsertVehicle({
      vin: VIN,
      origin: "scan",
      symbology: "code_39",
      raw: VIN,
      checkDigitValid: true,
      at: T1,
    });
    await db.vehicles.put({ ...record, metaUpdatedAt: T1 });
    await db.outbox.clear();
    await db.outbox.bulkPut(rows);
  }

  it("folds the queued scans to the newest, not to the first one appended", async () => {
    // Two scans are queued and neither has been pushed. The older was appended first, so a
    // fold that keeps whichever row it saw first — or that never compares at all — reads
    // the queue as older than the server's tombstone and leaves the truck deleted.
    await seedQueued([queuedScan("scan-1-old", T1), queuedScan("scan-2-new", T3)]);

    await applyPulled({ vehicles: [remote({ deletedAt: T2 })] }, YEAR);

    expect((await db.vehicles.get(VIN))!.deletedAt).toBeNull();
  });

  it("leaves the tombstone standing when every queued scan is older than it", async () => {
    // The control, and §4.12's actual rule: only a *later* scan clears a delete. Without
    // this the case above would pass under a fold that resurrected everything.
    await seedQueued([queuedScan("scan-1-old", T1)]);

    await applyPulled({ vehicles: [remote({ deletedAt: T2 })] }, YEAR);

    expect((await db.vehicles.get(VIN))!.deletedAt).toBe(T2);
  });

  it("is not blinded for the whole VIN by one unreadable queued scan", async () => {
    // §4.12 never drops an outbox row, so a row written by an older build or half-written
    // by a crash stays in the queue for ever. Read as if it were a stamp it fixes
    // `entry.scanAt` at something no later row can beat — `Date.parse` of it is NaN and
    // every comparison against NaN is false — and the scan behind it stops counting.
    await seedQueued([queuedScan("scan-1-broken", { broken: true }), queuedScan("scan-2-new", T3)]);

    await applyPulled({ vehicles: [remote({ deletedAt: T2 })] }, YEAR);

    expect((await db.vehicles.get(VIN))!.deletedAt).toBeNull();
  });
});
