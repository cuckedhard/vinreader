/**
 * The one place the sync engine and `src/lib/auth/` meet.
 *
 * The engine takes `getClient`, `getUserId` and `onAuthChange` as dependencies and imports
 * none of them, which is what lets every test drive it signed in, signed out or
 * unconfigured without a session existing — and what keeps `@supabase/supabase-js` out of
 * the module graph of everything under `src/lib/storage` (N7: a scan never waits on a
 * session, and nothing on the write path can, because none of it can even see one).
 *
 * This module is the exception, and it is three lines of glue. `main.tsx` calls
 * `startAppSync()`; nothing else imports it.
 */
import { getSupabase } from "../auth/client";
import { getUserId, onAuthChange } from "../auth/session";
import { createSyncEngine, startSync, type SyncEngine, type SyncEngineOptions } from "./engine";
import type { SyncDeps } from "./types";

/**
 * The three contract functions, in the shape the engine takes them.
 *
 * `onAuthChange` hands its listener the new user id; the engine does not want it — it asks
 * `getUserId()` inside the cycle instead, so what it acts on is who is signed in *now*
 * rather than who was signed in when the event fired.
 */
export function appSyncDeps(): SyncDeps {
  return {
    getClient: () => getSupabase(),
    getUserId,
    onAuthChange: (listener) => onAuthChange(() => listener()),
  };
}

/** Start the app's engine (§4.12's triggers). Safe to call when there is no Supabase. */
export function startAppSync(options?: SyncEngineOptions): SyncEngine {
  return startSync(appSyncDeps(), options);
}

/** The same engine, built but not started — for a caller that wires its own lifecycle. */
export function createAppSyncEngine(options?: SyncEngineOptions): SyncEngine {
  return createSyncEngine(appSyncDeps(), options);
}
