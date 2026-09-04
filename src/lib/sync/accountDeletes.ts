/**
 * §9-S4's other two deletes: **Delete my cloud data** (the `delete_my_data` RPC) and
 * **Delete account** (the `delete-account` Edge Function). The third — soft-deleting one
 * vehicle — is `upsert.softDeleteVehicle` plus a `vehicle_delete` outbox row and is not
 * this file's business.
 *
 * Both names are locked by §4.12 and are spelled here exactly once.
 *
 * ## Why they live beside the engine and not inside it
 *
 * The engine is a loop over §5.7's queue that runs by itself every five minutes. These are
 * one-shot commands a person authorises by typing DELETE; they push nothing and pull
 * nothing. Folding them into the cycle would put an irreversible call inside a thing that
 * fires on a timer. They sit next to it because they have to *stop* it — see the order
 * below — and because the Account screen (§6.2) and Settings (§6.2's "Account" entry) are
 * both screens, so neither owns this.
 *
 * ## The order, and what each step buys
 *
 * `engine.stop()` → server → local → session. Same rule as the sign-outs (`signOut.ts`),
 * for the same reason: a push that starts *after* the account's rows are gone spends an
 * attempt on every batch, and §5.7 persists those attempts.
 *
 * `stop()` lets a cycle already in flight finish — that is the engine's documented
 * behaviour and there is no public way to await it — so one race survives: a batch that was
 * already on the wire when the RPC executed can insert `scan_events` a moment after the
 * delete, and `apply_scan_event` will rebuild a `vehicles` row from it. The window is the
 * length of one request and nothing on the client can close it. The answer is the one the
 * user already has: run it again. It is idempotent. Clearing §5.7 *before* the RPC would
 * shrink the window and is deliberately not done — a delete that then failed would have
 * destroyed rows that never reached the account, and losing a queued scan to a failed
 * delete is worse than deleting twice.
 *
 * ## Failure is most of this file (P7)
 *
 * The server half and the local half can fail independently, so every path returns which of
 * the two happened rather than throwing one undifferentiated error:
 *
 * | outcome                | server | local | what is left |
 * |---|---|---|---|
 * | `not_configured`       | —      | —     | nothing touched; this build has no account |
 * | `not_signed_in`        | —      | —     | nothing touched |
 * | `server_failed`        | failed | —     | nothing touched, sync running again |
 * | `done`                 | done   | done  | as intended |
 * | `done_local_incomplete`| done   | failed| the account is gone; this phone is behind |
 *
 * `serverDeleted` is the fact the copy must not get wrong (N2): once it is true the account
 * data is gone whatever else went wrong, and a screen that says "that didn't work" over a
 * completed deletion has told the user something false. The two supplied strings at the
 * bottom of this file are the route forward for the one row where that matters.
 *
 * Every function tolerates `getSupabase()` returning null — the ordinary unconfigured state
 * — and a signed-out device, by refusing without touching anything.
 */
import { getSupabase } from "../auth/client";
import { getUserId, signOut } from "../auth/session";
import type { AuthResult } from "../auth/session";
import { clearOutbox } from "../storage/outbox";
import { updateSettings } from "../storage/settings";
import { resetSyncState } from "../storage/syncState";
import { getSyncEngine } from "./engine";
import type { SyncEngine } from "./engine";
import { signOutClearDevice } from "./signOut";
import type { PostgrestErrorLike } from "./types";

/**
 * The narrow client surface these two commands call, and no wider — the same discipline
 * `SyncClient` follows in `types.ts`, so the fake the tests drive is exactly as hard to
 * satisfy as `@supabase/supabase-js`. `accountDeletes.test.ts` asserts at the type level
 * that a real `SupabaseClient` is one of these.
 */
export interface AccountDeleteClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: PostgrestErrorLike | null }>;
  functions: {
    invoke(
      name: string,
      options: { method: "POST" },
    ): PromiseLike<{ error: Error | null; response?: { status?: number } }>;
  };
}

/** What each command needs from the rest of the app. Injected so a test needs no session. */
export interface AccountDeleteDeps {
  getClient: () => AccountDeleteClient | null;
  getUserId: () => Promise<string | null>;
  getEngine: () => SyncEngine | null;
  endSession: () => Promise<AuthResult>;
}

export type AccountDeleteOutcome =
  "not_configured" | "not_signed_in" | "server_failed" | "done" | "done_local_incomplete";

export interface AccountDeleteResult {
  outcome: AccountDeleteOutcome;
  /** Whether the account data is gone. True is a point of no return, not an opinion. */
  serverDeleted: boolean;
  /** The underlying failure, for the log and the banner's detail line (P7). */
  message: string | null;
}

/**
 * §4.12's locked names, spelled once each.
 *
 * Exported because the tests assert on them: a rename here is a schema change, and a typo
 * would be a call that fails at the far end of a destructive confirmation.
 */
export const DELETE_MY_DATA_RPC = "delete_my_data";
export const DELETE_ACCOUNT_FUNCTION = "delete-account";

/**
 * This module is the second and last place under `src/lib/sync/` that reaches
 * `src/lib/auth/` — `authBridge.ts` is the other, and it says why the engine itself never
 * does. The difference is that nothing here runs on a write path or on a timer: every
 * function below exists because a person typed DELETE, so awaiting a session is exactly
 * what should happen (N7 forbids blocking a scan on auth, not blocking a deliberate
 * deletion).
 */
export function defaultAccountDeleteDeps(): AccountDeleteDeps {
  return {
    getClient: () => getSupabase(),
    getUserId,
    getEngine: getSyncEngine,
    endSession: signOut,
  };
}

/**
 * Something a person can be shown and a log can be read from. `cause.name` covers the
 * error that carries no message at all: "" would leave the §6.4 banner's detail line blank,
 * which reads as the app having nothing to say about a failure it just reported (P7).
 */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message || cause.name : String(cause);
}

function refuse(outcome: "not_configured" | "not_signed_in"): AccountDeleteResult {
  return { outcome, serverDeleted: false, message: null };
}

/**
 * An engine that throws on `stop()` or `start()` must not take a deletion down with it: the
 * command it guards is the one the user is standing there waiting for, and a dead engine is
 * a sync problem, not a delete problem. The failure is returned so the caller can carry it
 * in `message` (P7 — quiet in the log, never silent).
 */
function haltEngine(engine: SyncEngine | null): string | null {
  try {
    engine?.stop();
    return null;
  } catch (cause) {
    return messageOf(cause);
  }
}

function resumeEngine(engine: SyncEngine | null): string | null {
  try {
    engine?.start();
    return null;
  } catch (cause) {
    return messageOf(cause);
  }
}

/**
 * The HTTP status behind an Edge Function failure, when the library exposes one.
 *
 * `FunctionsHttpError`'s own `message` is the same sentence for a 401 and a 500 ("Edge
 * Function returned a non-2xx status code"), which is no use in a log a week later. The
 * status is read structurally, from the result's `response` first and the error's `context`
 * second, because both are optional in `@supabase/functions-js` and neither is worth an
 * `instanceof` against a class this file would otherwise never import.
 */
function httpStatus(error: Error, response: { status?: number } | undefined): number | null {
  if (typeof response?.status === "number") return response.status;
  const context = (error as { context?: { status?: unknown } }).context;
  return typeof context?.status === "number" ? context.status : null;
}

function edgeMessage(error: Error, response: { status?: number } | undefined): string {
  const status = httpStatus(error, response);
  const text = messageOf(error);
  return status === null ? text : `${text} (HTTP ${status})`;
}

/**
 * **Delete my cloud data** — §4.12's `delete_my_data()`: every `scan_events` and `vehicles`
 * row belonging to the caller, and nothing else. The account itself survives and the user
 * stays signed in.
 *
 * What happens on the device afterwards is the half worth arguing about. **The records
 * stay.** N7's rule that nothing local is destroyed without an explicit choice applies with
 * more force here than anywhere: the user asked to empty an *account*, and §6.4's sentence
 * promises exactly that — "removes your VIN history from your account on every device". Two
 * pieces of local state are lies the moment the RPC returns, and go with it:
 *
 * - §5.7's queue, whose rows would re-create on the next cycle precisely what was deleted;
 * - §5.8's cursor, which names a position in a history that no longer exists.
 *
 * `syncEnabled` is deliberately left alone — emptying an account is not switching sync off,
 * and a device that silently stopped syncing after this would be the next bug report. The
 * §6.4 upload prompt is re-armed instead (`uploadPromptDismissed: false`): "Add the N
 * records on this phone to your account?" is the exact question an emptied account raises,
 * and §6.2's "Add N local records" is the answer available immediately.
 */
export async function deleteCloudData(
  overrides: Partial<AccountDeleteDeps> = {},
): Promise<AccountDeleteResult> {
  const deps = { ...defaultAccountDeleteDeps(), ...overrides };

  const client = deps.getClient();
  if (client === null) return refuse("not_configured");
  if ((await deps.getUserId()) === null) return refuse("not_signed_in");

  const engine = deps.getEngine();
  const haltError = haltEngine(engine);

  let failure: string | null = null;
  try {
    const { error } = await client.rpc(DELETE_MY_DATA_RPC, {});
    if (error !== null) failure = error.message;
  } catch (cause) {
    // A client that throws rather than answering — no signal, DNS gone, the request cut
    // off. Nothing was deleted; the account is intact.
    failure = messageOf(cause);
  }

  if (failure !== null) {
    // The account is untouched and the session is still good, so the engine goes back to
    // work: a failed delete must not leave the device silently unsynced.
    resumeEngine(engine);
    return { outcome: "server_failed", serverDeleted: false, message: failure };
  }

  try {
    await clearOutbox();
    await resetSyncState();
    await updateSettings({ uploadPromptDismissed: false });
  } catch (cause) {
    // The account is empty and this phone still holds a queue that would refill it. The
    // engine stays stopped on purpose — restarting it here is the one action that could
    // undo the deletion the user just made. A reload starts a clean one.
    return { outcome: "done_local_incomplete", serverDeleted: true, message: messageOf(cause) };
  }

  const resumeError = resumeEngine(engine);
  return { outcome: "done", serverDeleted: true, message: haltError ?? resumeError };
}

/**
 * **Delete account** — the `delete-account` Edge Function, which verifies the caller's JWT
 * and then deletes the auth user with the service-role key; the rows follow through the
 * `on delete cascade` on both foreign keys. §9-S4 then requires the rest: "signs out and
 * clears the device".
 *
 * The device is cleared only *after* the server has confirmed, never before — clearing
 * first would destroy the records for a request that then failed, and §6.4's sentence
 * promises the account, not the phone (the Account screen adds the sentence that says the
 * phone goes too; a user cannot consent to what they were not told).
 *
 * The wipe is `signOutClearDevice`, the same one both the sign-out path and §6.2's "Clear
 * all data" reach, so there is one wipe in the codebase and not three (§7 item 5). The
 * session is ended last and **unconditionally** — even when the wipe failed — because a
 * session pointing at a deleted user cannot refresh and would otherwise fail every request
 * the app makes for the rest of the tab's life.
 */
export async function deleteAccount(
  overrides: Partial<AccountDeleteDeps> = {},
): Promise<AccountDeleteResult> {
  const deps = { ...defaultAccountDeleteDeps(), ...overrides };

  const client = deps.getClient();
  if (client === null) return refuse("not_configured");
  if ((await deps.getUserId()) === null) return refuse("not_signed_in");

  const engine = deps.getEngine();
  const haltError = haltEngine(engine);

  let failure: string | null = null;
  try {
    const result = await client.functions.invoke(DELETE_ACCOUNT_FUNCTION, { method: "POST" });
    if (result.error !== null) failure = edgeMessage(result.error, result.response);
  } catch (cause) {
    failure = messageOf(cause);
  }

  if (failure !== null) {
    // The account still exists and the session is still valid. Nothing local has been
    // touched — the records are all still here — so sync goes back to work.
    resumeEngine(engine);
    return { outcome: "server_failed", serverDeleted: false, message: failure };
  }

  // Past this line the account is gone. The engine is never restarted: there is no account
  // left to sync with, and every cycle it ran would fail on a dead session.
  let localFailure: string | null = null;
  try {
    await signOutClearDevice();
  } catch (cause) {
    localFailure = messageOf(cause);
  }

  // Never throws (`session.ts` clears local state first and reports the rest), so its
  // failure is a detail rather than an outcome: the session is already unusable here.
  const ended = await deps.endSession();
  const sessionMessage = ended.ok ? null : (ended.message ?? ended.reason);

  if (localFailure !== null) {
    return { outcome: "done_local_incomplete", serverDeleted: true, message: localFailure };
  }
  return { outcome: "done", serverDeleted: true, message: sessionMessage ?? haltError };
}

/* ------------------------------------------------------- supplied copy (§0 rule 4) */

/**
 * §6.4 has one sentence for these deletes and it describes the *intent*, not the two ways
 * they can end half-done. These are the missing halves, named here rather than written into
 * JSX so the session report can list them and `harden` can find them. Neither blames the
 * user, and both end in something the user can actually do next (P7).
 */
export const CLOUD_DATA_DELETED_LOCAL_STALE =
  "Your account is empty. This phone couldn’t finish clearing what was waiting to upload — " +
  "reload the app, then run Delete my cloud data once more.";

export const ACCOUNT_DELETED_DEVICE_NOT_CLEARED =
  "The account is gone. This phone still holds its records — remove them with Clear all data " +
  "in Settings.";
