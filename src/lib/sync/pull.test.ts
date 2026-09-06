/**
 * §4.12's pull, and the one apply path.
 *
 * The pull is where a sync engine loses data quietly: a cursor that jumps ahead skips rows
 * for ever, a page boundary drops the row that straddles it, and a merge that runs while an
 * edit is still queued erases something the user typed thirty seconds ago. Each of those has
 * a test here.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../storage/db";
import { getSyncState } from "../storage/syncState";
import { setVehicleMeta, upsertVehicle } from "../storage/upsert";
import { PULL_PAGE, applyPulled, pullOnce } from "./pull";
import { FakeServer, createFakeClient } from "./supabaseFake.testutil";
import type { RemoteVehicle, SyncClient } from "./types";

const VIN = "1HGCM82633A004352";
const VIN_B = "1FUJGLDR49SAV1234";
const USER = "11111111-1111-4111-8111-111111111111";
const YEAR = 2026;

let server: FakeServer;
let client: SyncClient;

beforeEach(async () => {
  await db.open();
  await Promise.all(db.tables.map((table) => table.clear()));
  server = new FakeServer();
  client = createFakeClient(server, () => USER);
});

function meta(vin: string, args: Partial<Record<string, unknown>> = {}): void {
  server.upsertVehicleMeta(USER, {
    p_vin: vin,
    p_unit: null,
    p_notes: null,
    p_meta_updated_at: "2026-09-04T06:00:00.000-06:00",
    p_structural: {},
    p_decode: {},
    ...args,
  });
}

function scan(vin: string, id: string, at = "2026-09-04T06:00:00.000-06:00"): void {
  server.insertScanEvents(USER, [
    {
      id,
      user_id: USER,
      vin,
      at,
      symbology: "code_39",
      check_digit_valid: true,
      device_label: "Bay 3",
      origin: "scan",
    },
  ]);
}

async function localScan(vin = VIN): Promise<void> {
  await upsertVehicle({
    vin,
    origin: "scan",
    symbology: "code_39",
    raw: vin,
    checkDigitValid: true,
  });
}

describe("what a pull brings down", () => {
  it("creates records for VINs this device has never held", async () => {
    meta(VIN, { p_unit: "TRK-118" });
    scan(VIN_B, "event-b");

    const result = await pullOnce({ client, currentYear: YEAR });

    expect(result).toMatchObject({ vehicles: 2, events: 1, error: null });
    expect((await db.vehicles.get(VIN))?.unit).toBe("TRK-118");
    expect(await db.vehicles.get(VIN_B)).toMatchObject({ origin: "cloud", scanCount: 1 });
  });

  it("adds pulled events to the §5.2 log without a raw read (N3)", async () => {
    scan(VIN, "event-1");
    await pullOnce({ client, currentYear: YEAR });

    expect(await db.scanEvents.get("event-1")).toMatchObject({
      vin: VIN,
      symbology: "code_39",
      raw: "",
      deviceLabel: "Bay 3",
    });
  });

  it("never overwrites an event the local log already holds", async () => {
    await localScan();
    const [local] = await db.scanEvents.toArray();
    // The same event, echoed back by the account after this device pushed it.
    scan(VIN, local.id, local.at);

    await pullOnce({ client, currentYear: YEAR });

    // The local copy is the only one carrying the raw read.
    expect(await db.scanEvents.get(local.id)).toMatchObject({ raw: local.raw });
    expect(await db.scanEvents.count()).toBe(1);
  });

  it("drops a row it cannot read and keeps the rest of the page", async () => {
    meta(VIN);
    // A row from a build this one does not know: no VIN this app could ever have written.
    server.vehicles.set(`${USER}/BAD`, {
      user_id: USER,
      vin: "not-a-vin",
      unit: null,
      notes: null,
      meta_updated_at: "2026-09-04T06:00:00.000-06:00",
      structural: {},
      decode: {},
      first_scanned_at: null,
      last_scanned_at: null,
      scan_count: 0,
      deleted_at: null,
      updated_at: server.now(),
    });

    const result = await pullOnce({ client, currentYear: YEAR });

    expect(result.vehicles).toBe(1);
    expect(await db.vehicles.count()).toBe(1);
    // The cursor still moves past the unreadable row, or every pull would fetch it again.
    const state = await getSyncState();
    expect(state.vehiclesCursor).not.toBeNull();
  });
});

describe("the cursor (§5.8)", () => {
  it("advances to the newest timestamp received and pulls nothing twice", async () => {
    meta(VIN);
    scan(VIN_B, "event-b");
    await pullOnce({ client, currentYear: YEAR });
    const first = await getSyncState();

    const before = server.requests.length;
    const second = await pullOnce({ client, currentYear: YEAR });

    // `>=` re-delivers the boundary rows; the merge is idempotent and nothing new is written.
    expect(second.error).toBeNull();
    expect(server.requests.length).toBeGreaterThan(before);
    const after = await getSyncState();
    expect(after.vehiclesCursor).toBe(first.vehiclesCursor);
    expect(after.eventsCursor).toBe(first.eventsCursor);
  });

  it("starts from nothing when there is no cursor, and filters by it once there is", async () => {
    meta(VIN);
    await pullOnce({ client, currentYear: YEAR });
    const cursor = (await getSyncState()).vehiclesCursor;
    expect(cursor).not.toBeNull();

    meta(VIN_B);
    await pullOnce({ client, currentYear: YEAR });

    expect((await getSyncState()).vehiclesCursor).not.toBe(cursor);
    expect(await db.vehicles.count()).toBe(2);
  });

  it("pages through more rows than one page holds, deduping the boundary", async () => {
    // One row over a page, so the second request re-delivers the boundary row.
    const total = PULL_PAGE + 3;
    for (let i = 0; i < total; i += 1) {
      meta(`1HGCM82633A${String(i).padStart(6, "0")}`);
    }
    const distinct = new Set(server.vehiclesOf(USER).map((row) => row.vin)).size;

    const result = await pullOnce({ client, currentYear: YEAR });

    expect(result.error).toBeNull();
    expect(await db.vehicles.count()).toBe(distinct);
    // Every page after the first is a second request against the same table.
    const selects = server.requests.filter(
      (r) => r.kind === "select" && r.target === "vehicles",
    ).length;
    expect(selects).toBeGreaterThan(1);
  });

  it("records the failure and leaves the cursor alone when the server refuses", async () => {
    meta(VIN);
    server.failNext = (request) =>
      request.target === "vehicles" ? { message: "JWT expired", code: "PGRST301" } : null;

    const result = await pullOnce({ client, currentYear: YEAR });

    expect(result.error).toBe("JWT expired");
    const state = await getSyncState();
    expect(state.vehiclesCursor).toBeNull();
    expect(state.lastError).toBe("JWT expired");
    expect(state.lastPullAt).toBeNull();
  });

  it("stops at the vehicles failure rather than pulling events into a half state", async () => {
    scan(VIN, "event-1");
    server.failNext = (request) =>
      request.target === "vehicles" ? { message: "offline", code: null } : null;

    await pullOnce({ client, currentYear: YEAR });

    expect(
      server.requests.filter((r) => r.kind === "select" && r.target === "scan_events"),
    ).toHaveLength(0);
  });
});

describe("applying a pull to what is already on the device", () => {
  it("keeps an edit that has not been pushed yet", async () => {
    // §4.12: "a local vehicle that still has an unpushed vehicle_meta newer than the
    // server's meta_updated_at keeps its local unit/notes until pushed."
    await localScan();
    await setVehicleMeta(VIN, { unit: "TRK-118" });
    const local = await db.vehicles.get(VIN);
    const later = new Date(Date.parse(local?.metaUpdatedAt ?? "") - 1000).toISOString();
    meta(VIN, { p_unit: "TRK-999", p_meta_updated_at: later });

    await pullOnce({ client, currentYear: YEAR });

    expect((await db.vehicles.get(VIN))?.unit).toBe("TRK-118");
    // And the queued row is still there to send.
    expect(await db.outbox.where("kind").equals("vehicle_meta").count()).toBeGreaterThan(0);
  });

  it("takes the account's edit when it is genuinely newer", async () => {
    await localScan();
    await db.outbox.clear();
    meta(VIN, { p_unit: "TRK-999", p_meta_updated_at: "2099-01-01T00:00:00.000Z" });

    await pullOnce({ client, currentYear: YEAR });

    expect((await db.vehicles.get(VIN))?.unit).toBe("TRK-999");
  });

  it("tombstones a record another device deleted", async () => {
    await localScan();
    await db.outbox.clear();
    meta(VIN);
    server.deleteVehicle(USER, { p_vin: VIN });

    await pullOnce({ client, currentYear: YEAR });

    const row = await db.vehicles.get(VIN);
    expect(row?.deletedAt).not.toBeNull();
    // A soft delete: §4.7's permanent decode cache and the §5.2 log survive it.
    expect(await db.scanEvents.count()).toBe(1);
  });

  it("writes nothing for a tombstone this device never held", async () => {
    meta(VIN);
    server.deleteVehicle(USER, { p_vin: VIN });

    const result = await pullOnce({ client, currentYear: YEAR });

    expect(result.vehicles).toBe(0);
    expect(await db.vehicles.count()).toBe(0);
  });
});

describe("a server that cannot make progress", () => {
  it("stops rather than asking the same question for ever", async () => {
    // Every page comes back full, and every row carries the instant the cursor already
    // holds — which is what more than 500 rows sharing one server timestamp would look
    // like. `>=` paging would ask again, and again. It takes a hand-built client to
    // produce: a push transaction stamps at most 50 rows with one `now()`.
    const stamp = "2026-09-04T12:00:00.000Z";
    const page = Array.from({ length: PULL_PAGE }, (_, index) => ({
      vin: `1HGCM82633A${String(index).padStart(6, "0")}`,
      unit: null,
      notes: null,
      meta_updated_at: stamp,
      structural: {},
      decode: {},
      first_scanned_at: stamp,
      last_scanned_at: stamp,
      scan_count: 1,
      deleted_at: null,
      updated_at: stamp,
    }));
    let requests = 0;
    const builder = {
      gte: () => builder,
      order: () => builder,
      limit: () => builder,
      then: (resolve: (value: { data: Record<string, unknown>[]; error: null }) => unknown) => {
        requests += 1;
        return Promise.resolve().then(() => resolve({ data: page, error: null }));
      },
    };
    const stalling = {
      from: () => ({ select: () => builder, upsert: async () => ({ error: null }) }),
      rpc: async () => ({ error: null }),
      channel: () => ({ on: () => ({}) as never, subscribe: () => ({}) as never }),
      removeChannel: () => undefined,
    } as unknown as SyncClient;

    const result = await pullOnce({ client: stalling, currentYear: YEAR });

    expect(result.error).toBeNull();
    // Two requests for `vehicles` — the first page, then the one that proves it is stuck —
    // and one for `scan_events`, whose rows carry no `inserted_at` to page by at all.
    // Never PULL_MAX_PAGES of either.
    expect(requests).toBe(3);
    expect(await db.vehicles.count()).toBe(PULL_PAGE);
  });
});

describe("applyPulled — the one apply path", () => {
  it("does nothing at all when a page is empty", async () => {
    expect(await applyPulled({}, YEAR)).toEqual({ vehicles: 0, events: 0 });
  });

  it("is the only writer, so a merged row that changes nothing still writes once", async () => {
    const remote: RemoteVehicle = {
      vin: VIN,
      unit: null,
      notes: null,
      metaUpdatedAt: "2026-09-04T06:00:00.000-06:00",
      structural: null,
      decode: null,
      firstScannedAt: "2026-09-04T06:00:00.000-06:00",
      lastScannedAt: "2026-09-04T06:00:00.000-06:00",
      scanCount: 1,
      deletedAt: null,
      updatedAt: "2026-09-04T06:00:00.000-06:00",
    };
    expect(await applyPulled({ vehicles: [remote] }, YEAR)).toEqual({ vehicles: 1, events: 0 });
    expect(await db.vehicles.count()).toBe(1);
  });
});

describe("[M4] a page the client answers with nothing at all", () => {
  it("reads a null `data` as an empty page rather than as rows", async () => {
    // `SelectResult` allows `{ data: null, error: null }` and supabase-js returns it —
    // `.select()` on a table the role can read but that yields no rows, and every path
    // where the client resolves without a body. `pull.ts` writes `data ?? []` for it and
    // nothing was reaching that: the mutation report lists the coalesce as NoCoverage.
    //
    // What must not happen is a pull that throws on the way through §4.12's one apply
    // path: a pull is on the §6.4 chip's timer and on every realtime notification, so a
    // page like this arriving would turn the sync status into an error for a server that
    // simply had nothing to send.
    let requests = 0;
    const builder = {
      gte: () => builder,
      order: () => builder,
      limit: () => builder,
      then: (resolve: (value: { data: null; error: null }) => unknown) => {
        requests += 1;
        return Promise.resolve().then(() => resolve({ data: null, error: null }));
      },
    };
    const empty = {
      from: () => ({ select: () => builder, upsert: async () => ({ error: null }) }),
      rpc: async () => ({ error: null }),
      channel: () => ({ on: () => ({}) as never, subscribe: () => ({}) as never }),
      removeChannel: () => undefined,
    } as unknown as SyncClient;

    const result = await pullOnce({ client: empty, currentYear: YEAR });

    expect(result).toEqual({ vehicles: 0, events: 0, error: null });
    // One request per table, and no second page asked for on the strength of a null.
    expect(requests).toBe(2);
    expect(await db.vehicles.count()).toBe(0);
    // §5.8's cursors are untouched: nothing was received, so there is no instant to move to.
    const state = await getSyncState();
    expect(state.vehiclesCursor).toBeNull();
    expect(state.eventsCursor).toBeNull();
  });
});
