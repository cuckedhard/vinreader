/**
 * §4.10's `SyncStatus`, and the snapshot the §6.4 chip renders from.
 *
 * This file computes the value; it renders nothing. §6.4 fixes the copy — *"Synced"* /
 * *"3 pending"* / *"Offline — will sync"* / *"Sync error — tap for details"* — and the chip
 * lives on History and the Sheet (§6.2), which are screens, not this slice's business.
 */
import type { SyncStatus } from "../vin/types";

export interface SyncSnapshot {
  status: SyncStatus;
  /** §5.7: "pending count = number of rows; it drives the sync chip". */
  pending: number;
  /** §5.8's `lastError`, for *"tap for details"*. */
  lastError: string | null;
  lastPushAt: string | null;
  lastPullAt: string | null;
}

export interface SyncStatusInput {
  signedIn: boolean;
  online: boolean;
  syncing: boolean;
  pending: number;
  lastError: string | null;
}

/**
 * The order of these tests is the whole rule, and each step answers a question the ones
 * below it cannot:
 *
 * 1. **signed out** — N7's normal state, and the only one where the account is not a fact
 *    about this device at all. It outranks a queued row: rows accumulate signed out (they
 *    are what "Add N local records" later pushes), and a chip reading *"3 pending"* to a
 *    user who has never signed in would be describing an account they do not have.
 * 2. **syncing** — a request is out right now.
 * 3. **offline** — the radio decides everything after it, so a stale error or a queue that
 *    cannot move is not news; *"Offline — will sync"* is. Note that this reports `offline`
 *    even with an empty queue and no error: *"Synced"* would be a claim about the account,
 *    and an offline device cannot know whether another phone changed something a minute ago
 *    (N2 — never show a guess as a fact).
 * 4. **error** — the last attempt failed while online. It outranks `pending` because the
 *    count alone would say "waiting", which is the one thing a failing queue is not.
 * 5. **pending** — rows queued, online, nothing wrong.
 * 6. **synced**.
 *
 * §5.6's `syncEnabled` is deliberately *not* an input. §4.10's enum has no member for
 * "sync is switched off", and inventing one is a locked-enum change (NEEDS-ZACH); a device
 * with sync off and rows queued is honestly described as `pending` — they are pending, and
 * turning sync back on sends them.
 */
export function computeSyncStatus(input: SyncStatusInput): SyncStatus {
  if (!input.signedIn) return "signed_out";
  if (input.syncing) return "syncing";
  if (!input.online) return "offline";
  if (input.lastError !== null) return "error";
  if (input.pending > 0) return "pending";
  return "synced";
}

/** Two snapshots that would render identically. Lets the store keep one object identity. */
export function sameSnapshot(a: SyncSnapshot, b: SyncSnapshot): boolean {
  return (
    a.status === b.status &&
    a.pending === b.pending &&
    a.lastError === b.lastError &&
    a.lastPushAt === b.lastPushAt &&
    a.lastPullAt === b.lastPullAt
  );
}

export const IDLE_SNAPSHOT: SyncSnapshot = {
  status: "signed_out",
  pending: 0,
  lastError: null,
  lastPushAt: null,
  lastPullAt: null,
};
