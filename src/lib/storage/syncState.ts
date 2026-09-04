/**
 * §5.8 syncState — one row, id "cursor", holding where the pull got to and what the last
 * push and pull did. Local only: no session, no network (N7, P1).
 *
 * The cursors are **server** clocks (§4.12: `vehicles.updated_at`, `scan_events.inserted_at`),
 * so nothing here may compare them against the device clock. Both are timestamps as
 * Postgres sent them, kept verbatim and handed back verbatim.
 */
import type { SyncStateRecord } from "../vin/types";
import { db } from "./db";

export const DEFAULT_SYNC_STATE: SyncStateRecord = {
  id: "cursor",
  vehiclesCursor: null,
  eventsCursor: null,
  lastPushAt: null,
  lastPullAt: null,
  lastError: null,
};

/** The two fields that only ever move forward. */
export type CursorField = "vehiclesCursor" | "eventsCursor";

function asTimestamp(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

/**
 * A row written by an older build keeps that build's fields; anything that is not a
 * timestamp becomes `null`, the same guard §5.6's settings row gets. This matters more
 * than it looks: a cursor is sent back to the server as a filter value, so a junk cursor
 * is a pull that errors on every attempt, and a *plausible but wrong* one is a pull that
 * silently skips rows. `null` means "pull everything", which is always safe.
 */
export function normalizeSyncState(stored: Partial<SyncStateRecord> | undefined): SyncStateRecord {
  const merged: SyncStateRecord = { ...DEFAULT_SYNC_STATE, ...stored, id: "cursor" };
  return {
    ...merged,
    vehiclesCursor: asTimestamp(merged.vehiclesCursor),
    eventsCursor: asTimestamp(merged.eventsCursor),
    lastPushAt: asTimestamp(merged.lastPushAt),
    lastPullAt: asTimestamp(merged.lastPullAt),
    lastError: typeof merged.lastError === "string" ? merged.lastError : null,
  };
}

/** Reads the row, creating it on first use — the shape §5.6's `getSettings` established. */
export async function getSyncState(): Promise<SyncStateRecord> {
  return db.transaction("rw", db.syncState, async () => {
    const stored = await db.syncState.get("cursor");
    if (stored === undefined) {
      const created = { ...DEFAULT_SYNC_STATE };
      await db.syncState.put(created);
      return created;
    }
    return normalizeSyncState(stored);
  });
}

export async function updateSyncState(
  patch: Partial<Omit<SyncStateRecord, "id">>,
): Promise<SyncStateRecord> {
  return db.transaction("rw", db.syncState, async () => {
    const current = await getSyncState();
    const next = normalizeSyncState({ ...current, ...patch });
    await db.syncState.put(next);
    return next;
  });
}

/**
 * §4.12: "cursor = max timestamp received". Only forward, and only for a value that
 * parses — a cursor that jumps ahead skips rows the device has never seen, and unlike a
 * cursor that lags (which re-pulls rows the merge rules are idempotent about) that loss is
 * permanent. An unparseable stored cursor loses to a real one, so the row heals.
 */
export async function advanceCursors(
  patch: Partial<Record<CursorField, string>>,
): Promise<SyncStateRecord> {
  return db.transaction("rw", db.syncState, async () => {
    const current = await getSyncState();
    const next = { ...current };
    for (const field of ["vehiclesCursor", "eventsCursor"] as const) {
      const incoming = asTimestamp(patch[field]);
      if (incoming === null) continue;
      const held = current[field];
      if (held === null || Date.parse(incoming) > Date.parse(held)) next[field] = incoming;
    }
    await db.syncState.put(next);
    return next;
  });
}

/**
 * Back to defaults. A cursor names a position in one account's history, so signing out —
 * or signing in as someone else — must drop it, or the next account's first pull starts
 * partway through and never fetches what came before (§9-S4, N7).
 */
export async function resetSyncState(): Promise<SyncStateRecord> {
  return db.transaction("rw", db.syncState, async () => {
    const created = { ...DEFAULT_SYNC_STATE };
    await db.syncState.put(created);
    return created;
  });
}
