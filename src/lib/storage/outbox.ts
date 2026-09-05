/**
 * §5.7 outbox — the local half of §4.12's sync, and the only thing standing between a
 * scan and the account.
 *
 * Two rules shape every line here. **N7 and P1:** a row is appended by the same local
 * write that produced it, from data already in hand, with no session read, no network and
 * no `@supabase/supabase-js` anywhere in this module's import graph — signed out, a scan
 * costs one extra IndexedDB put and nothing else. **§4.12 atomicity:** the append happens
 * inside the writer's transaction, so a scan and its outbox row land together or not at
 * all; a scan saved without its row would never sync, silently, forever.
 *
 * What a row stores is what its push call takes (§4.12 payload types in `../vin/types`),
 * so the push engine — a later session's work — reshapes nothing and this file holds no
 * knowledge of how the call is made.
 */
import type {
  OutboxKind,
  OutboxPayloadByKind,
  OutboxRow,
  ScanEvent,
  ScanEventPayload,
  VehicleRecord,
} from "../vin/types";
import { db, newId, nowIso } from "./db";

/** §4.12: "batches of 50 per kind". */
export const OUTBOX_BATCH = 50;

/**
 * A row is born unattempted. `nextAttemptAt: null` means "due now"; the push engine owns
 * the 5 s → 30 s → 2 min → 10 min schedule (§4.12) and writes it back through
 * `deferOutboxRow`, so no backoff policy lives on the write path.
 */
function outboxRow<K extends OutboxKind>(
  kind: K,
  vin: string,
  payload: OutboxPayloadByKind[K],
  id: string = newId(),
): OutboxRow {
  return {
    id,
    kind,
    vin,
    payload,
    createdAt: nowIso(),
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
  };
}

/**
 * The row for a §5.2 event. The outbox id **is** the event id: §4.12 already requires that
 * id to be the `scan_events` primary key so a re-push is idempotent, and reusing it makes
 * the append idempotent too — appending the same event twice cannot enqueue it twice.
 */
export function scanEventRow(event: ScanEvent, origin: ScanEventPayload["origin"]): OutboxRow {
  return outboxRow(
    "scan_event",
    event.vin,
    {
      id: event.id,
      vin: event.vin,
      at: event.at,
      symbology: event.symbology,
      check_digit_valid: event.checkDigitValid,
      device_label: event.deviceLabel,
      origin,
    },
    event.id,
  );
}

/**
 * [G3] The outbox id of a VIN's meta row, and the reason there is only ever one.
 *
 * §4.12 resolves `vehicle_meta` **last-writer-wins per VIN**, so of all the rows queued
 * for one VIN only the newest can change anything on the server — every older one is a
 * fact the account either already has or is about to be given. Keying the row by its VIN
 * makes a re-queue replace rather than append, exactly as `scanEventRow` reuses the event
 * id for its own idempotence, and it costs the scan path nothing: one `put` by primary
 * key, no read, no scan of the table (N7, P1).
 *
 * Without it a signed-out phone — never drained, since `push.ts` runs only from the sync
 * engine — kept a whole copy of the §4.7 decode block per re-scan: measured, 51 scans of
 * one decoded VIN left 51 meta rows carrying 2 distinct payloads and ~6 KB of the 5,003
 * -byte decode per scan, growing without bound and invisibly (§6.4 gives a signed-out
 * device no sync chip) until `QuotaExceededError` landed on the scan path itself.
 *
 * The prefix keeps this id out of the space `newId()` draws from, so it can never collide
 * with a §5.2 event id.
 */
export function vehicleMetaRowId(vin: string): string {
  return `vehicle_meta:${vin}`;
}

/**
 * The row for everything about a vehicle the server does not derive from events (§4.12:
 * `scan_count`, `first_scanned_at` and `last_scanned_at` are aggregates the client never
 * pushes). It is copied from the record as written, so what is queued is what is stored.
 *
 * The `decode` it carries is therefore the one the record held at that write. §5.4's queue
 * fills `decode` in later without passing through the upsert, so a vPIC result reaches the
 * account on the next write for that VIN — not the moment it lands.
 */
export function vehicleMetaRow(record: VehicleRecord): OutboxRow {
  return outboxRow(
    "vehicle_meta",
    record.vin,
    {
      p_vin: record.vin,
      p_unit: record.unit,
      p_notes: record.notes,
      p_meta_updated_at: record.metaUpdatedAt,
      p_structural: record.structural,
      p_decode: record.decode,
    },
    vehicleMetaRowId(record.vin),
  );
}

/** The row for a soft delete. §4.12: any later scan event clears the tombstone. */
export function vehicleDeleteRow(vin: string): OutboxRow {
  return outboxRow("vehicle_delete", vin, { p_vin: vin });
}

/**
 * Append rows **inside the caller's transaction** — the caller must already hold `rw` on
 * `db.outbox` — so the write and its outbox rows share one commit (§4.12).
 *
 * `bulkPut` and not `bulkAdd`: a put has no failure mode of its own. `add` would reject a
 * repeated id with a `ConstraintError`, and since `scanEventRow` deliberately reuses the
 * event id, that rejection would abort the whole transaction and lose a scan over a row
 * that was already queued. The only way this call can fail is the way `db.vehicles.put`
 * in the same transaction would also fail — the store itself — which is what keeps
 * atomicity from costing anything a local write did not already risk (N7, P1).
 */
export async function appendOutbox(rows: OutboxRow[]): Promise<void> {
  await db.outbox.bulkPut(rows);
}

/** §5.7: "Pending count = number of rows; it drives the sync chip" (§6.4). */
export async function pendingCount(): Promise<number> {
  return db.outbox.count();
}

export interface DueQuery {
  /** §4.12 pushes one kind at a time; omitted means every kind. */
  kind?: OutboxKind;
  /** The instant to judge `nextAttemptAt` against. Defaults to now. */
  now?: string;
  limit?: number;
}

/**
 * A row is due when it has never been deferred, or its backoff has elapsed. A
 * `nextAttemptAt` that does not parse counts as due: §4.12 says rows are never dropped,
 * and a timestamp an older build or a half-written row got wrong must not strand one
 * forever.
 */
function isDue(row: OutboxRow, at: number): boolean {
  if (typeof row.nextAttemptAt !== "string") return true;
  const next = Date.parse(row.nextAttemptAt);
  return Number.isNaN(next) || next <= at;
}

/**
 * The push engine's read: due rows in insertion order, oldest first.
 *
 * Ordering is by instant, not by the `createdAt` index alone. Offset timestamps do not
 * sort as strings (§5.1), so a device that crosses a time zone between two scans would
 * otherwise queue them out of order. Two rows written by one transaction share a
 * millisecond and so keep no defined order between them; nothing in §4.12's merge depends
 * on push order — events are keyed by id, meta is last-writer-wins by `meta_updated_at`,
 * and §5.7 has no sequence field to break the tie with — so this is fidelity to
 * "insertion order", not a correctness crutch.
 */
export async function dueRows(query: DueQuery = {}): Promise<OutboxRow[]> {
  const at = Date.parse(query.now ?? nowIso());
  const rows =
    query.kind === undefined
      ? await db.outbox.orderBy("createdAt").toArray()
      : await db.outbox.where("kind").equals(query.kind).sortBy("createdAt");
  return rows
    .filter((row) => isDue(row, at))
    .sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0))
    .slice(0, query.limit ?? OUTBOX_BATCH);
}

/**
 * Drop rows the server has accepted (§4.12: "Remove on success").
 *
 * [G3] By row and not by id. A `vehicle_meta` row is keyed by its VIN, so a scan or a
 * unit/notes edit that lands while the push is in flight replaces it under the same id —
 * and deleting that id would drop a fact the account was never sent, silently, with
 * nothing left to notice the gap. A stored row whose payload is still the one that was
 * pushed is redundant and goes; one carrying anything else is newer than the push and
 * stays queued for the next drain. Every other kind has a payload fixed by its id (a §5.2
 * event, a tombstone), so for them this is the delete it always was.
 *
 * A payload that compares unequal for any other reason keeps a row that could have gone:
 * the next drain pushes it again, and both RPCs are idempotent (§4.12), so the cost of
 * being wrong here is one request and never a lost write.
 */
export async function removeOutboxRows(rows: OutboxRow[]): Promise<void> {
  await db.transaction("rw", db.outbox, async () => {
    const stored = await db.outbox.bulkGet(rows.map((row) => row.id));
    const accepted = rows.filter((row, index) => {
      const current = stored[index];
      return (
        current !== undefined && JSON.stringify(current.payload) === JSON.stringify(row.payload)
      );
    });
    await db.outbox.bulkDelete(accepted.map((row) => row.id));
  });
}

/**
 * Record a failed push: §4.12 keeps the row, persists the attempt count and holds it until
 * `nextAttemptAt`. A row that vanished under us — pushed by another tab between the read
 * and the failure — is not recreated.
 */
export async function deferOutboxRow(
  id: string,
  next: { nextAttemptAt: string | null; lastError: string | null },
): Promise<void> {
  await db.transaction("rw", db.outbox, async () => {
    const row = await db.outbox.get(id);
    if (row === undefined) return;
    await db.outbox.put({
      ...row,
      attempts: Number.isInteger(row.attempts) && row.attempts >= 0 ? row.attempts + 1 : 1,
      nextAttemptAt: next.nextAttemptAt,
      lastError: next.lastError,
    });
  });
}

/**
 * §9-S4: signing out with "keep this phone's records" leaves Dexie alone and clears the
 * outbox — what is queued belongs to the account that queued it, and must not be pushed
 * into the next one. Local records stay; the Account screen's "Add N local records"
 * re-queues them on request.
 */
export async function clearOutbox(): Promise<void> {
  await db.outbox.clear();
}
