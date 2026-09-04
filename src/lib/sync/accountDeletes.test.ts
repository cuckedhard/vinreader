/**
 * §9-S4's two account-level deletes, driven against `supabaseFake.testutil.ts` — the same
 * in-memory transcription of `0001_init.sql` the engine's own scenarios run on, so
 * `delete_my_data` here means what the migration says it means (both tables, `auth.uid()`
 * only) rather than what this file would like it to mean.
 *
 * The Edge Function has no counterpart in that fake and cannot have one: it runs on Deno,
 * verifies a JWT and holds the service-role key. What is asserted here is the contract the
 * client depends on — the locked name, the POST, and what the app does with each answer —
 * and `supabase/functions/delete-account/index.ts` is where the other half is checked.
 *
 * The half-failed states are the point of most of this file. Either side can fail alone,
 * and the one the user must never be lied to about is "the server did it and the phone did
 * not".
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { db } from "../storage/db";
import { DEFAULT_SETTINGS, getSettings, updateSettings } from "../storage/settings";
import { advanceCursors, getSyncState } from "../storage/syncState";
import { upsertVehicle } from "../storage/upsert";
import {
  ACCOUNT_DELETED_DEVICE_NOT_CLEARED,
  CLOUD_DATA_DELETED_LOCAL_STALE,
  DELETE_ACCOUNT_FUNCTION,
  DELETE_MY_DATA_RPC,
  deleteAccount,
  deleteCloudData,
} from "./accountDeletes";
import type { AccountDeleteClient, AccountDeleteDeps } from "./accountDeletes";
import type { SyncEngine } from "./engine";
import { IDLE_SNAPSHOT } from "./status";
import { FakeServer, createFakeClient } from "./supabaseFake.testutil";
import type { AuthResult } from "../auth/session";

const VIN = "1HGCM82633A004352";
const OTHER_VIN = "5FNRL38209B402142";
const USER = "user-1";
const NEIGHBOUR = "user-2";

/** One `scan_events` row in the shape the push sends (§4.12). */
function eventRow(userId: string, vin: string, id: string): Record<string, unknown> {
  return {
    id,
    user_id: userId,
    vin,
    at: "2026-09-04T11:00:00.000Z",
    symbology: "code_39",
    check_digit_valid: true,
    device_label: "Bay 3",
    origin: "scan",
  };
}

interface EdgeAnswer {
  error: Error | null;
  response?: { status?: number };
}

interface Harness {
  server: FakeServer;
  engineCalls: string[];
  edgeCalls: { name: string; method: string }[];
  sessionEnds: number;
  deps: Partial<AccountDeleteDeps>;
}

interface HarnessOptions {
  userId?: string | null;
  configured?: boolean;
  engine?: "ok" | "none" | "stop-throws" | "start-throws";
  edge?: () => EdgeAnswer | Promise<EdgeAnswer>;
  rpcThrows?: boolean | "silent";
  signOutResult?: AuthResult;
}

function harness(options: HarnessOptions = {}): Harness {
  const server = new FakeServer();
  const engineCalls: string[] = [];
  const edgeCalls: { name: string; method: string }[] = [];
  const userId = options.userId === undefined ? USER : options.userId;
  let sessionEnds = 0;

  const base = createFakeClient(server, () => userId);
  const client: AccountDeleteClient = {
    rpc: (fn, args) => {
      if (options.rpcThrows === "silent") throw new Error("");
      if (options.rpcThrows === true) throw new TypeError("Failed to fetch");
      return base.rpc(fn, args);
    },
    functions: {
      invoke: async (name, invokeOptions) => {
        edgeCalls.push({ name, method: invokeOptions.method });
        return (await options.edge?.()) ?? { error: null };
      },
    },
  };

  const engine: SyncEngine = {
    start: () => {
      engineCalls.push("start");
      if (options.engine === "start-throws") throw new Error("engine start failed");
    },
    stop: () => {
      engineCalls.push("stop");
      if (options.engine === "stop-throws") throw new Error("engine stop failed");
    },
    trigger: () => engineCalls.push("trigger"),
    sync: async () => IDLE_SNAPSHOT,
    getSnapshot: () => IDLE_SNAPSHOT,
    subscribe: () => () => {},
  };

  const result: Harness = {
    server,
    engineCalls,
    edgeCalls,
    sessionEnds: 0,
    deps: {
      getClient: () => (options.configured === false ? null : client),
      getUserId: async () => userId,
      getEngine: () => (options.engine === "none" ? null : engine),
      endSession: async () => {
        sessionEnds += 1;
        result.sessionEnds = sessionEnds;
        return options.signOutResult ?? { ok: true };
      },
    },
  };
  return result;
}

/** This phone: one record, its two queued rows (§5.7), a cursor and an answered prompt. */
async function seedDevice(): Promise<void> {
  await upsertVehicle({
    vin: VIN,
    origin: "scan",
    symbology: "code_39",
    raw: VIN,
    checkDigitValid: true,
  });
  await advanceCursors({ vehiclesCursor: "2026-09-04T00:00:00.000Z" });
  await updateSettings({ uploadPromptDismissed: true, deviceLabel: "Bay 3" });
}

/** The account, and a second account that must survive every delete in this file. */
function seedServer(server: FakeServer): void {
  server.insertScanEvents(USER, [eventRow(USER, VIN, "11111111-1111-4111-8111-111111111111")]);
  server.insertScanEvents(NEIGHBOUR, [
    eventRow(NEIGHBOUR, OTHER_VIN, "22222222-2222-4222-8222-222222222222"),
  ]);
}

beforeEach(async () => {
  await db.open();
  await Promise.all(db.tables.map((table) => table.clear()));
});

describe("both deletes, when there is nothing to delete", () => {
  it("refuse on a build with no Supabase, and touch nothing", async () => {
    await seedDevice();
    const kit = harness({ configured: false });

    expect(await deleteCloudData(kit.deps)).toEqual({
      outcome: "not_configured",
      serverDeleted: false,
      message: null,
    });
    expect(await deleteAccount(kit.deps)).toEqual({
      outcome: "not_configured",
      serverDeleted: false,
      message: null,
    });

    // Not even the engine is disturbed: an unconfigured build never had a session to
    // delete anything from, so this is not a failed delete, it is not a delete at all.
    expect(kit.engineCalls).toEqual([]);
    expect(await db.outbox.count()).toBe(2);
    expect(await db.vehicles.count()).toBe(1);
  });

  it("refuse when signed out, without reaching the server", async () => {
    await seedDevice();
    const kit = harness({ userId: null });
    seedServer(kit.server);
    const before = kit.server.requests.length;

    expect((await deleteCloudData(kit.deps)).outcome).toBe("not_signed_in");
    expect((await deleteAccount(kit.deps)).outcome).toBe("not_signed_in");

    expect(kit.server.requests.length).toBe(before);
    expect(kit.edgeCalls).toEqual([]);
    expect(kit.engineCalls).toEqual([]);
    expect(await db.outbox.count()).toBe(2);
    expect(kit.sessionEnds).toBe(0);
  });
});

describe("Delete my cloud data", () => {
  it("empties this account and only this account, and leaves the phone's records", async () => {
    await seedDevice();
    const kit = harness();
    seedServer(kit.server);

    const result = await deleteCloudData(kit.deps);

    expect(result).toEqual({ outcome: "done", serverDeleted: true, message: null });
    expect(kit.server.vehiclesOf(USER)).toEqual([]);
    expect(kit.server.eventsOf(USER)).toEqual([]);
    // RLS is the wall (P8): the other account is untouched.
    expect(kit.server.vehiclesOf(NEIGHBOUR)).toHaveLength(1);
    expect(kit.server.eventsOf(NEIGHBOUR)).toHaveLength(1);

    // N7: the user emptied an account, not a phone.
    expect(await db.vehicles.count()).toBe(1);
    expect(await db.scanEvents.count()).toBe(1);
  });

  it("calls §4.12's locked RPC name", async () => {
    await seedDevice();
    const kit = harness();

    await deleteCloudData(kit.deps);

    expect(kit.server.requests.map((request) => request.target)).toContain(DELETE_MY_DATA_RPC);
  });

  it("clears the queue and the cursor, which are now lies, and re-arms the §6.4 prompt", async () => {
    await seedDevice();
    const kit = harness();
    seedServer(kit.server);

    await deleteCloudData(kit.deps);

    expect(await db.outbox.count()).toBe(0);
    const state = await getSyncState();
    expect(state.vehiclesCursor).toBeNull();
    expect(state.eventsCursor).toBeNull();

    const settings = await getSettings();
    expect(settings.uploadPromptDismissed).toBe(false);
    // Emptying an account is not switching sync off, and the device label is this phone's.
    expect(settings.syncEnabled).toBe(true);
    expect(settings.deviceLabel).toBe("Bay 3");
  });

  it("stops the engine before the delete and starts it again after", async () => {
    await seedDevice();
    const kit = harness();

    await deleteCloudData(kit.deps);

    expect(kit.engineCalls).toEqual(["stop", "start"]);
  });

  it("keeps every queued row when the server refuses", async () => {
    await seedDevice();
    const kit = harness();
    seedServer(kit.server);
    kit.server.failNext = (request) =>
      request.target === DELETE_MY_DATA_RPC ? { message: "permission denied" } : null;

    const result = await deleteCloudData(kit.deps);

    expect(result.outcome).toBe("server_failed");
    expect(result.serverDeleted).toBe(false);
    expect(result.message).toBe("permission denied");
    // The rows never reached the account and must not be thrown away on the way to
    // learning that: clearing the queue first would lose them to a failed delete.
    expect(await db.outbox.count()).toBe(2);
    expect((await getSyncState()).vehiclesCursor).toBe("2026-09-04T00:00:00.000Z");
    expect(kit.server.vehiclesOf(USER)).toHaveLength(1);
    // A failed delete must not leave the device silently unsynced.
    expect(kit.engineCalls).toEqual(["stop", "start"]);
  });

  it("reports a client that throws instead of answering", async () => {
    await seedDevice();
    const kit = harness({ rpcThrows: true });

    const result = await deleteCloudData(kit.deps);

    expect(result.outcome).toBe("server_failed");
    expect(result.message).toBe("Failed to fetch");
    expect(await db.outbox.count()).toBe(2);
  });

  it("says the account is empty even when the phone cannot finish, and stays stopped", async () => {
    await seedDevice();
    const kit = harness();
    seedServer(kit.server);
    // Storage itself is gone mid-command — the one failure that cannot be rehearsed any
    // other way in a runner with no browser.
    db.close();

    const result = await deleteCloudData(kit.deps);

    expect(result.outcome).toBe("done_local_incomplete");
    // N2: the account really is empty. A screen that called this a failure would be wrong.
    expect(result.serverDeleted).toBe(true);
    expect(result.message).not.toBeNull();
    expect(kit.server.vehiclesOf(USER)).toEqual([]);
    // Restarting here is the one action that could undo the deletion: the queue this
    // phone could not clear would refill the account on the next cycle.
    expect(kit.engineCalls).toEqual(["stop"]);
  });

  it("survives an engine that throws, and carries the reason", async () => {
    await seedDevice();
    const kit = harness({ engine: "stop-throws" });

    const result = await deleteCloudData(kit.deps);

    expect(result.outcome).toBe("done");
    expect(result.message).toBe("engine stop failed");
    expect(kit.server.vehiclesOf(USER)).toEqual([]);
  });

  it("is still done when the engine refuses to start again", async () => {
    await seedDevice();
    const kit = harness({ engine: "start-throws" });
    seedServer(kit.server);

    const result = await deleteCloudData(kit.deps);

    // The account is empty and this phone is tidy; what failed is the background loop,
    // and it is named rather than swallowed (P7).
    expect(result.outcome).toBe("done");
    expect(result.serverDeleted).toBe(true);
    expect(result.message).toBe("engine start failed");
    expect(await db.outbox.count()).toBe(0);
  });

  it("never reports an empty explanation", async () => {
    await seedDevice();
    const kit = harness({ rpcThrows: "silent" });

    // An error with no message of its own still has a name; a blank detail line under
    // "that didn't work" says nothing at all.
    expect((await deleteCloudData(kit.deps)).message).toBe("Error");
  });

  it("works on a device whose engine was never started", async () => {
    await seedDevice();
    const kit = harness({ engine: "none" });
    seedServer(kit.server);

    expect((await deleteCloudData(kit.deps)).outcome).toBe("done");
    expect(kit.engineCalls).toEqual([]);
  });
});

describe("Delete account", () => {
  it("posts to §4.12's locked function name, then clears the phone and the session", async () => {
    await seedDevice();
    const kit = harness();
    seedServer(kit.server);

    const result = await deleteAccount(kit.deps);

    expect(result).toEqual({ outcome: "done", serverDeleted: true, message: null });
    expect(kit.edgeCalls).toEqual([{ name: DELETE_ACCOUNT_FUNCTION, method: "POST" }]);

    // §9-S4: "then signs out and clears the device".
    expect(await db.vehicles.count()).toBe(0);
    expect(await db.scanEvents.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
    expect(await db.settings.get("settings")).toEqual(DEFAULT_SETTINGS);
    expect(await getSyncState()).toMatchObject({ vehiclesCursor: null, eventsCursor: null });
    expect(kit.sessionEnds).toBe(1);

    // No account left to sync with: the engine is stopped and never restarted.
    expect(kit.engineCalls).toEqual(["stop"]);
  });

  it("leaves the phone completely alone when the function refuses", async () => {
    await seedDevice();
    const kit = harness({
      edge: () => ({ error: Object.assign(new Error("non-2xx"), { context: { status: 401 } }) }),
    });

    const result = await deleteAccount(kit.deps);

    expect(result.outcome).toBe("server_failed");
    expect(result.serverDeleted).toBe(false);
    // The status is the difference between "sign in again" and "the server broke", and
    // the library's own message is the same sentence for both (P7).
    expect(result.message).toBe("non-2xx (HTTP 401)");
    expect(await db.vehicles.count()).toBe(1);
    expect(await db.outbox.count()).toBe(2);
    expect(kit.sessionEnds).toBe(0);
    expect(kit.engineCalls).toEqual(["stop", "start"]);
  });

  it("reads the status from the response when the error does not carry one", async () => {
    await seedDevice();
    const kit = harness({
      edge: () => ({ error: new Error("non-2xx"), response: { status: 500 } }),
    });

    expect((await deleteAccount(kit.deps)).message).toBe("non-2xx (HTTP 500)");
  });

  it("reports a failure with no status at all", async () => {
    await seedDevice();
    const kit = harness({ edge: () => ({ error: new Error("Failed to send a request") }) });

    const result = await deleteAccount(kit.deps);

    expect(result.outcome).toBe("server_failed");
    expect(result.message).toBe("Failed to send a request");
  });

  it("reports a client that throws instead of answering", async () => {
    await seedDevice();
    const kit = harness({
      edge: () => {
        throw new TypeError("Failed to fetch");
      },
    });

    const result = await deleteAccount(kit.deps);

    expect(result.outcome).toBe("server_failed");
    expect(result.message).toBe("Failed to fetch");
    expect(await db.vehicles.count()).toBe(1);
  });

  it("still ends the session when the device wipe fails, and says the account is gone", async () => {
    await seedDevice();
    const kit = harness();
    db.close();

    const result = await deleteAccount(kit.deps);

    expect(result.outcome).toBe("done_local_incomplete");
    expect(result.serverDeleted).toBe(true);
    expect(result.message).not.toBeNull();
    // A session for a deleted user cannot refresh; ending it is not optional.
    expect(kit.sessionEnds).toBe(1);
    expect(kit.engineCalls).toEqual(["stop"]);
  });

  it("is still done when only the server-side sign-out failed", async () => {
    await seedDevice();
    const kit = harness({ signOutResult: { ok: false, reason: "offline", message: null } });

    const result = await deleteAccount(kit.deps);

    // `session.ts` clears local state before it calls out, so the session is already gone
    // on this phone; the failure is a detail for the log, not an outcome.
    expect(result.outcome).toBe("done");
    expect(result.serverDeleted).toBe(true);
    expect(result.message).toBe("offline");
    expect(await db.vehicles.count()).toBe(0);
  });

  it("carries an engine that refused to stop into the message", async () => {
    await seedDevice();
    const kit = harness({ engine: "stop-throws" });

    const result = await deleteAccount(kit.deps);

    expect(result.outcome).toBe("done");
    expect(result.message).toBe("engine stop failed");
  });

  it("does not fail the command when the engine refuses to restart", async () => {
    await seedDevice();
    const kit = harness({
      engine: "start-throws",
      edge: () => ({ error: new Error("non-2xx"), response: { status: 500 } }),
    });

    const result = await deleteAccount(kit.deps);

    expect(result.outcome).toBe("server_failed");
    expect(result.message).toBe("non-2xx (HTTP 500)");
    expect(kit.engineCalls).toEqual(["stop", "start"]);
  });
});

describe("the client surface", () => {
  /** A compile error here means this file is calling something supabase-js does not have. */
  function narrow(client: SupabaseClient): AccountDeleteClient {
    return client;
  }

  it("is one a real SupabaseClient already satisfies", () => {
    expect(typeof narrow).toBe("function");
  });
});

describe("the copy §6.4 does not have", () => {
  it("names what is left and what to do about it, for both half-failed states", () => {
    // §0 rule 4: supplied strings, reported. Each ends in an action the user can take.
    expect(CLOUD_DATA_DELETED_LOCAL_STALE).toContain("Delete my cloud data");
    expect(ACCOUNT_DELETED_DEVICE_NOT_CLEARED).toContain("Clear all data");
  });
});
