/**
 * The sync engine's view of the world (§4.12, S4).
 *
 * Two boundaries are drawn here and nowhere else.
 *
 * **The client surface.** `SyncClient` is the *narrow* slice of `@supabase/supabase-js`
 * this engine actually calls: three writes, two reads, one channel. A real
 * `SupabaseClient` satisfies it structurally — `client.compat.test.ts` asserts that at the
 * type level — so nothing casts, and the in-memory fake the tests run against implements a
 * surface that is exactly as wide as the one production uses. A fake that is easier to
 * satisfy than the real thing proves nothing.
 *
 * **The auth seam.** The engine never imports `../auth`. It takes `getClient` and
 * `getUserId` (the contract in `src/lib/auth/`) as dependencies, so a test can be signed
 * in, signed out or unconfigured without a session existing, and N7 stays checkable: no
 * function here awaits a session on any write path, because no write path is here at all.
 */
import type { VehicleDecode } from "../vin/types";

/** What PostgREST returns on failure. `code` is a SQLSTATE for a server-side rejection. */
export interface PostgrestErrorLike {
  message: string;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
}

export interface SelectResult {
  data: Record<string, unknown>[] | null;
  error: PostgrestErrorLike | null;
}

export interface WriteResult {
  error: PostgrestErrorLike | null;
}

/** The three filter calls §4.12's pull needs, and nothing else. */
export interface SelectBuilder extends PromiseLike<SelectResult> {
  gte(column: string, value: string): SelectBuilder;
  order(column: string, options: { ascending: boolean }): SelectBuilder;
  limit(count: number): SelectBuilder;
}

export interface TableHandle {
  upsert(
    values: Record<string, unknown>[],
    options: { onConflict: string; ignoreDuplicates: boolean },
  ): PromiseLike<WriteResult>;
  select(columns: string): SelectBuilder;
}

/** §4.12 realtime: `postgres_changes` on `vehicles`, filtered to one user. */
export interface PostgresChangesFilter {
  event: "*";
  schema: "public";
  table: "vehicles";
  filter: string;
}

export interface ChannelHandle {
  on(
    type: "postgres_changes",
    filter: PostgresChangesFilter,
    callback: (payload: unknown) => void,
  ): ChannelHandle;
  subscribe(callback?: (status: string, err?: Error) => void): ChannelHandle;
}

export interface SyncClient {
  from(table: string): TableHandle;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<WriteResult>;
  channel(name: string): ChannelHandle;
  removeChannel(channel: ChannelHandle): unknown;
}

/**
 * What the engine needs from the rest of the app. `getClient` returns null when
 * `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are unset, `getUserId` returns null when
 * signed out — both are ordinary states in which the engine does nothing at all (N7).
 *
 * `onAuthChange` is optional so a test can drive the engine by hand. Its callback takes no
 * arguments on purpose: the engine asks `getUserId()` who is signed in rather than reading
 * a session object, so nothing here depends on the shape of a supabase `Session`.
 */
export interface SyncDeps {
  getClient: () => SyncClient | null;
  getUserId: () => Promise<string | null>;
  onAuthChange?: (listener: () => void) => () => void;
}

/**
 * A `public.vehicles` row as pulled, parsed into the client's own vocabulary. `structural`
 * and `decode` are null when the server holds `'{}'::jsonb` — the shape a row created by
 * `apply_scan_event` has before its owner's `upsert_vehicle_meta` lands (§4.12).
 */
export interface RemoteVehicle {
  vin: string;
  unit: string | null;
  notes: string | null;
  /**
   * §4.9 `pc` on the server (migration 0002). Null both when nobody has typed one and when
   * the account has not been migrated yet — the same answer either way, and the honest one:
   * this device has not been told of a paint code.
   */
  paint: string | null;
  metaUpdatedAt: string;
  /**
   * The server's `structural` jsonb, or null when it holds `'{}'`. It is deliberately not
   * parsed into a `VinStructural`: §4.12 merges it by emptiness alone ("first non-empty
   * wins") and the client rebuilds the block from the 17 characters on every write and
   * every read, so the only thing this field can tell the merge is whether the account has
   * one at all. Parsing it would be a second, weaker definition of §4.1–§4.5.
   */
  structural: Record<string, unknown> | null;
  decode: VehicleDecode | null;
  firstScannedAt: string | null;
  lastScannedAt: string | null;
  scanCount: number;
  deletedAt: string | null;
  /** Server clock; the §5.8 pull cursor. */
  updatedAt: string;
}

/**
 * A `public.scan_events` row as pulled. `raw` (§5.2) has no column in §4.12 and never
 * leaves the device (N3), so an event that comes back from the account has none — which is
 * why the local log keeps its own row when it already holds one.
 */
export interface RemoteScanEvent {
  id: string;
  vin: string;
  at: string;
  symbology: string;
  checkDigitValid: boolean;
  deviceLabel: string | null;
  origin: string;
  /** Server clock; the §5.8 pull cursor. */
  insertedAt: string;
}
