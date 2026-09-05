/**
 * Is §5 storage there at all?
 *
 * `useLiveQuery` cannot answer this, and that is the whole of F1-b. Dexie's `liveQuery`
 * filters `DatabaseClosedError` and `AbortError` out before calling `observer.error`
 * (dexie.mjs:6134), so when IndexedDB never opens — an enterprise policy, an opaque-origin
 * frame, a browser with no IndexedDB — the observable never emits and never fails: the hook
 * returns `undefined` forever, nothing throws, and `ErrorBoundary` is never reached. A
 * screen that reads `undefined` as "still loading" then waits for a row that is not coming.
 * At `/#/v/:vin` that was an entirely empty `<main>`: no heading, no message, no error.
 *
 * `db.open()` is the path that does report. It is also idempotent — every query opens the
 * database anyway — so asking costs nothing on a device where storage works.
 */
import { db } from "./db";

/**
 * The answer, as a discriminated union rather than "the reason, or null".
 *
 * A failure may legitimately carry no reason at all (a rejection with `undefined`, a thrown
 * `null`), and folding that into the same value as "storage is fine" would put the screen
 * back where F1-b found it: waiting on a database that already said no.
 */
export type StorageProbe = { readonly ok: true } | { readonly ok: false; readonly cause: unknown };

/**
 * Returned, never thrown: the caller is a screen deciding what to render, not a caller that
 * can fail. `open` is a parameter so the failure branch is testable in a runner whose
 * IndexedDB works, the way `startResendTicker` keeps `useAuth`'s rule out of its effect.
 */
export async function probeStorage(
  open: () => Promise<unknown> = () => db.open(),
): Promise<StorageProbe> {
  try {
    await open();
    return { ok: true };
  } catch (cause) {
    // P7: quietly in the log. The user's half is the caller's notice.
    console.error("VIN Relay: storage did not open", cause);
    return { ok: false, cause };
  }
}
