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
import { vehicleMetaRow } from "../storage/outbox";
import { upsertVehicle } from "../storage/upsert";
import { applyPulled } from "./pull";
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
    queued.map((metaUpdatedAt) => {
      // Built through the real row builder so the payload shape is the one that is pushed,
      // then the one field this rule reads is set — including to values a string field
      // should never hold, which is the case the `typeof` test exists for.
      const row = vehicleMetaRow(record);
      return { ...row, payload: { ...row.payload, p_meta_updated_at: metaUpdatedAt } };
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
