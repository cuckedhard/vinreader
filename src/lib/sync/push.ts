/**
 * §4.12's push: the outbox, in insertion order, into the user's own account.
 *
 * **Order is the whole design.** §4.12 says "push in insertion order, batches of 50 per
 * kind", and the two halves of that sentence pull against each other: draining one kind at
 * a time is what inverts a delete and a later re-scan of the same VIN. `delete_vehicle`
 * sets `deleted_at`, and only a *later* `scan_events` insert clears it through
 * `apply_scan_event`; push every event first and the account ends up deleting a record the
 * user deliberately re-scanned, with nothing on either side able to notice. So the drain
 * reads every kind at once — `dueRows()` with no kind returns exactly that — and batches
 * only *consecutive* rows of the same kind. Both halves hold: nothing overtakes anything,
 * and no request carries more than 50 rows of one kind.
 *
 * **A failure blocks its VIN, not the queue.** The ordering that matters is per VIN, so a
 * row that fails takes its VIN out of the rest of the drain and leaves every other VIN
 * moving. What stops the drain outright is a failure that is not the server's answer —
 * no signal, an expired token — because then the next request would fail the same way.
 *
 * **Nothing is ever dropped** (§4.12). A failed row keeps its place, gains an attempt and
 * a `nextAttemptAt` from the 5 s → 30 s → 2 min → 10 min schedule, and comes back.
 */
import { OUTBOX_BATCH, deferOutboxRow, dueRows, removeOutboxRows } from "../storage/outbox";
import type {
  OutboxKind,
  OutboxRow,
  ScanEventPayload,
  VehicleDeletePayload,
  VehicleMetaPayload,
} from "../vin/types";
import type { PostgrestErrorLike, SyncClient, WriteResult } from "./types";

/** §4.12: "batches of 50 per kind" — the same constant the outbox counts in. */
export const PUSH_BATCH = OUTBOX_BATCH;

/** §4.12: "back off 5 s → 30 s → 2 min → 10 min cap". The last entry is the cap. */
export const PUSH_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000] as const;

/** Rows read per drain. A cycle drains repeatedly until the queue is empty or it stops. */
export const PUSH_DRAIN_LIMIT = 500;

/** A cycle pushes at most this many drains, so one call cannot run without end. */
export const PUSH_MAX_DRAINS = 10;

/**
 * Consecutive server-side rejections that end a drain. A push the server *answers* is
 * worth continuing past — the next VIN is unrelated — but a run of them means something
 * systematic (a policy, a constraint, a schema behind this build), and hammering the rest
 * of the queue against it wastes a radio the user is standing outdoors with.
 */
export const PUSH_MAX_REJECTIONS = 5;

export type PushStop = "drained" | "transport" | "rejections" | "limit";

export interface PushResult {
  /** Rows the server accepted and the outbox no longer holds. */
  pushed: number;
  /** Rows that failed and are now waiting out a backoff. */
  deferred: number;
  /** Why the drain ended. `drained` means the queue is empty of due rows. */
  stopped: PushStop;
  /** The last failure, for §5.8's `lastError` and the §6.4 chip. */
  error: string | null;
}

export interface PushContext {
  client: SyncClient;
  userId: string;
  /** Injected so a test can place a backoff exactly; defaults to the wall clock. */
  now?: () => number;
}

/**
 * `nextAttemptAt` for a row that has already failed `attempts` times. UTC (`Z`) rather
 * than §5.1's offset form: this is a scheduling instant read only by `Date.parse` in
 * `dueRows`, never a record timestamp shown to anyone.
 */
export function backoffFrom(attempts: number, nowMs: number): string {
  const index = Math.min(
    Math.max(Number.isInteger(attempts) ? attempts : 0, 0),
    PUSH_BACKOFF_MS.length - 1,
  );
  return new Date(nowMs + PUSH_BACKOFF_MS[index]).toISOString();
}

/**
 * §4.12's batching rule, as a pure function: runs of consecutive same-kind rows, each run
 * cut into batches of at most `size`. Insertion order is preserved exactly — the output
 * flattens back to the input.
 */
export function batchRows(rows: OutboxRow[], size: number = PUSH_BATCH): OutboxRow[][] {
  const batches: OutboxRow[][] = [];
  let current: OutboxRow[] = [];
  for (const row of rows) {
    const sameKind = current.length > 0 && current[0].kind === row.kind;
    if (!sameKind || current.length >= size) {
      if (current.length > 0) batches.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Did the *server* refuse this statement, or did the request never get an answer?
 *
 * A five-character SQLSTATE is Postgres speaking: a check constraint, an RLS policy, a
 * type it would not take. That verdict belongs to the one statement, so the drain may
 * carry on with unrelated VINs. Everything else — a fetch that threw, a gateway, PostgREST's
 * own `PGRST…` codes (an expired JWT among them) — says nothing about the row, so the drain
 * stops and the backoff decides when to try again.
 */
export function isServerRejection(error: PostgrestErrorLike | null | undefined): boolean {
  return typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code);
}

function describe(error: PostgrestErrorLike): string {
  return error.code ? `${error.code}: ${error.message}` : error.message;
}

/**
 * A §5.7 row's payload is already in §4.12's own field names — `scan_events` columns and
 * the `p_*` parameters of the two RPCs — so a push reshapes nothing. `user_id` is the one
 * column the device cannot know at write time and the only thing added here.
 */
function scanEventInsert(row: OutboxRow, userId: string): Record<string, unknown> {
  return { ...(row.payload as ScanEventPayload), user_id: userId };
}

async function send(
  context: PushContext,
  kind: OutboxKind,
  rows: OutboxRow[],
): Promise<WriteResult> {
  if (kind === "scan_event") {
    // §4.12 verbatim. `ignoreDuplicates` compiles to `on conflict do nothing`, which is
    // what makes a re-pushed batch idempotent: the row is not inserted, so
    // `apply_scan_event` does not fire and no aggregate is counted twice.
    return context.client.from("scan_events").upsert(
      rows.map((row) => scanEventInsert(row, context.userId)),
      { onConflict: "id", ignoreDuplicates: true },
    );
  }
  const [row] = rows;
  if (kind === "vehicle_meta") {
    return context.client.rpc("upsert_vehicle_meta", { ...(row.payload as VehicleMetaPayload) });
  }
  return context.client.rpc("delete_vehicle", { ...(row.payload as VehicleDeletePayload) });
}

interface DrainState {
  pushed: number;
  deferred: number;
  rejections: number;
  error: string | null;
  stop: PushStop | null;
  blocked: Set<string>;
}

async function fail(
  state: DrainState,
  rows: OutboxRow[],
  error: PostgrestErrorLike,
  nowMs: number,
): Promise<void> {
  const message = describe(error);
  state.error = message;
  for (const row of rows) {
    state.blocked.add(row.vin);
    await deferOutboxRow(row.id, {
      nextAttemptAt: backoffFrom(row.attempts, nowMs),
      lastError: message,
    });
    state.deferred += 1;
  }
}

/**
 * One batch, and what to do with its answer.
 *
 * The retry on a rejected multi-row batch is the reason a poisoned row cannot wedge the
 * queue. `upsert` is all-or-nothing, so one row the server will never accept fails the
 * other forty-nine with it, every time, for ever. Re-sending them one at a time costs
 * requests only on the failing path and leaves exactly the bad row deferred — which is
 * also the only way its `lastError` names something the user could act on (P7).
 */
async function pushBatch(
  context: PushContext,
  state: DrainState,
  batch: OutboxRow[],
  nowMs: number,
): Promise<void> {
  const rows = batch.filter((row) => !state.blocked.has(row.vin));
  if (rows.length === 0) return;
  const kind = rows[0].kind;

  // The two RPC kinds take one row per call, so they are their own batch of one; the
  // enclosing group still bounds them at 50 and still holds insertion order.
  const units = kind === "scan_event" ? [rows] : rows.map((row) => [row]);

  for (const unit of units) {
    const live = unit.filter((row) => !state.blocked.has(row.vin));
    if (live.length === 0) continue;

    const { error } = await send(context, kind, live);
    if (error === null) {
      await removeOutboxRows(live.map((row) => row.id));
      state.pushed += live.length;
      continue;
    }

    if (!isServerRejection(error)) {
      await fail(state, live, error, nowMs);
      state.stop = "transport";
      return;
    }

    if (live.length > 1) {
      for (const row of live) {
        const single = await send(context, kind, [row]);
        if (single.error === null) {
          await removeOutboxRows([row.id]);
          state.pushed += 1;
          continue;
        }
        if (!isServerRejection(single.error)) {
          await fail(state, [row], single.error, nowMs);
          state.stop = "transport";
          return;
        }
        await fail(state, [row], single.error, nowMs);
        state.rejections += 1;
      }
    } else {
      await fail(state, live, error, nowMs);
      state.rejections += 1;
    }

    if (state.rejections >= PUSH_MAX_REJECTIONS) {
      state.stop = "rejections";
      return;
    }
  }
}

/**
 * Drain the outbox for one signed-in user. Returns without a request when nothing is due.
 *
 * Blocked VINs are simply left queued: they are still due, so the next call picks them up,
 * and nothing in `dueRows` needs to know a push happened.
 */
export async function pushOutbox(context: PushContext): Promise<PushResult> {
  const clock = context.now ?? Date.now;
  const state: DrainState = {
    pushed: 0,
    deferred: 0,
    rejections: 0,
    error: null,
    stop: null,
    blocked: new Set<string>(),
  };

  for (let drain = 0; drain < PUSH_MAX_DRAINS; drain += 1) {
    const rows = (await dueRows({ limit: PUSH_DRAIN_LIMIT })).filter(
      (row) => !state.blocked.has(row.vin),
    );
    if (rows.length === 0) {
      state.stop = "drained";
      break;
    }

    const before = state.pushed;
    for (const batch of batchRows(rows)) {
      await pushBatch(context, state, batch, clock());
      if (state.stop !== null) break;
    }
    if (state.stop !== null) break;

    // Every row this drain saw was blocked before it was sent, so another pass would read
    // the same rows and send nothing. Without this the loop would spin PUSH_MAX_DRAINS
    // times over a queue it cannot move.
    if (state.pushed === before) {
      state.stop = "drained";
      break;
    }
  }

  return {
    pushed: state.pushed,
    deferred: state.deferred,
    stopped: state.stop ?? "limit",
    error: state.error,
  };
}
