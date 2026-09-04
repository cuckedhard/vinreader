/**
 * §9-S4's two account-level deletes, and nothing else: *Delete my cloud data* (the
 * `delete_my_data` RPC) and *Delete account* (the `delete-account` Edge Function). Both
 * names are locked by §4.12 and are spelled here exactly once.
 *
 * They live in the Account feature rather than in `src/lib/sync/` on purpose. The sync
 * engine is a loop over §5.7's queue; these are one-shot commands a person types DELETE to
 * authorise, they push nothing and pull nothing, and folding them into the engine would put
 * a destructive call inside a thing that runs by itself every five minutes.
 *
 * Every function tolerates `getSupabase()` returning null — the ordinary unconfigured state
 * — by refusing rather than throwing something the screen cannot describe (P7).
 */
import { getSupabase } from "../../lib/auth/client";
import { clearOutbox } from "../../lib/storage/outbox";
import { updateSettings } from "../../lib/storage/settings";
import { resetSyncState } from "../../lib/storage/syncState";
import { signOutClearDevice } from "../../lib/sync/signOut";

export class CloudDeleteError extends Error {}

const NO_CLIENT = "This build has no account service, so there is nothing to delete.";

function client() {
  const supabase = getSupabase();
  if (supabase === null) throw new CloudDeleteError(NO_CLIENT);
  return supabase;
}

/**
 * §4.12 `delete_my_data()` — the caller's rows in both tables, and nothing else. The account
 * itself survives; the user can keep using it.
 *
 * What happens locally afterwards is the interesting half. The records stay: N7's rule that
 * signing out never destroys local data without an explicit choice applies with more force
 * here, because the user asked to empty an *account*, not a phone. But two pieces of local
 * state are now lies and are cleared with it:
 *
 * - the §5.7 queue, whose rows would re-create on the next cycle exactly what was just
 *   deleted;
 * - the §5.8 cursor, which names a position in a history that no longer exists.
 *
 * And the §6.4 upload prompt is re-armed, because "add the records on this phone to your
 * account?" is precisely the question an emptied account raises next. Answering it is the
 * user's call, not this function's.
 */
export async function deleteCloudData(): Promise<void> {
  const { error } = await client().rpc("delete_my_data");
  if (error) throw new CloudDeleteError(error.message);
  await clearOutbox();
  await resetSyncState();
  await updateSettings({ uploadPromptDismissed: false });
}

/**
 * §9-S4 *Delete account*: the Edge Function, "then signs out and clears the device".
 *
 * The JWT is supabase-js's to attach — the function verifies it against the Auth server and
 * only then uses the service-role key, on the one id that token proved. The device wipe is
 * the same `signOutClearDevice` the sign-out path uses (§7 item 5: one wipe, one place), and
 * it runs only after the server has confirmed the deletion: clearing the phone first would
 * destroy the records for a request that then failed.
 *
 * Ending the *session* is the caller's next line — `signOut()` lives behind the auth
 * contract, and this module deliberately holds no session state.
 */
export async function deleteAccount(): Promise<void> {
  const { error } = await client().functions.invoke("delete-account", { method: "POST" });
  if (error) throw new CloudDeleteError(error.message);
  await signOutClearDevice();
}
