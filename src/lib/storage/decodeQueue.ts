/**
 * §5.4 decode queue. Pending rows are retried on app start, on the "online" event, and
 * every 60 s while the app is visible and online — serial, oldest first, one request at
 * a time.
 *
 * §4.7 governs what may be requested at all: **one request per VIN ever**, because the
 * cache is permanent. A row that reached `ok`, `partial` or `unsupported` is therefore
 * never re-requested by anything here, and `refreshDecode` — the sheet's "Refresh
 * details" button — is the only path that goes back to the network for a VIN.
 *
 * Not pure: it reads IndexedDB and drives the network client. Everything the vPIC client
 * needs to be deterministic still arrives through `VpicDeps` (P3 keeps `src/lib/vin` and
 * `src/lib/payload` clean; storage is allowed I/O).
 */
import type { VehicleDecode, WmiRecord } from "../vin/types";
import { wmiFromVin } from "../vin/wmi";
import { decodeVin } from "../vpic/client";
import type { VpicDeps, VpicResult } from "../vpic/types";
import { db, nowIso } from "./db";
import { getSettings } from "./settings";

/** §5.4. The tenth failure takes a row out of the automatic queue; Refresh still retries it. */
export const DECODE_MAX_ATTEMPTS = 10;

/** §5.4. The visible-and-online poll interval. */
export const DECODE_POLL_MS = 60000;

/**
 * `navigator.onLine` is absent outside a browser, and a missing signal must not stall
 * decoding forever, so only an explicit `false` counts as offline.
 */
function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/** Same reasoning as `isOnline`: no `document` means nothing is hiding the app. */
function isVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/**
 * The "online" event fires on `window`. In a worker or a test there is none, so the queue
 * runs with its other two triggers rather than throwing on the way up.
 */
function eventTarget(): EventTarget | null {
  return typeof window === "undefined" ? null : window;
}

/**
 * §5.4. A terminal result lands the answer and leaves `attempts` where it is — that
 * counter measures transport failures, not successes. A `pending` result spends one
 * attempt, and the tenth flips the row to `failed` (§4.10 enum, no new members).
 */
function nextDecode(current: VehicleDecode, result: VpicResult, at: string): VehicleDecode {
  if (result.status !== "pending") {
    return {
      ...current,
      status: result.status,
      fields: result.fields,
      fetchedAt: at,
      lastError: null,
    };
  }

  const attempts = current.attempts + 1;
  return {
    ...current,
    status: attempts >= DECODE_MAX_ATTEMPTS ? "failed" : "pending",
    attempts,
    lastError: result.lastError,
  };
}

/**
 * §5.5. vPIC's `Manufacturer` is authoritative over the compiled-in seed, so a decode
 * that carries one refreshes the WMI cache. Every terminal status qualifies: a `partial`
 * or off-highway `unsupported` answer can still name the manufacturer, and that is the
 * least model-specific field vPIC returns. An empty one writes nothing — an empty cache
 * row is worse than none.
 */
function wmiRowFrom(vin: string, fields: Record<string, string>, at: string): WmiRecord | null {
  const manufacturer = fields.Manufacturer?.trim();
  if (!manufacturer) return null;
  const make = fields.Make?.trim();
  return {
    wmi: wmiFromVin(vin),
    manufacturer,
    make: make ? make : null,
    source: "vpic",
    updatedAt: at,
  };
}

/**
 * Write one decode outcome onto the vehicles row, and the WMI cache alongside it.
 * A missing row is not an error: the record can be deleted while its decode is in flight.
 */
export async function applyDecodeResult(vin: string, result: VpicResult): Promise<void> {
  const at = nowIso();
  const wmiRow = result.status === "pending" ? null : wmiRowFrom(vin, result.fields, at);

  await db.transaction("rw", db.vehicles, db.wmi, async () => {
    const existing = await db.vehicles.get(vin);
    if (!existing) return;
    await db.vehicles.put({ ...existing, decode: nextDecode(existing.decode, result, at) });
    if (wmiRow) await db.wmi.put(wmiRow);
  });
}

/**
 * §4.7's one request per VIN is spent by whichever pass reads the row first, so the
 * in-flight guard belongs to the queue itself and not to one caller's closure: §5.4's
 * triggers and the write paths' kick are separate entry points into the same queue, and a
 * guard a caller can go around is not a guard.
 */
let passInFlight = false;

/**
 * One pass of the §5.4 queue. Returns how many rows it processed — 0 when offline, 0 when
 * nothing is eligible, and 0 when a pass is already running. Only `pending` rows are
 * eligible: terminal rows are spent under §4.7's one-request rule, and `failed` rows wait
 * for Refresh details.
 */
export async function runDecodeQueueOnce(deps: VpicDeps = {}): Promise<number> {
  // Two overlapping passes read the same rows and each requests the same VIN — §4.7's
  // budget spent twice, and on a dead radio two of §5.4's ten attempts for one round of
  // no signal. Claimed before the first await, or both callers pass this check.
  if (passInFlight) return 0;
  if (!isOnline()) return 0;
  passInFlight = true;

  try {
    const pending = await db.vehicles.where("decode.status").equals("pending").toArray();
    // A tombstoned record still holds a row (§4.12); spending its one permanent request
    // would waste it. A later scan clears the tombstone and leaves the row pending, so it
    // rejoins the queue then.
    const queue = pending.filter((row) => row.deletedAt === null);
    // §5.1 offset timestamps do not sort as strings, so oldest-first compares instants.
    queue.sort((a, b) => Date.parse(a.firstScannedAt) - Date.parse(b.firstScannedAt));

    let processed = 0;
    for (const row of queue) {
      // Serial by §5.4, and re-checked each turn so a run stops the moment the device
      // drops off signal rather than burning attempts against a dead radio.
      if (!isOnline()) break;
      await applyDecodeResult(row.vin, await decodeVin(row.vin, deps));
      processed += 1;
    }
    return processed;
  } finally {
    // A pass that threw releases the queue: §5.4's poll is the only thing that retries a
    // pending decode, so a stuck flag would strand every unfilled sheet for the session.
    passInFlight = false;
  }
}

/**
 * The seam every write path ends on: a save while online fills the sheet in without
 * waiting out §5.4's 60 s poll. The scan (§6.3) and the import confirm (§9-S3) both come
 * through here, so §5.6's `autoDecode` choice is read in one place and neither path can
 * drift from the other. It kicks the *queue*, not one VIN, because the queue is what
 * honours §4.7: re-saving an already-decoded VIN must not go back to the network.
 *
 * N1: no caller awaits this and it never throws — whatever it misses, §5.4 retries.
 */
export async function kickDecodeQueue(deps: VpicDeps = {}): Promise<void> {
  try {
    // A settings read that fails is not a reason to decode against the user's choice;
    // the row stays pending and the poll picks it up.
    const settings = await getSettings();
    if (!settings.autoDecode) return;
    await runDecodeQueueOnce(deps);
  } catch {
    // A decode never surfaces as a save error: the record is already stored.
  }
}

/**
 * The sheet's "Refresh details" (§4.7). The one path allowed to re-request a VIN, whatever
 * its current status — `ok` and `failed` included. Attempts reset first so a transient
 * failure puts the row back in the normal queue instead of leaving it failed on one miss.
 * Existing fields stay on screen while the request is out; only the status moves.
 */
export async function refreshDecode(vin: string, deps: VpicDeps = {}): Promise<void> {
  const armed = await db.transaction("rw", db.vehicles, async () => {
    const existing = await db.vehicles.get(vin);
    if (!existing) return false;
    await db.vehicles.put({
      ...existing,
      decode: { ...existing.decode, status: "pending", attempts: 0, lastError: null },
    });
    return true;
  });
  if (!armed) return;

  await applyDecodeResult(vin, await decodeVin(vin, deps));
}

/**
 * Wire the three §5.4 triggers and hand back the teardown. A run already in flight absorbs
 * every further trigger: `runDecodeQueueOnce` turns it away on `passInFlight`, so a slow
 * response cannot let the poll and the "online" event fan out into concurrent requests for
 * the same VIN, which §4.7 forbids outright.
 */
export function startDecodeQueue(deps: VpicDeps = {}): () => void {
  let stopped = false;

  const trigger = (): void => {
    if (stopped) return;
    void runDecodeQueueOnce(deps).catch(() => {
      // A storage failure must not kill the interval; the next trigger tries again.
    });
  };

  const onOnline = (): void => trigger();
  const onTick = (): void => {
    if (isVisible() && isOnline()) trigger();
  };

  const target = eventTarget();
  target?.addEventListener("online", onOnline);
  const interval = setInterval(onTick, DECODE_POLL_MS);

  trigger();

  return () => {
    stopped = true;
    target?.removeEventListener("online", onOnline);
    clearInterval(interval);
  };
}
