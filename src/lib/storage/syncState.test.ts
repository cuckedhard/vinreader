/**
 * §5.8 syncState — the single "cursor" row.
 *
 * What is at stake is one asymmetry. A cursor that lags re-pulls rows the §4.12 merge
 * rules are idempotent about, so it costs bandwidth and nothing else. A cursor that runs
 * ahead skips rows this device has never seen and will never ask for again — a vehicle
 * edited on the laptop that simply never appears on the phone, with no error anywhere.
 * Every rule below exists to make the second failure unreachable.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { SyncStateRecord } from "../vin/types";
import { db } from "./db";
import {
  DEFAULT_SYNC_STATE,
  advanceCursors,
  getSyncState,
  normalizeSyncState,
  resetSyncState,
  updateSyncState,
} from "./syncState";

/** Server clocks, as §4.12 sends them: `vehicles.updated_at`, `scan_events.inserted_at`. */
const EARLY = "2026-01-05T14:15:00.000Z";
const LATE = "2026-02-11T09:30:00.000Z";

beforeEach(async () => {
  await db.open();
  await Promise.all(db.tables.map((table) => table.clear()));
});

describe("§5.8 the row", () => {
  it("creates itself on first read, with nothing pulled yet", async () => {
    expect(await getSyncState()).toEqual(DEFAULT_SYNC_STATE);
    expect(await db.syncState.count()).toBe(1);
  });

  it("stays a single row however often it is read or written", async () => {
    await getSyncState();
    await updateSyncState({ lastPullAt: EARLY });
    await updateSyncState({ lastPushAt: LATE });

    expect(await db.syncState.count()).toBe(1);
    expect(await getSyncState()).toMatchObject({
      id: "cursor",
      lastPullAt: EARLY,
      lastPushAt: LATE,
    });
  });

  it("keeps the fields a patch does not name", async () => {
    await updateSyncState({ vehiclesCursor: EARLY, lastError: "network" });
    const state = await updateSyncState({ lastError: null });

    expect(state.vehiclesCursor).toBe(EARLY);
    expect(state.lastError).toBeNull();
  });

  it("goes back to defaults on reset, because a cursor belongs to one account", async () => {
    // §9-S4: signing out — or signing in as someone else — must not leave the next
    // account's first pull starting partway through another account's history.
    await updateSyncState({ vehiclesCursor: LATE, eventsCursor: LATE, lastError: "network" });

    expect(await resetSyncState()).toEqual(DEFAULT_SYNC_STATE);
    expect(await getSyncState()).toEqual(DEFAULT_SYNC_STATE);
  });
});

describe("§5.8 a row an older build left behind", () => {
  it("fills in fields it never had", () => {
    expect(normalizeSyncState({ id: "cursor", vehiclesCursor: EARLY })).toEqual({
      ...DEFAULT_SYNC_STATE,
      vehiclesCursor: EARLY,
    });
    expect(normalizeSyncState(undefined)).toEqual(DEFAULT_SYNC_STATE);
  });

  it("drops a cursor that is not a timestamp instead of sending it to the server", () => {
    const junk = { vehiclesCursor: 0, eventsCursor: "soon", lastPullAt: {}, lastError: 7 };
    expect(normalizeSyncState(junk as unknown as Partial<SyncStateRecord>)).toEqual(
      DEFAULT_SYNC_STATE,
    );
  });

  it("heals the stored row on the next write rather than carrying the junk forward", async () => {
    await db.syncState.put({ id: "cursor", eventsCursor: "soon" } as unknown as SyncStateRecord);

    expect((await getSyncState()).eventsCursor).toBeNull();
    await updateSyncState({ lastPullAt: LATE });
    expect((await db.syncState.get("cursor"))?.eventsCursor).toBeNull();
  });
});

describe("§4.12 the cursor only moves forward", () => {
  it("takes the newer timestamp received", async () => {
    await advanceCursors({ vehiclesCursor: EARLY });
    const state = await advanceCursors({ vehiclesCursor: LATE });

    expect(state.vehiclesCursor).toBe(LATE);
  });

  it("refuses to move back to an older one", async () => {
    // A page of pulled rows is not sorted by the caller, so `advanceCursors` is handed
    // every row's timestamp; the max is the cursor (§4.12) and every other call must be
    // a no-op. Moving back would be safe; moving *forward* on a later smaller value is
    // not, and one guard covers both.
    await advanceCursors({ vehiclesCursor: LATE });
    expect((await advanceCursors({ vehiclesCursor: EARLY })).vehiclesCursor).toBe(LATE);
  });

  it("moves the two cursors independently", async () => {
    const state = await advanceCursors({ eventsCursor: EARLY });

    expect(state).toMatchObject({ vehiclesCursor: null, eventsCursor: EARLY });
    expect((await advanceCursors({ vehiclesCursor: LATE })).eventsCursor).toBe(EARLY);
  });

  it("ignores a timestamp that does not parse", async () => {
    await advanceCursors({ vehiclesCursor: EARLY });
    const state = await advanceCursors({ vehiclesCursor: "soon" });

    // Taking it would end the pull for good: the next request filters on a value the
    // server cannot compare, and every attempt after it fails the same way.
    expect(state.vehiclesCursor).toBe(EARLY);
  });

  it("replaces a stored cursor that no longer parses", async () => {
    await db.syncState.put({
      ...DEFAULT_SYNC_STATE,
      vehiclesCursor: "soon",
    } as unknown as SyncStateRecord);

    expect((await advanceCursors({ vehiclesCursor: EARLY })).vehiclesCursor).toBe(EARLY);
  });

  it("compares by instant, not by the text of the timestamp", async () => {
    // Both timestamps below name the same day, and the *earlier* instant sorts last as
    // text. §5.1 says the same thing about the device clock; the server's is no different
    // once an offset is in play.
    const zulu = "2026-01-05T14:15:00.000Z";
    const behind = "2026-01-05T09:15:00.000-06:00"; // 15:15 UTC — later, sorts first
    expect(Date.parse(behind)).toBeGreaterThan(Date.parse(zulu));

    await advanceCursors({ vehiclesCursor: behind });
    expect((await advanceCursors({ vehiclesCursor: zulu })).vehiclesCursor).toBe(behind);
  });
});
