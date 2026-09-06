/**
 * An in-memory PostgREST + Postgres, exactly as wide as `SyncClient` and no wider.
 *
 * There is no Docker daemon in this environment and `api.supabase.com` is blocked, so the
 * S4 scenarios §9-S4 lists as its DoD extras — a half-failed push, the same batch pushed
 * twice, a pull arriving mid-push, two devices converging on the later edit, an offline day
 * flushed in order, a delete followed by a re-scan — have nowhere real to run. This is what
 * they run against instead, and **every result they produce is a claim about this file, not
 * about Postgres**. The session report says so in as many words.
 *
 * What makes it worth anything is that the behaviour below is transcribed from
 * `supabase/migrations/0001_init.sql` rather than from `merge.ts`:
 *
 * - RLS: `user_id = auth.uid()` on read and on write, and no rows at all when signed out;
 * - `apply_scan_event`: the insert seeds `meta_updated_at` from the **event** clock, and the
 *   conflict branch only touches the aggregates and clears `deleted_at` (the literal
 *   skeleton, quirk included — the client is not allowed to work around it);
 * - `touch_updated_at`: every update stamps the server clock, which is the pull cursor;
 * - `upsert_vehicle_meta`: LWW on `meta_updated_at`, `greatest` for the clock, first
 *   non-empty `structural`, `better_decode` for `decode`;
 * - `delete_vehicle`: `deleted_at = now()`, cleared again by any later event;
 * - `on conflict do nothing` for the event insert, which is what makes a re-push idempotent.
 *
 * The clock is a counter, not the wall clock: one timestamp per call, the way `now()` is one
 * timestamp per transaction. Tests that interleave two devices need it to be exact.
 */
import type {
  ChannelHandle,
  PostgresChangesFilter,
  PostgrestErrorLike,
  SelectBuilder,
  SelectResult,
  SyncClient,
  TableHandle,
  WriteResult,
} from "./types";

export interface ServerVehicleRow {
  user_id: string;
  vin: string;
  unit: string | null;
  notes: string | null;
  /** S5's column, from `supabase/migrations/0002_paint_code.sql`. */
  paint: string | null;
  meta_updated_at: string;
  structural: Record<string, unknown>;
  decode: Record<string, unknown>;
  first_scanned_at: string | null;
  last_scanned_at: string | null;
  scan_count: number;
  deleted_at: string | null;
  updated_at: string;
}

export interface ServerEventRow {
  id: string;
  user_id: string;
  vin: string;
  at: string;
  symbology: string;
  check_digit_valid: boolean;
  device_label: string | null;
  origin: string;
  inserted_at: string;
}

/** One call as it reached the server — what the ordering and batching tests assert on. */
export interface FakeRequest {
  kind: "upsert" | "rpc" | "select";
  target: string;
  rows: number;
  vins: string[];
  args?: Record<string, unknown>;
}

const VIN_GRAMMAR = /^[A-HJ-NPR-Z0-9]{17}$/;

/** PostgREST surfaces the SQLSTATE; `check_violation` and `insufficient_privilege` here. */
function sqlError(code: string, message: string): PostgrestErrorLike {
  return { code, message, details: null, hint: null };
}

function instant(value: string | null | undefined): number {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

function newer(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = instant(a);
  if (Number.isNaN(left)) return false;
  const right = instant(b);
  return Number.isNaN(right) || left > right;
}

/** `least`/`greatest`: Postgres ignores nulls here rather than propagating them. */
function least(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return newer(b, a) ? a : b;
}

function greatest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return newer(b, a) ? b : a;
}

/** `public.decode_rank`. */
function decodeRank(decode: Record<string, unknown> | null | undefined): number {
  switch (decode?.status) {
    case "ok":
      return 3;
    case "partial":
      return 2;
    case "unsupported":
      return 1;
    default:
      return 0;
  }
}

/** `public.better_decode(a, b)`. */
function betterDecode(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const rankA = decodeRank(a);
  const rankB = decodeRank(b);
  if (rankB > rankA) return b;
  if (rankB === rankA && newer(b.fetchedAt as string | null, a.fetchedAt as string | null))
    return b;
  return a;
}

export interface FakeServerOptions {
  /** First server timestamp. Every call takes the next millisecond. */
  start?: string;
}

export class FakeServer {
  readonly vehicles = new Map<string, ServerVehicleRow>();
  readonly events = new Map<string, ServerEventRow>();
  readonly requests: FakeRequest[] = [];

  /** Set to make matching calls fail, the way a real one can. */
  failNext: ((request: FakeRequest) => PostgrestErrorLike | null) | null = null;

  private tick: number;
  private readonly channels: Array<{ userId: string; notify: () => void }> = [];

  constructor(options: FakeServerOptions = {}) {
    this.tick = Date.parse(options.start ?? "2026-09-04T12:00:00.000Z");
  }

  /** `now()` — one value per call, monotonic, the way transaction time is. */
  now(): string {
    this.tick += 1;
    return new Date(this.tick).toISOString();
  }

  private key(userId: string, vin: string): string {
    return `${userId}/${vin}`;
  }

  private record(request: FakeRequest): PostgrestErrorLike | null {
    this.requests.push(request);
    return this.failNext?.(request) ?? null;
  }

  private touch(row: ServerVehicleRow, at: string): void {
    row.updated_at = at;
    this.vehicles.set(this.key(row.user_id, row.vin), row);
    for (const channel of this.channels) {
      if (channel.userId === row.user_id) channel.notify();
    }
  }

  /** `public.apply_scan_event`, transcribed. */
  private applyScanEvent(event: ServerEventRow, at: string): void {
    const existing = this.vehicles.get(this.key(event.user_id, event.vin));
    if (existing === undefined) {
      this.touch(
        {
          user_id: event.user_id,
          vin: event.vin,
          unit: null,
          notes: null,
          // A scan carries no paint code and `apply_scan_event` names no such column.
          paint: null,
          // The quirk §4.12 owns: a scan seeds the LWW clock for unit and notes.
          meta_updated_at: event.at,
          structural: {},
          decode: {},
          first_scanned_at: event.at,
          last_scanned_at: event.at,
          scan_count: 1,
          deleted_at: null,
          updated_at: at,
        },
        at,
      );
      return;
    }
    existing.first_scanned_at = least(existing.first_scanned_at, event.at);
    existing.last_scanned_at = greatest(existing.last_scanned_at, event.at);
    existing.scan_count += 1;
    existing.deleted_at = null;
    this.touch(existing, at);
  }

  insertScanEvents(userId: string | null, rows: Record<string, unknown>[]): WriteResult {
    const error = this.record({
      kind: "upsert",
      target: "scan_events",
      rows: rows.length,
      vins: rows.map((row) => String(row.vin)),
    });
    if (error !== null) return { error };
    // Signed out, `auth.uid()` is null and every policy denies.
    if (userId === null) return { error: sqlError("42501", "new row violates row-level security") };

    const at = this.now();
    const accepted: ServerEventRow[] = [];
    for (const row of rows) {
      if (row.user_id !== userId) {
        return { error: sqlError("42501", "new row violates row-level security policy") };
      }
      if (typeof row.vin !== "string" || !VIN_GRAMMAR.test(row.vin)) {
        return { error: sqlError("23514", 'violates check constraint "scan_events_vin_grammar"') };
      }
      const id = String(row.id);
      // `on conflict (id) do nothing` — and the trigger does not fire for a row that was
      // not inserted, which is what makes the same batch pushed twice count once.
      if (this.events.has(id)) continue;
      accepted.push({
        id,
        user_id: userId,
        vin: row.vin,
        at: String(row.at),
        symbology: String(row.symbology),
        check_digit_valid: row.check_digit_valid === true,
        device_label: row.device_label === null ? null : String(row.device_label),
        origin: String(row.origin),
        inserted_at: at,
      });
    }
    for (const event of accepted) {
      this.events.set(event.id, event);
      this.applyScanEvent(event, at);
    }
    return { error: null };
  }

  /** `public.upsert_vehicle_meta`, transcribed. */
  upsertVehicleMeta(userId: string | null, args: Record<string, unknown>): WriteResult {
    const error = this.record({
      kind: "rpc",
      target: "upsert_vehicle_meta",
      rows: 1,
      vins: [String(args.p_vin)],
      args,
    });
    if (error !== null) return { error };
    if (userId === null) return { error: sqlError("23502", 'null value in column "user_id"') };

    const vin = String(args.p_vin);
    if (!VIN_GRAMMAR.test(vin)) {
      return { error: sqlError("23514", 'violates check constraint "vehicles_vin_check"') };
    }
    const at = this.now();
    const incomingMeta = String(args.p_meta_updated_at);
    const structural = (args.p_structural as Record<string, unknown> | null) ?? {};
    const decode = (args.p_decode as Record<string, unknown> | null) ?? {};
    const unit = (args.p_unit as string | null) ?? null;
    const notes = (args.p_notes as string | null) ?? null;
    // Migration 0002 gives `p_paint` a default, so a caller from before S5 omits it and the
    // column stays null — which is what that build knows.
    const paint = (args.p_paint as string | null) ?? null;

    const existing = this.vehicles.get(this.key(userId, vin));
    if (existing === undefined) {
      this.touch(
        {
          user_id: userId,
          vin,
          unit,
          notes,
          paint,
          meta_updated_at: incomingMeta,
          structural,
          decode,
          first_scanned_at: null,
          last_scanned_at: null,
          scan_count: 0,
          deleted_at: null,
          updated_at: at,
        },
        at,
      );
      return { error: null };
    }

    const wins = newer(incomingMeta, existing.meta_updated_at);
    existing.unit = wins ? unit : existing.unit;
    existing.notes = wins ? notes : existing.notes;
    existing.paint = wins ? paint : existing.paint;
    existing.meta_updated_at = greatest(existing.meta_updated_at, incomingMeta) ?? incomingMeta;
    existing.structural =
      Object.keys(existing.structural).length === 0 ? structural : existing.structural;
    existing.decode = betterDecode(existing.decode, decode);
    this.touch(existing, at);
    return { error: null };
  }

  /** `public.delete_vehicle`. */
  deleteVehicle(userId: string | null, args: Record<string, unknown>): WriteResult {
    const error = this.record({
      kind: "rpc",
      target: "delete_vehicle",
      rows: 1,
      vins: [String(args.p_vin)],
      args,
    });
    if (error !== null) return { error };
    if (userId === null) return { error: null };

    const row = this.vehicles.get(this.key(userId, String(args.p_vin)));
    if (row === undefined) return { error: null };
    const at = this.now();
    row.deleted_at = at;
    this.touch(row, at);
    return { error: null };
  }

  /** `public.delete_my_data`. */
  deleteMyData(userId: string | null): WriteResult {
    const error = this.record({ kind: "rpc", target: "delete_my_data", rows: 0, vins: [] });
    if (error !== null) return { error };
    if (userId === null) return { error: null };
    for (const [id, event] of this.events) if (event.user_id === userId) this.events.delete(id);
    for (const [key, row] of this.vehicles) if (row.user_id === userId) this.vehicles.delete(key);
    return { error: null };
  }

  select(
    userId: string | null,
    table: string,
    filters: { gte?: { column: string; value: string }; order?: string; limit?: number },
  ): SelectResult {
    const error = this.record({ kind: "select", target: table, rows: 0, vins: [] });
    if (error !== null) return { data: null, error };

    // RLS: signed out sees nothing at all, and a session sees only its own rows.
    const source: Record<string, unknown>[] =
      userId === null
        ? []
        : table === "vehicles"
          ? this.vehiclesOf(userId).map((row) => ({ ...row }))
          : this.eventsOf(userId).map((row) => ({ ...row }));

    const gte = filters.gte;
    const filtered =
      gte === undefined
        ? source
        : source.filter((row) => instant(row[gte.column] as string) >= instant(gte.value));
    const column = filters.order;
    const ordered =
      column === undefined
        ? filtered
        : [...filtered].sort((a, b) => instant(a[column] as string) - instant(b[column] as string));
    return { data: ordered.slice(0, filters.limit ?? ordered.length), error: null };
  }

  subscribe(userId: string, notify: () => void): () => void {
    const entry = { userId, notify };
    this.channels.push(entry);
    return () => {
      const index = this.channels.indexOf(entry);
      if (index >= 0) this.channels.splice(index, 1);
    };
  }

  /** One user's account, for assertions. */
  vehiclesOf(userId: string): ServerVehicleRow[] {
    return [...this.vehicles.values()].filter((row) => row.user_id === userId);
  }

  eventsOf(userId: string): ServerEventRow[] {
    return [...this.events.values()].filter((row) => row.user_id === userId);
  }
}

class FakeSelect implements SelectBuilder {
  private filters: { gte?: { column: string; value: string }; order?: string; limit?: number } = {};

  constructor(
    private readonly server: FakeServer,
    private readonly session: () => string | null,
    private readonly table: string,
  ) {}

  gte(column: string, value: string): SelectBuilder {
    this.filters.gte = { column, value };
    return this;
  }

  order(column: string, options: { ascending: boolean }): SelectBuilder {
    if (!options.ascending) throw new Error("the fake implements ascending order only");
    this.filters.order = column;
    return this;
  }

  limit(count: number): SelectBuilder {
    this.filters.limit = count;
    return this;
  }

  then<TResult1 = SelectResult, TResult2 = never>(
    onfulfilled?: ((value: SelectResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => this.server.select(this.session(), this.table, this.filters))
      .then(onfulfilled, onrejected);
  }
}

/**
 * One device's client. `session` is the fake's `auth.uid()` — a function, so a test can sign
 * out mid-run — and two clients over one `FakeServer` are two devices on one account.
 */
export function createFakeClient(server: FakeServer, session: () => string | null): SyncClient {
  const subscriptions = new Map<ChannelHandle, () => void>();

  return {
    from(table: string): TableHandle {
      return {
        upsert: async (values) => {
          if (table !== "scan_events") throw new Error(`no upsert on ${table} in this protocol`);
          return server.insertScanEvents(session(), values);
        },
        select: () => new FakeSelect(server, session, table),
      };
    },
    rpc: async (fn, args) => {
      if (fn === "upsert_vehicle_meta") return server.upsertVehicleMeta(session(), args);
      if (fn === "delete_vehicle") return server.deleteVehicle(session(), args);
      if (fn === "delete_my_data") return server.deleteMyData(session());
      throw new Error(`unknown rpc ${fn}`);
    },
    channel(): ChannelHandle {
      let onSignal: (() => void) | null = null;
      const handle: ChannelHandle = {
        on: (_type: "postgres_changes", _filter: PostgresChangesFilter, callback) => {
          onSignal = () => callback({});
          return handle;
        },
        subscribe: (callback) => {
          const userId = session();
          if (userId !== null) {
            subscriptions.set(
              handle,
              server.subscribe(userId, () => onSignal?.()),
            );
          }
          callback?.("SUBSCRIBED");
          return handle;
        },
      };
      return handle;
    },
    removeChannel(handle: ChannelHandle) {
      subscriptions.get(handle)?.();
      subscriptions.delete(handle);
      return "ok";
    },
  };
}
