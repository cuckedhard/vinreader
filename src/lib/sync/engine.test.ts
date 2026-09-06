/**
 * The engine's triggers and its four "do nothing" states.
 *
 * N7 is the property most of these tests are about: signing in is optional and never a
 * gate, so a device that is signed out, unconfigured, has sync switched off, or has no
 * signal must run the whole cycle without making a request — and the local database must
 * come out of it unchanged. The write paths never call anything here, which is what keeps a
 * scan off the network entirely; these tests hold the other half of that line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../storage/db";
import { updateSettings } from "../storage/settings";
import { advanceCursors, getSyncState } from "../storage/syncState";
import { upsertVehicle } from "../storage/upsert";
import {
  SYNC_POLL_MS,
  createSyncEngine,
  getSyncEngine,
  startSync,
  stopSync,
  type SyncEngine,
  type SyncEngineOptions,
} from "./engine";
import { FakeServer, createFakeClient } from "./supabaseFake.testutil";
import type { SyncClient, SyncDeps } from "./types";

const VIN = "1HGCM82633A004352";
const VIN_B = "1FUJGLDR49SAV1234";
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const YEAR = 2026;

let server: FakeServer;
let client: SyncClient;
let userId: string | null;
/**
 * Every engine a test makes is stopped afterwards. Not housekeeping: an engine that is
 * still subscribed to its own fake server keeps cycling against the one shared Dexie
 * database, and the row it pushes or the `lastError` it clears belongs to the next test.
 */
const engines: SyncEngine[] = [];

beforeEach(async () => {
  await db.open();
  await Promise.all(db.tables.map((table) => table.clear()));
  server = new FakeServer();
  userId = USER;
  client = createFakeClient(server, () => userId);
});

afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
  stopSync();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function engineFor(overrides: Partial<SyncDeps> = {}, options: SyncEngineOptions = {}): SyncEngine {
  const engine = createSyncEngine(deps(overrides), { currentYear: YEAR, ...options });
  engines.push(engine);
  return engine;
}

function deps(overrides: Partial<SyncDeps> = {}): SyncDeps {
  return {
    getClient: () => client,
    getUserId: async () => userId,
    ...overrides,
  };
}

async function scan(vin = VIN): Promise<void> {
  await upsertVehicle({
    vin,
    origin: "scan",
    symbology: "code_39",
    raw: vin,
    checkDigitValid: true,
  });
}

describe("the states in which the engine makes no request (N7)", () => {
  it("does nothing, and never asks who is signed in, without a client", async () => {
    const getUserId = vi.fn(async () => USER);
    const engine = engineFor({ getClient: () => null, getUserId });
    await scan();

    const snapshot = await engine.sync();

    expect(getUserId).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(0);
    expect(snapshot.status).toBe("signed_out");
    expect(await db.outbox.count()).toBe(2);
  });

  it("does nothing while signed out, and keeps every queued row", async () => {
    userId = null;
    const engine = engineFor();
    await scan();

    const snapshot = await engine.sync();

    expect(server.requests).toHaveLength(0);
    expect(snapshot).toMatchObject({ status: "signed_out", pending: 2 });
    expect(await db.outbox.count()).toBe(2);
  });

  it("pushes nothing while §5.6 sync is switched off, and still counts the rows", async () => {
    await updateSettings({ syncEnabled: false });
    const engine = engineFor();
    await scan();

    const snapshot = await engine.sync();

    expect(server.requests).toHaveLength(0);
    // §4.10 has no member for "switched off"; the rows genuinely are pending.
    expect(snapshot).toMatchObject({ status: "pending", pending: 2 });
    expect(await db.outbox.count()).toBe(2);
  });

  it("does nothing offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const engine = engineFor();
    await scan();

    const snapshot = await engine.sync();

    expect(server.requests).toHaveLength(0);
    expect(snapshot.status).toBe("offline");
  });
});

describe("a cycle", () => {
  it("pushes, then pulls, and reports Synced", async () => {
    const engine = engineFor();
    await scan();

    const snapshot = await engine.sync();

    expect(server.eventsOf(USER)).toHaveLength(1);
    expect(server.vehiclesOf(USER)).toHaveLength(1);
    expect(await db.outbox.count()).toBe(0);
    expect(snapshot.status).toBe("synced");
    const state = await getSyncState();
    expect(state.lastPushAt).not.toBeNull();
    expect(state.lastPullAt).not.toBeNull();
    expect(state.lastError).toBeNull();
  });

  it("reports an error and keeps the row when the push fails", async () => {
    const engine = engineFor();
    await scan();
    server.failNext = (request) =>
      request.kind === "upsert" ? { message: "Failed to fetch", code: null } : null;

    const snapshot = await engine.sync();

    expect(snapshot.status).toBe("error");
    expect(snapshot.lastError).toBe("Failed to fetch");
    expect(await db.outbox.count()).toBeGreaterThan(0);
  });

  it("does not spend a pull on a network that just refused a push", async () => {
    const engine = engineFor();
    await scan();
    // One row, so the drain makes exactly one request and nothing reaches the account —
    // which also means nothing wakes the realtime channel and asks for a second cycle.
    await db.outbox.where("kind").equals("vehicle_meta").delete();
    server.failNext = () => ({ message: "Failed to fetch", code: null });

    await engine.sync();

    expect(server.requests.map((r) => r.kind)).toEqual(["upsert"]);
  });

  it("keeps a push failure visible even when the pull that follows it succeeds", async () => {
    const engine = engineFor();
    await scan();
    server.failNext = (request) =>
      request.target === "upsert_vehicle_meta" ? { message: "denied", code: "42501" } : null;

    const snapshot = await engine.sync();

    expect(snapshot.status).toBe("error");
    expect(snapshot.lastError).toBe("42501: denied");
  });

  it("collapses overlapping triggers into one run and one re-run", async () => {
    const engine = engineFor();
    await scan();

    await Promise.all([engine.sync(), engine.sync(), engine.sync()]);

    // Three triggers, one drain plus the queued re-run: never three concurrent pushes.
    expect(server.eventsOf(USER)).toHaveLength(1);
  });

  it("[M4] keeps saying the failure of the queued row that has tried hardest", async () => {
    // §5.7 gives every outbox row its own `lastError`, and `queuedFailure` is what §6.4's
    // chip says while every failed row is waiting out its backoff: nothing is due, so the
    // cycle pushes nothing and pulls cleanly, and without it the chip would drop from
    // "Sync error — tap for details" to "1 pending" seconds after the failure, with the row
    // still stuck. Which row it names is the choice `bun run mutate` found no test for at
    // all: the whole `worst` fold was NoCoverage or Survived.
    //
    // Rows are read in primary-key order, so the ids fix the order the fold sees them in,
    // and the one it must pick — three attempts, "gateway timeout" — is neither the first
    // nor the last. Two of them are shapes a *stored* row can have and the type cannot
    // stop: §4.12 never drops an outbox row, so one written by an older build or
    // half-written by a crash stays in the queue for ever.
    const engine = engineFor();
    const backingOff = new Date(Date.now() + 600_000).toISOString();
    const queued = (
      id: string,
      attempts: unknown,
      lastError: string | null,
    ): Record<string, unknown> => ({
      id,
      kind: "vehicle_delete",
      vin: VIN,
      payload: { p_vin: VIN },
      createdAt: "2026-09-04T08:00:00.000-06:00",
      attempts,
      nextAttemptAt: backingOff,
      lastError,
    });

    await db.outbox.bulkPut([
      queued("row-1", 1, "Failed to fetch"),
      queued("row-2", 3, "gateway timeout"),
      // No error of its own: it has never been tried, and the count it carries is not a
      // failure count. Read as one it would win, and the chip would go blank.
      queued("row-3", 99, null),
      // A stored row whose `attempts` is not a number. Counted as written it beats every
      // real count; §5.7 says the field is a number, so it counts as none.
      queued("row-4", "9", "half-written row"),
      // The same count as the row that should win, appended after it. §5.7's counter is
      // "how many times this row has been tried", so a tie is not a newer failure.
      queued("row-5", 3, "409 conflict"),
    ] as never);

    const snapshot = await engine.sync();

    expect(snapshot.lastError).toBe("gateway timeout");
    expect((await getSyncState()).lastError).toBe("gateway timeout");
    // Nothing was due, so the cycle sent no push at all and the answer came from the queue.
    expect(server.requests.filter((request) => request.kind !== "select")).toEqual([]);
  });
});

describe("whose account the cursor belongs to", () => {
  it("keeps the cursor across an app start", async () => {
    await advanceCursors({ vehiclesCursor: "2026-09-04T00:00:00.000Z" });
    const engine = engineFor();

    await engine.sync();

    expect((await getSyncState()).vehiclesCursor).not.toBeNull();
  });

  it("resets it when a different user signs in", async () => {
    const engine = engineFor();
    await scan();
    await engine.sync();
    // The first account had rows, so the cursor names a position in its history.
    expect((await getSyncState()).vehiclesCursor).not.toBeNull();

    userId = OTHER;
    await engine.sync();

    // The new account's first pull started from nothing, so the cursor it now holds is its
    // own — not a position in the previous account's history.
    const state = await getSyncState();
    expect(state.vehiclesCursor).toBeNull();
  });

  it("never pushes one account's queue into another's", async () => {
    const engine = engineFor();
    await engine.sync();

    // The session hands straight over to a different account, without §9-S4's sign-out.
    await scan();
    expect(await db.outbox.count()).toBe(2);
    userId = OTHER;
    await engine.sync();

    // The rows were addressed to the first account. They are not sent to the second, and
    // the record itself is untouched — the same trade §9-S4's "keep this phone's records"
    // makes.
    expect(server.eventsOf(OTHER)).toHaveLength(0);
    expect(server.vehiclesOf(OTHER)).toHaveLength(0);
    expect(await db.outbox.count()).toBe(0);
    expect(await db.vehicles.count()).toBe(1);
  });

  it("sends what was queued signed out, and keeps what is queued when a session ends", async () => {
    const engine = engineFor();
    userId = null;
    await engine.sync();

    // Scanned before ever signing in. §9-S4's "Add the 14 records on this phone to your
    // account?" is about exactly these rows, and §5.6's `syncEnabled` is the gate the
    // Account screen sets — the engine's own answer, with the gate open, is to send them.
    await scan();
    userId = USER;
    await engine.sync();

    expect(server.eventsOf(USER)).toHaveLength(1);
    expect(await db.outbox.count()).toBe(0);

    // And a session that ends leaves whatever is queued alone: it may only have expired,
    // and those rows belong to the account the user is about to return to.
    await scan(VIN_B);
    userId = null;
    await engine.sync();
    expect(await db.outbox.count()).toBe(2);
  });

  it("stops syncing when the session ends mid-session", async () => {
    const engine = engineFor();
    await scan();
    await engine.sync();

    userId = null;
    await scan(VIN_B);
    const snapshot = await engine.sync();

    expect(snapshot.status).toBe("signed_out");
    // Signing out does not discard the queue — that is §9-S4's explicit choice, not a
    // side effect (`signOutKeepRecords`).
    expect(await db.outbox.count()).toBeGreaterThan(0);
  });
});

describe("a cycle that throws (P7)", () => {
  it("records what failed and keeps the app running", async () => {
    const engine = engineFor({
      getUserId: async () => {
        throw new Error("session store unavailable");
      },
    });

    await expect(engine.sync()).resolves.toBeDefined();

    expect((await getSyncState()).lastError).toBe("session store unavailable");
  });

  it("records a throw that is not an Error at all", async () => {
    const engine = engineFor({
      getUserId: async () => {
        throw "no session";
      },
    });

    await engine.sync();

    expect((await getSyncState()).lastError).toBe("no session");
  });
});

describe("the triggers §4.12 lists", () => {
  it("runs on start, on online, on becoming visible, and on the poll", async () => {
    const listeners = new Map<string, () => void>();
    vi.stubGlobal("window", {
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    });
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    });

    // The interval is §4.12's 5 minutes in production (`SYNC_POLL_MS`); a test that waited
    // that out would be a test nobody runs, and the timer is the same timer.
    expect(SYNC_POLL_MS).toBe(300_000);
    const engine = engineFor({}, { pollMs: 20 });
    engine.start();
    await vi.waitFor(() => expect(server.requests.length).toBeGreaterThan(0));
    const afterStart = server.requests.length;

    listeners.get("online")?.();
    await vi.waitFor(() => expect(server.requests.length).toBeGreaterThan(afterStart));
    const afterOnline = server.requests.length;

    listeners.get("visibilitychange")?.();
    await vi.waitFor(() => expect(server.requests.length).toBeGreaterThan(afterOnline));
    const afterVisible = server.requests.length;

    // Nothing fired now but the interval.
    await vi.waitFor(() => expect(server.requests.length).toBeGreaterThan(afterVisible));

    engine.stop();
    expect(listeners.size).toBe(0);
  });

  it("does not poll while the tab is hidden", async () => {
    vi.stubGlobal("document", {
      visibilityState: "hidden",
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    const engine = engineFor({}, { pollMs: 5 });
    engine.start();
    // The start trigger runs whatever the visibility is; the poll after it does not.
    await vi.waitFor(() => expect(server.requests.length).toBeGreaterThan(0));
    const afterStart = server.requests.length;

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(server.requests.length).toBe(afterStart);
    engine.stop();
  });

  it("starts and stops in a runtime with no window or document at all", () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    const engine = engineFor();
    engine.start();
    engine.start();
    engine.stop();
    engine.stop();
  });

  it("runs when auth says something changed", async () => {
    const auth: { fire: (() => void) | null } = { fire: null };
    let unwired = false;
    const engine = engineFor({
      onAuthChange: (listener) => {
        auth.fire = listener;
        return () => {
          unwired = true;
        };
      },
    });
    engine.start();
    await vi.waitFor(() => expect(server.requests.length).toBeGreaterThan(0));
    const afterStart = server.requests.length;

    auth.fire?.();
    await vi.waitFor(() => expect(server.requests.length).toBeGreaterThan(afterStart));

    engine.stop();
    expect(unwired).toBe(true);
  });
});

describe("realtime is a signal to pull, never an apply (§4.12)", () => {
  it("pulls what another device wrote, without a poll or a reload", async () => {
    const engine = engineFor();
    engine.start();
    await vi.waitFor(() => expect(server.requests.length).toBeGreaterThan(0));

    // A second device on the same account, writing through its own client.
    const laptop = createFakeClient(server, () => USER);
    await laptop.rpc("upsert_vehicle_meta", {
      p_vin: VIN_B,
      p_unit: "TRK-9",
      p_notes: null,
      p_meta_updated_at: "2026-09-04T07:00:00.000-06:00",
      p_structural: {},
      p_decode: {},
    });

    await vi.waitFor(async () => expect(await db.vehicles.get(VIN_B)).toBeDefined());
    expect((await db.vehicles.get(VIN_B))?.unit).toBe("TRK-9");
    engine.stop();
  });

  it("drops the channel when the engine stops", async () => {
    const engine = engineFor();
    engine.start();
    await vi.waitFor(() => expect(server.requests.length).toBeGreaterThan(0));
    engine.stop();

    const before = server.requests.length;
    const laptop = createFakeClient(server, () => USER);
    await laptop.rpc("delete_vehicle", { p_vin: VIN });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(server.requests.filter((r) => r.kind === "select").length).toBe(
      server.requests.slice(0, before).filter((r) => r.kind === "select").length,
    );
  });
});

describe("the snapshot the §6.4 chip reads", () => {
  it("moves through syncing and settles on the value the chip renders", async () => {
    const engine = engineFor();
    const seen: string[] = [];
    const unsubscribe = engine.subscribe(() => seen.push(engine.getSnapshot().status));
    await scan();

    await engine.sync();

    // A push wakes this device's own realtime channel, so the cycle answers itself once
    // more before it settles; §4.12's notification is a signal to pull whoever caused it.
    expect(seen[0]).toBe("syncing");
    expect(seen.at(-1)).toBe("synced");
    expect(new Set(seen)).toEqual(new Set(["syncing", "synced"]));
    expect(engine.getSnapshot()).toMatchObject({ status: "synced", pending: 0 });
    unsubscribe();
  });

  it("keeps one snapshot object while nothing about it changes", async () => {
    userId = null;
    const engine = engineFor();
    const seen: string[] = [];
    const unsubscribe = engine.subscribe(() => seen.push(engine.getSnapshot().status));

    await engine.sync();
    const first = engine.getSnapshot();
    await engine.sync();

    // `useSyncExternalStore` re-renders on identity, so a cycle that changed nothing must
    // not hand back a new object.
    expect(engine.getSnapshot()).toBe(first);
    expect(seen).toEqual([]);
    unsubscribe();
  });

  it("hands the app one engine, and gives it back", () => {
    const engine = startSync(deps(), { currentYear: YEAR });
    expect(startSync(deps(), { currentYear: YEAR })).toBe(engine);
    expect(getSyncEngine()).toBe(engine);
    stopSync();
    expect(getSyncEngine()).toBeNull();
  });
});
