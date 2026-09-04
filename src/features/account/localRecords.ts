/**
 * §9-S4's first-sign-in merge, storage half: what "the N records on this phone" means, how
 * the question gets asked before it is too late to ask it, and what **Add** actually does.
 *
 * No React, no auth, no client — the Account screen calls these, and every one of them is a
 * plain Dexie operation that a node test can drive (`localRecords.test.ts`).
 */
import { db } from "../../lib/storage/db";
import { normalizeVehicle } from "../../lib/storage/normalize";
import { appendOutbox, vehicleMetaRow } from "../../lib/storage/outbox";
import { getSettings, updateSettings } from "../../lib/storage/settings";
import { getSyncEngine } from "../../lib/sync/engine";
import type { OutboxRow } from "../../lib/vin/types";

/**
 * "The records on this phone" — the ones the user can see. A tombstoned row (§5.1
 * `deletedAt`) is a record they deleted, and offering to upload it would be offering to
 * undo that.
 *
 * db.ts: IndexedDB does not index null, so live rows are absent from the `deletedAt` index
 * and "not deleted" can only be a JS filter.
 */
export async function countLocalRecords(): Promise<number> {
  return db.vehicles.filter((row) => row.deletedAt === null).count();
}

/**
 * Turn the push gate off **before** a session exists, when this device owes the user the
 * §6.4 question.
 *
 * This is the whole reason the prompt can mean anything. §5.6 defaults `syncEnabled` to
 * true and §5.7's outbox has been filling since the first scan, signed in or not — so the
 * engine's first cycle after sign-in would push every queued row *while the prompt is still
 * on screen*, and **Not now** would be a button that undoes nothing. §5.6's own note says
 * it: "Not now therefore has to stop the push, not discard the rows."
 *
 * So the Account screen calls this on the line before `verifyCode`, and the answer to the
 * prompt is what turns the gate back on. Returns whether a prompt is owed.
 *
 * A sign-in that then fails leaves the gate off, which costs nothing: nothing pushes while
 * signed out, and the next successful sign-in still owes the same question.
 */
export async function armUploadPrompt(): Promise<boolean> {
  const settings = await getSettings();
  if (settings.uploadPromptDismissed) return false;
  if ((await countLocalRecords()) === 0) return false;
  if (settings.syncEnabled) await updateSettings({ syncEnabled: false });
  return true;
}

/**
 * §6.4's **Not now**: the answer is remembered, the gate stays shut, and not one row is
 * discarded. §6.2's "Add N local records" is the way back.
 */
export async function declineUpload(): Promise<void> {
  await updateSettings({ syncEnabled: false, uploadPromptDismissed: true });
}

/**
 * §6.4's **Add**, and §6.2's "Add N local records" — the same action, because §9-S4 gives
 * them the same result: everything on this phone goes through the outbox.
 *
 * Usually there is nothing to queue. Every local write since S4 appended its own §5.7 rows,
 * so on a first sign-in the queue already holds the scans and the meta for all of it, and
 * this is a flag and a nudge. The exception is the one §9-S4 built this button for: signing
 * out with "keep this phone's records" clears the queue (`signOutKeepRecords`) and leaves
 * the records, so on the next sign-in — very possibly a different account — the records
 * exist and nothing is queued for them. `signOut.ts` names this file's job in as many
 * words: "Add N local records on the Account screen re-queues them for the new account."
 *
 * One `vehicle_meta` row per record that has none, and never a second for a VIN already
 * queued — a duplicate would be merged away server-side by `upsert_vehicle_meta` and cost a
 * round trip to learn nothing. The three aggregates (§4.12: `scan_count`,
 * `first_scanned_at`, `last_scanned_at`) are not pushed and never could be; they are derived
 * from `scan_events`, and a record whose events were cleared with the queue reaches the
 * account through `upsert_vehicle_meta` alone. The receiving device falls back to the meta
 * clock for its scan dates (`mergeVehicle`), which is the honest answer to "when was this
 * scanned" for a row whose events this account never saw.
 *
 * Returns how many rows were queued, so the screen can say something true afterwards.
 */
export async function addLocalRecords(): Promise<number> {
  const currentYear = new Date().getFullYear();

  const queued = await db.transaction("rw", db.vehicles, db.outbox, async () => {
    const pending = await db.outbox.where("kind").equals("vehicle_meta").toArray();
    const alreadyQueued = new Set(pending.map((row) => row.vin));

    const rows: OutboxRow[] = [];
    await db.vehicles.each((record) => {
      if (record.deletedAt !== null) return;
      if (alreadyQueued.has(record.vin)) return;
      // P7: a row an older build or a partial pull left unreadable costs that row, not the
      // whole upload. `normalizeVehicle` rebuilds §4.1–§4.5 and returns null for a VIN that
      // is not one.
      const normalized = normalizeVehicle(record, currentYear);
      if (normalized === null) return;
      rows.push(vehicleMetaRow(normalized));
    });

    if (rows.length > 0) await appendOutbox(rows);
    return rows.length;
  });

  // After the queue, never before: the gate opening is what lets the engine send, and it
  // should find everything already there. `updateSettings` owns the settings table, which
  // is deliberately not in the transaction above.
  await updateSettings({ syncEnabled: true, uploadPromptDismissed: true });

  // §4.12 pulls and pushes on its own triggers; this is just the nearest one. The engine is
  // absent in a build with no sync started at all, and the rows keep until it is.
  getSyncEngine()?.trigger();

  return queued;
}
