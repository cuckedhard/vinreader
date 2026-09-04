/**
 * The sync engine: §4.12's triggers, wired to one serialized cycle of push → pull.
 *
 * **It is never on the scan path** (N7, P1). Nothing in `src/lib/storage` imports this
 * file; the write paths append an outbox row and return. The engine reads that queue on its
 * own schedule, in the background, and a device that is signed out, unconfigured, offline
 * or has sync switched off runs the whole cycle without making a single request.
 *
 * **One cycle at a time.** §4.12 lists seven things that ask for a pull — app start,
 * sign-in, `online`, the tab becoming visible, a realtime notification, every 5 minutes
 * while visible, and every successful push — and on a phone coming back into signal several
 * of them fire within the same second. They collapse into one run, with a single re-run
 * queued behind it so that a trigger arriving mid-cycle is answered rather than dropped.
 *
 * **The cursor belongs to an account.** When the signed-in user changes inside a session,
 * §5.8's cursor is reset before anything is pulled: it names a position in one account's
 * history, and reusing it would start the next account's first pull partway through. One
 * account handing straight over to another also clears the queue, for the reason spelled
 * out at that line — §5.7's rows carry no owner.
 */
import { db, nowIso } from "../storage/db";
import { clearOutbox, pendingCount } from "../storage/outbox";
import { getSettings } from "../storage/settings";
import { getSyncState, resetSyncState, updateSyncState } from "../storage/syncState";
import { pullOnce } from "./pull";
import { pushOutbox } from "./push";
import { subscribeVehicleChanges } from "./realtime";
import { IDLE_SNAPSHOT, computeSyncStatus, sameSnapshot, type SyncSnapshot } from "./status";
import type { SyncDeps } from "./types";

/** §4.12: "every 5 min while visible". */
export const SYNC_POLL_MS = 300_000;

export interface SyncEngineOptions {
  pollMs?: number;
  /** §4.4's cap; injected so a test is not tied to the wall clock. */
  currentYear?: number;
}

export interface SyncEngine {
  /** Wire §4.12's triggers and run one cycle. Idempotent. */
  start(): void;
  /** Unwire everything, including the realtime channel. A cycle in flight finishes. */
  stop(): void;
  /** Ask for a cycle. Collapses into one already running. */
  trigger(): void;
  /** One cycle, awaited — what the tests and the Account screen's manual actions use. */
  sync(): Promise<SyncSnapshot>;
  getSnapshot(): SyncSnapshot;
  /** For `useSyncExternalStore`: the snapshot object changes identity only when it differs. */
  subscribe(listener: () => void): () => void;
}

/** No `navigator` is not a browser refusing to connect; only an explicit `false` is offline. */
function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/** Same reasoning: no `document` means nothing is hiding the app. */
function isVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function windowTarget(): EventTarget | null {
  return typeof window === "undefined" ? null : window;
}

function documentTarget(): EventTarget | null {
  return typeof document === "undefined" ? null : document;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSyncEngine(deps: SyncDeps, options: SyncEngineOptions = {}): SyncEngine {
  const pollMs = options.pollMs ?? SYNC_POLL_MS;

  let snapshot: SyncSnapshot = IDLE_SNAPSHOT;
  const listeners = new Set<() => void>();

  let started = false;
  let halted = false;
  let rerun = false;
  let syncing = false;
  let inFlight: Promise<SyncSnapshot> | null = null;

  let teardown: Array<() => void> = [];
  let stopRealtime: (() => void) | null = null;
  let realtimeUser: string | null = null;

  /**
   * `undefined` means "this engine has not looked yet", which is not the same as "signed
   * out". Only a change *within* a session resets the cursor: resetting on the first look
   * would re-pull the entire account on every app start, and the sign-out paths
   * (`signOut.ts`) already reset it when the session actually ends.
   */
  let knownUser: string | null | undefined = undefined;

  function publish(next: SyncSnapshot): void {
    if (sameSnapshot(snapshot, next)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }

  async function snapshotFrom(signedIn: boolean): Promise<SyncSnapshot> {
    const [pending, state] = await Promise.all([pendingCount(), getSyncState()]);
    return {
      status: computeSyncStatus({
        signedIn,
        online: isOnline(),
        syncing,
        pending,
        lastError: state.lastError,
      }),
      pending,
      lastError: state.lastError,
      lastPushAt: state.lastPushAt,
      lastPullAt: state.lastPullAt,
    };
  }

  /**
   * The failure a queued row is still carrying, if any.
   *
   * Without this, a cycle that runs while every failed row is waiting out its backoff finds
   * nothing due, pushes nothing, pulls cleanly, and clears §5.8's `lastError` — so the §6.4
   * chip drops from *"Sync error — tap for details"* to *"1 pending"* seconds after the
   * failure, while the row is still stuck. The queue is where the truth about that lives
   * (§5.7 gives every row its own `lastError`), so it is what gets asked.
   */
  async function queuedFailure(): Promise<string | null> {
    const rows = await db.outbox.toArray();
    let worst: { attempts: number; lastError: string } | null = null;
    for (const row of rows) {
      if (typeof row.lastError !== "string") continue;
      const attempts = typeof row.attempts === "number" ? row.attempts : 0;
      if (worst === null || attempts > worst.attempts)
        worst = { attempts, lastError: row.lastError };
    }
    return worst?.lastError ?? null;
  }

  function dropRealtime(): void {
    stopRealtime?.();
    stopRealtime = null;
    realtimeUser = null;
  }

  async function runOnce(): Promise<void> {
    const client = deps.getClient();
    // A build with no Supabase env vars never asks who is signed in: there is no session to
    // ask about, and the answer would not change what happens next.
    const userId = client === null ? null : await deps.getUserId();

    if (knownUser !== undefined && knownUser !== userId) {
      // Signed out, or signed in as someone else. Either way the cursor and the realtime
      // channel belong to the previous account.
      await resetSyncState();
      dropRealtime();
      // One account handing straight over to another, without passing through §9-S4's
      // sign-out. §5.7's rows carry no owner, so a row queued under the first account is
      // indistinguishable from one queued under the second — and pushing it would move one
      // person's VIN history into another person's account (N3). §9-S4 already answers this
      // for the deliberate path ("keep this phone's records" clears the queue and leaves
      // the records); this is that same answer for the path that skipped the screen.
      //
      // Deliberately *not* done for the other two transitions: signing out (the session may
      // simply have expired, and those rows still belong to the account the user is about to
      // return to) and signing in from signed out (those rows are exactly what "Add N local
      // records" exists to send). The gap this cannot close is a reload between the two
      // accounts, which takes `knownUser` with it — see the session report.
      if (knownUser !== null && userId !== null) await clearOutbox();
    }
    knownUser = userId;

    if (client === null || userId === null) {
      dropRealtime();
      publish(await snapshotFrom(false));
      return;
    }

    // §5.6. Sync switched off leaves the outbox filling — rows are never discarded — and
    // sends nothing until it is switched back on.
    const settings = await getSettings();
    if (!settings.syncEnabled) {
      dropRealtime();
      publish(await snapshotFrom(true));
      return;
    }

    if (!isOnline()) {
      publish(await snapshotFrom(true));
      return;
    }

    // §4.12: the notification is a signal to pull, so the channel is established as soon as
    // there is a session to filter by — not after the first successful push.
    if (realtimeUser !== userId) {
      dropRealtime();
      stopRealtime = subscribeVehicleChanges(client, userId, () => {
        trigger();
      });
      realtimeUser = userId;
    }

    syncing = true;
    publish(await snapshotFrom(true));
    try {
      const push = await pushOutbox({ client, userId });
      if (push.pushed > 0) await updateSyncState({ lastPushAt: nowIso() });

      // A push that stopped because the request never got an answer has just proved the
      // network is not there; a pull would spend one more failed request to learn the same
      // thing. Every other outcome still pulls — §4.12 pulls on the trigger, not only on a
      // clean push, and a row the server rejected says nothing about what other devices did.
      const pull =
        push.stopped === "transport"
          ? { error: push.error }
          : await pullOnce({ client, currentYear: options.currentYear });

      // One `lastError` field, and the push's failure outlives a clean pull: rows that did
      // not reach the account are the thing the §6.4 chip has to keep saying — including
      // when this particular cycle sent nothing because they are all still backing off.
      const error = pull.error ?? push.error ?? (await queuedFailure());
      await updateSyncState({ lastError: error });
    } finally {
      syncing = false;
    }

    publish(await snapshotFrom(true));
  }

  async function loop(): Promise<SyncSnapshot> {
    try {
      do {
        rerun = false;
        try {
          await runOnce();
        } catch (error) {
          // P7: a cycle never throws into a trigger. Whatever failed — storage, a client
          // that threw rather than returning an error — is recorded and retried by the next
          // trigger; the app keeps scanning either way (N7).
          try {
            await updateSyncState({ lastError: message(error) });
            publish(await snapshotFrom(typeof knownUser === "string"));
          } catch {
            // Storage itself is gone. There is nothing left to record it with.
          }
        }
        // A trigger that arrived mid-cycle is answered rather than dropped — one re-run,
        // however many arrived. `halted` is the only thing that ends this: a cycle whose
        // own push woke the realtime channel would otherwise re-run once and stop, which
        // is exactly what it does, because that re-run pushes nothing and wakes nothing.
      } while (rerun && !halted);
    } finally {
      inFlight = null;
    }
    return snapshot;
  }

  /**
   * One cycle, and the promise every caller of it can await — including a caller that
   * arrived while one was already running. Handing such a caller the *current* snapshot
   * instead would be a lie in the one place it matters: "Sync now" on the Account screen,
   * and every test, would read the state from before their own request was answered.
   */
  function cycle(): Promise<SyncSnapshot> {
    if (inFlight !== null) {
      rerun = true;
      return inFlight;
    }
    inFlight = loop();
    return inFlight;
  }

  function trigger(): void {
    void cycle().catch(() => {
      // `loop` swallows everything it can record; this is the last resort so that a
      // trigger is never an unhandled rejection.
    });
  }

  function start(): void {
    if (started) return;
    started = true;
    halted = false;

    const onOnline = (): void => trigger();
    const onVisible = (): void => {
      if (isVisible()) trigger();
    };
    const onTick = (): void => {
      // §4.12: "every 5 min while visible".
      if (isVisible()) trigger();
    };

    const win = windowTarget();
    const doc = documentTarget();
    win?.addEventListener("online", onOnline);
    doc?.addEventListener("visibilitychange", onVisible);
    const interval = setInterval(onTick, pollMs);
    const unwireAuth = deps.onAuthChange?.(() => {
      trigger();
    });

    teardown = [
      () => win?.removeEventListener("online", onOnline),
      () => doc?.removeEventListener("visibilitychange", onVisible),
      () => clearInterval(interval),
      () => unwireAuth?.(),
    ];

    trigger();
  }

  /**
   * Unwire everything, whether or not `start` was ever called: a `sync()` on its own also
   * opens the realtime channel (that is where the user id is known), so gating the teardown
   * on `started` would leak a subscription for every engine driven by hand — the Account
   * screen's manual sync, and every test. Idempotent, and a cycle already in flight is left
   * to finish; what stops is the re-run and every trigger after it.
   */
  function stop(): void {
    started = false;
    halted = true;
    for (const undo of teardown) undo();
    teardown = [];
    dropRealtime();
  }

  return {
    start,
    stop,
    trigger,
    sync: cycle,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * The app's one engine. `main.tsx` starts it; the §6.4 chip reads it. A module-level holder
 * rather than a context because there is exactly one queue and one cursor on a device, and
 * a second engine would push the same rows twice.
 */
let engine: SyncEngine | null = null;

export function startSync(deps: SyncDeps, options?: SyncEngineOptions): SyncEngine {
  engine ??= createSyncEngine(deps, options);
  engine.start();
  return engine;
}

export function getSyncEngine(): SyncEngine | null {
  return engine;
}

/** Tear the singleton down — the sign-out paths, and every test that starts one. */
export function stopSync(): void {
  engine?.stop();
  engine = null;
}
