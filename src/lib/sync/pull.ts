/**
 * §4.12's pull, and the **one apply path** the whole engine funnels through.
 *
 * Everything that arrives from the account — a page of `vehicles`, a page of `scan_events`,
 * a realtime notification that turns into a pull — is written to Dexie by `applyPulled` and
 * by nothing else. §4.12 is explicit about why: "the event is only a signal to pull; it is
 * never applied directly (one apply path)". A second writer would be a second merge, and a
 * merge that only *usually* matches the server's is worse than none.
 *
 * Paging is by cursor, not by offset. `where updated_at >= cursor` with the cursor moved to
 * the newest row of the page can re-deliver rows (every row sharing that instant comes back
 * once), and `dedupe by key` — §4.12's phrase — is what pays for that. Offset paging would
 * be cheaper and would silently *skip* a row whenever a concurrent write shifted the
 * window, which no later pull could ever recover: the skipped row's timestamp is already
 * behind the cursor.
 */
import { advanceCursors, getSyncState, updateSyncState } from "../storage/syncState";
import { currentYear, db, nowIso } from "../storage/db";
import type { ScanEvent, VehicleRecord } from "../vin/types";
import { NO_PENDING, mergeVehicle, type PendingLocal } from "./merge";
import { parseRemoteScanEvent, parseRemoteVehicle, toLocalScanEvent } from "./remoteRows";
import type { RemoteScanEvent, RemoteVehicle, SelectBuilder, SyncClient } from "./types";

/** §4.12: "pages of 500". */
export const PULL_PAGE = 500;

/** A pull reads at most this many pages of each table, so one call always terminates. */
export const PULL_MAX_PAGES = 200;

export interface PullResult {
  /** Rows written to `vehicles` — merged, so fewer than were received when nothing changed. */
  vehicles: number;
  /** Events added to the §5.2 log; ones the log already held are not counted. */
  events: number;
  error: string | null;
}

export interface PullContext {
  client: SyncClient;
  /** §4.4's cap is computed against this; injected so a test is not tied to the wall clock. */
  currentYear?: number;
}

/**
 * What the outbox still holds, per VIN — §4.12's "a local vehicle that still has an
 * unpushed `vehicle_meta` newer than the server's `meta_updated_at` keeps its local
 * unit/notes until pushed", plus the same idea for a queued delete and a queued scan.
 *
 * Read inside the apply transaction, not before it: a user editing a unit while a page is
 * in flight is exactly the case this guard exists for, and an index built a second earlier
 * would not know about the edit.
 */
async function pendingByVin(): Promise<Map<string, PendingLocal>> {
  const index = new Map<string, PendingLocal>();
  const rows = await db.outbox.toArray();
  for (const row of rows) {
    const entry = index.get(row.vin) ?? { ...NO_PENDING };
    if (row.kind === "vehicle_delete") entry.deleteQueued = true;
    if (row.kind === "vehicle_meta") {
      const at = (row.payload as { p_meta_updated_at?: unknown }).p_meta_updated_at;
      if (
        typeof at === "string" &&
        (entry.metaUpdatedAt === null || Date.parse(at) > Date.parse(entry.metaUpdatedAt))
      ) {
        entry.metaUpdatedAt = at;
      }
    }
    if (row.kind === "scan_event") {
      const at = (row.payload as { at?: unknown }).at;
      if (
        typeof at === "string" &&
        (entry.scanAt === null || Date.parse(at) > Date.parse(entry.scanAt))
      ) {
        entry.scanAt = at;
      }
    }
    index.set(row.vin, entry);
  }
  return index;
}

/**
 * The one apply path. Vehicles are merged per §4.12; events are added to the §5.2 log and
 * never overwrite one already there — the local copy is the only one carrying `raw`, which
 * §4.12 has no column for and N3 keeps on the device.
 */
export async function applyPulled(
  incoming: { vehicles?: RemoteVehicle[]; events?: RemoteScanEvent[] },
  currentYear: number,
): Promise<{ vehicles: number; events: number }> {
  const vehicles = incoming.vehicles ?? [];
  const events = incoming.events ?? [];
  if (vehicles.length === 0 && events.length === 0) return { vehicles: 0, events: 0 };

  return db.transaction("rw", db.vehicles, db.scanEvents, db.outbox, async () => {
    const pending = await pendingByVin();

    const locals = await db.vehicles.bulkGet(vehicles.map((row) => row.vin));
    const writes: VehicleRecord[] = [];
    vehicles.forEach((remote, index) => {
      const merged = mergeVehicle(locals[index], remote, {
        currentYear,
        pending: pending.get(remote.vin),
      });
      if (merged !== null) writes.push(merged);
    });
    if (writes.length > 0) await db.vehicles.bulkPut(writes);

    const held = await db.scanEvents.bulkGet(events.map((event) => event.id));
    const additions: ScanEvent[] = [];
    events.forEach((event, index) => {
      if (held[index] === undefined) additions.push(toLocalScanEvent(event));
    });
    if (additions.length > 0) await db.scanEvents.bulkPut(additions);

    return { vehicles: writes.length, events: additions.length };
  });
}

function query(
  client: SyncClient,
  table: string,
  column: string,
  cursor: string | null,
): SelectBuilder {
  const base = client.from(table).select("*");
  // A null cursor means "everything": the first pull of a device that has just signed in,
  // and the state `resetSyncState` leaves behind when the account changes.
  const filtered = cursor === null ? base : base.gte(column, cursor);
  return filtered.order(column, { ascending: true }).limit(PULL_PAGE);
}

function newest(values: string[]): string | null {
  let best: string | null = null;
  for (const value of values) {
    if (best === null || Date.parse(value) > Date.parse(best)) best = value;
  }
  return best;
}

interface PageOutcome {
  applied: number;
  error: string | null;
}

/**
 * Page through one table, applying and advancing the cursor as each page lands, so a pull
 * cut short by a dropped connection keeps everything it already merged. The cursor only
 * ever moves forward (§5.8), and the filter is `>=`, so re-running a partial pull costs a
 * re-delivered page and changes nothing: every merge rule in §4.12 is idempotent.
 */
async function pullTable<T>(
  context: PullContext,
  spec: {
    table: string;
    column: string;
    cursorField: "vehiclesCursor" | "eventsCursor";
    parse: (row: Record<string, unknown>) => T | null;
    key: (row: T) => string;
    apply: (rows: T[]) => Promise<number>;
  },
  startCursor: string | null,
): Promise<PageOutcome> {
  const seen = new Set<string>();
  let cursor = startCursor;
  let applied = 0;

  for (let page = 0; page < PULL_MAX_PAGES; page += 1) {
    const { data, error } = await query(context.client, spec.table, spec.column, cursor);
    if (error !== null) return { applied, error: error.message };

    const raw = data ?? [];
    const parsed: T[] = [];
    for (const row of raw) {
      const value = spec.parse(row);
      // §4.12: "dedupe by key". The `>=` boundary re-delivers every row sharing the
      // cursor's instant, and a row this pull has already applied must not be applied twice.
      if (value === null || seen.has(spec.key(value))) continue;
      seen.add(spec.key(value));
      parsed.push(value);
    }

    if (parsed.length > 0) applied += await spec.apply(parsed);

    // §4.12/§5.8: "cursor = max timestamp received". Every row received, not every row
    // applied — a row dropped by `parse` or by dedupe has still been seen, and leaving the
    // cursor behind it would fetch it again on every pull for ever.
    const maxStamp = newest(
      raw.map((row) => row[spec.column]).filter((v): v is string => typeof v === "string"),
    );
    if (maxStamp !== null) await advanceCursors({ [spec.cursorField]: maxStamp });

    // A short page is the last page.
    if (raw.length < PULL_PAGE) break;
    // A full page whose newest row is the instant we asked from would ask the same question
    // again for ever. It takes more than 500 rows sharing one server timestamp to reach
    // here — a push transaction carries at most 50 — and a bounded stall that the next pull
    // retries beats a loop that never returns.
    if (maxStamp === null || maxStamp === cursor) break;
    cursor = maxStamp;
  }

  return { applied, error: null };
}

/**
 * One pull: `vehicles`, then `scan_events`, both from §5.8's cursor.
 *
 * Vehicles first on purpose. The aggregates a client never pushes — `scan_count`,
 * `first_scanned_at`, `last_scanned_at` — are derived server-side by `apply_scan_event`, so
 * the vehicles row already carries the answer for every event in the same pull, and taking
 * the events first would show a log that is briefly ahead of the record it belongs to.
 */
export async function pullOnce(context: PullContext): Promise<PullResult> {
  const year = context.currentYear ?? currentYear();
  const state = await getSyncState();

  const vehicles = await pullTable<RemoteVehicle>(
    context,
    {
      table: "vehicles",
      column: "updated_at",
      cursorField: "vehiclesCursor",
      parse: parseRemoteVehicle,
      key: (row) => row.vin,
      apply: async (rows) => (await applyPulled({ vehicles: rows }, year)).vehicles,
    },
    state.vehiclesCursor,
  );

  const events =
    vehicles.error !== null
      ? { applied: 0, error: vehicles.error }
      : await pullTable<RemoteScanEvent>(
          context,
          {
            table: "scan_events",
            column: "inserted_at",
            cursorField: "eventsCursor",
            parse: parseRemoteScanEvent,
            key: (row) => row.id,
            apply: async (rows) => (await applyPulled({ events: rows }, year)).events,
          },
          state.eventsCursor,
        );

  const error = vehicles.error ?? events.error;
  await updateSyncState(
    error === null ? { lastPullAt: nowIso(), lastError: null } : { lastError: error },
  );

  return { vehicles: vehicles.applied, events: events.applied, error };
}
