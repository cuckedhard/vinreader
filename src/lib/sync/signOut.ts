/**
 * §9-S4's two ways out, storage half.
 *
 * *"Keep the records on this phone?"* → **Keep** leaves Dexie exactly as it is and clears
 * the outbox; **Clear this phone** wipes Dexie. Neither touches the session — ending that
 * is `supabase.auth.signOut()`, which lives behind the auth contract and is the Account
 * screen's call to make. Splitting it this way is what keeps this module free of
 * `@supabase/supabase-js` and free of any await on a session (N7).
 *
 * Order matters at the call site, and only in one direction: stop the sync engine first.
 * A push that is mid-flight when the queue is cleared would remove rows it has already
 * accepted — harmless — but a push that starts *after* the session ends would fail every
 * batch and spend an attempt on each. `SyncEngine.stop()` then one of these, then the auth
 * sign-out.
 */
import { clearOutbox } from "../storage/outbox";
import { clearAllData } from "../storage/settings";
import { resetSyncState } from "../storage/syncState";

/**
 * **Keep this phone's records.** The records stay; the queue does not.
 *
 * §5.7's rows are addressed to the account that was signed in when they were written, and
 * pushing them into whoever signs in next would move one user's VIN history into another
 * user's account. §9-S4 provides the way back for the records themselves: "Add N local
 * records" on the Account screen re-queues them for the new account, deliberately, by the
 * user's own action (N3).
 *
 * The §5.8 cursor goes with it. It names a position in one account's history, so keeping it
 * would start the next account's first pull partway through and silently skip everything
 * before it.
 */
export async function signOutKeepRecords(): Promise<void> {
  await clearOutbox();
  await resetSyncState();
}

/**
 * **Clear this phone.** Every table, and the settings row back at §5.6's defaults — the
 * same wipe §6.2's "Clear all data" performs, reused rather than restated so the two can
 * never drift (§7 item 5). The §9-S4 check is that nothing is left: no records, no queue,
 * no cursor, no device label.
 *
 * `clearAllData` empties `syncState` along with everything else; the reset that follows
 * puts the row back at its defaults rather than leaving the table empty, so the next read
 * finds the shape §5.8 describes instead of creating it.
 */
export async function signOutClearDevice(): Promise<void> {
  await clearAllData();
  await resetSyncState();
}
