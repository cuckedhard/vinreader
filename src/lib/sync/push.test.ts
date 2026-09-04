/**
 * §4.12's push: insertion order, batches of 50 per kind, remove on success, back off on
 * failure, never drop.
 *
 * The test that matters most is `keeps a delete ahead of the re-scan that follows it`.
 * A drain that takes one kind at a time satisfies "batches of 50 per kind" and still
 * corrupts the account: `delete_vehicle` sets `deleted_at` and only a *later*
 * `scan_events` insert clears it, so pushing every event before every delete deletes a
 * record the user re-scanned on purpose. Nothing downstream can detect that, which is why
 * it is pinned here.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../storage/db";
import { appendOutbox, scanEventRow, vehicleDeleteRow, vehicleMetaRow } from "../storage/outbox";
import { upsertVehicle } from "../storage/upsert";
import type { OutboxRow, ScanEvent, VehicleRecord } from "../vin/types";
import { PUSH_BACKOFF_MS, backoffFrom, batchRows, isServerRejection, pushOutbox } from "./push";
import { FakeServer, createFakeClient } from "./supabaseFake.testutil";
import type { SyncClient } from "./types";

const VIN = "1HGCM82633A004352"; // §4.11 fixture.
const VIN_B = "1FUJGLDR49SAV1234"; // §4.11 heavy truck.
const USER = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-09-04T12:00:00.000Z");

let server: FakeServer;
let client: SyncClient;

beforeEach(async () => {
  await db.open();
  await Promise.all(db.tables.map((table) => table.clear()));
  server = new FakeServer();
  client = createFakeClient(server, () => USER);
});

/**
 * Rows are stamped by hand because `dueRows` orders by `createdAt`, and rows written in one
 * millisecond keep no order between them (§5.7 has no sequence field). Every ordering
 * assertion here is therefore about rows a user could actually have produced seconds apart.
 */
function at(iso: string, row: OutboxRow): OutboxRow {
  return { ...row, createdAt: iso };
}

function event(overrides: Partial<ScanEvent> = {}): ScanEvent {
  return {
    id: `event-${Math.random().toString(16).slice(2)}`,
    vin: VIN,
    at: "2026-09-04T06:00:00.000-06:00",
    symbology: "code_39",
    raw: `I${VIN}`,
    checkDigitValid: true,
    deviceLabel: "Bay 3",
    ...overrides,
  };
}

async function record(vin = VIN): Promise<VehicleRecord> {
  return upsertVehicle({
    vin,
    origin: "scan",
    symbology: "code_39",
    raw: vin,
    checkDigitValid: true,
  });
}

function upserts(): number[] {
  return server.requests.filter((r) => r.kind === "upsert").map((r) => r.rows);
}

describe("batchRows — §4.12's two rules at once", () => {
  it("cuts each run of one kind into batches of at most 50 and keeps the order", () => {
    const rows: OutboxRow[] = [];
    for (let i = 0; i < 120; i += 1)
      rows.push(at(`2026-01-01T00:00:00.${i}Z`, scanEventRow(event(), "scan")));
    const batches = batchRows(rows);
    expect(batches.map((batch) => batch.length)).toEqual([50, 50, 20]);
    expect(batches.flat().map((row) => row.id)).toEqual(rows.map((row) => row.id));
  });

  it("never batches across a change of kind", () => {
    const rows = [
      scanEventRow(event(), "scan"),
      vehicleDeleteRow(VIN),
      scanEventRow(event(), "scan"),
      scanEventRow(event(), "scan"),
    ];
    expect(batchRows(rows).map((batch) => batch.map((row) => row.kind))).toEqual([
      ["scan_event"],
      ["vehicle_delete"],
      ["scan_event", "scan_event"],
    ]);
  });

  it("returns nothing for an empty queue", () => {
    expect(batchRows([])).toEqual([]);
  });
});

describe("a clean drain", () => {
  it("sends 120 events as three batches and empties the queue", async () => {
    const rows: OutboxRow[] = [];
    for (let i = 0; i < 120; i += 1) {
      rows.push(
        at(`2026-09-04T06:00:00.${String(i).padStart(3, "0")}Z`, scanEventRow(event(), "scan")),
      );
    }
    await appendOutbox(rows);

    const result = await pushOutbox({ client, userId: USER });

    expect(result).toMatchObject({ pushed: 120, deferred: 0, stopped: "drained", error: null });
    expect(upserts()).toEqual([50, 50, 20]);
    expect(await db.outbox.count()).toBe(0);
    expect(server.eventsOf(USER)).toHaveLength(120);
  });

  it("adds the one column the device cannot know, and pushes no raw scan (N3)", async () => {
    await appendOutbox([scanEventRow(event({ id: "event-1" }), "scan")]);
    await pushOutbox({ client, userId: USER });

    const stored = server.events.get("event-1");
    expect(stored).toMatchObject({ user_id: USER, vin: VIN, origin: "scan" });
    expect(stored).not.toHaveProperty("raw");
  });

  it("calls the two RPCs by their locked names with the p_ arguments", async () => {
    const saved = await record();
    await db.outbox.clear();
    await appendOutbox([
      at("2026-09-04T06:00:01Z", vehicleMetaRow(saved)),
      at("2026-09-04T06:00:02Z", vehicleDeleteRow(VIN)),
    ]);

    await pushOutbox({ client, userId: USER });

    const rpcs = server.requests.filter((r) => r.kind === "rpc");
    expect(rpcs.map((r) => r.target)).toEqual(["upsert_vehicle_meta", "delete_vehicle"]);
    expect(rpcs[0].args).toMatchObject({ p_vin: VIN, p_meta_updated_at: saved.metaUpdatedAt });
    expect(rpcs[1].args).toEqual({ p_vin: VIN });
  });

  it("does nothing, and makes no request, when the queue is empty", async () => {
    const result = await pushOutbox({ client, userId: USER });
    expect(result).toMatchObject({ pushed: 0, stopped: "drained" });
    expect(server.requests).toHaveLength(0);
  });

  it("leaves a row that is waiting out a backoff where it is", async () => {
    await appendOutbox([
      { ...scanEventRow(event(), "scan"), nextAttemptAt: "2099-01-01T00:00:00.000Z" },
    ]);
    const result = await pushOutbox({ client, userId: USER });
    expect(result.pushed).toBe(0);
    expect(server.requests).toHaveLength(0);
    expect(await db.outbox.count()).toBe(1);
  });
});

describe("the ordering hazard §4.12's batching rule creates", () => {
  it("keeps a delete ahead of the re-scan that follows it", async () => {
    const saved = await record();
    await db.outbox.clear();
    // What the user did: scanned it, deleted it, then scanned it again a minute later.
    await appendOutbox([
      at("2026-09-04T06:00:00Z", scanEventRow(event({ id: "first" }), "scan")),
      at("2026-09-04T06:00:01Z", vehicleMetaRow(saved)),
      at("2026-09-04T06:01:00Z", vehicleDeleteRow(VIN)),
      at("2026-09-04T06:02:00Z", scanEventRow(event({ id: "second" }), "scan")),
    ]);

    await pushOutbox({ client, userId: USER });

    // A kind-at-a-time drain would send both events, then the delete, and the account would
    // hold a tombstone for a record the user deliberately re-scanned.
    expect(server.requests.map((r) => r.target)).toEqual([
      "scan_events",
      "upsert_vehicle_meta",
      "delete_vehicle",
      "scan_events",
    ]);
    expect(server.vehiclesOf(USER)[0]).toMatchObject({ deleted_at: null, scan_count: 2 });
  });
});

describe("idempotence (§4.12: the event id is the primary key)", () => {
  it("counts one scan when the same batch is pushed twice", async () => {
    const rows = [scanEventRow(event({ id: "event-1" }), "scan")];
    await appendOutbox(rows);
    await pushOutbox({ client, userId: USER });
    // The row was removed on success; a duplicated push is a re-queue of the same id.
    await appendOutbox(rows);
    await pushOutbox({ client, userId: USER });

    expect(server.eventsOf(USER)).toHaveLength(1);
    expect(server.vehiclesOf(USER)[0].scan_count).toBe(1);
    expect(await db.outbox.count()).toBe(0);
  });
});

describe("failure: back off, persist the attempt, never drop", () => {
  it("follows 5 s, 30 s, 2 min, 10 min and then caps", () => {
    expect(PUSH_BACKOFF_MS).toEqual([5_000, 30_000, 120_000, 600_000]);
    expect(backoffFrom(0, NOW)).toBe(new Date(NOW + 5_000).toISOString());
    expect(backoffFrom(1, NOW)).toBe(new Date(NOW + 30_000).toISOString());
    expect(backoffFrom(2, NOW)).toBe(new Date(NOW + 120_000).toISOString());
    expect(backoffFrom(3, NOW)).toBe(new Date(NOW + 600_000).toISOString());
    expect(backoffFrom(9, NOW)).toBe(new Date(NOW + 600_000).toISOString());
    // A row whose attempts field is not a count is scheduled as if it had never failed.
    expect(backoffFrom(Number.NaN, NOW)).toBe(new Date(NOW + 5_000).toISOString());
  });

  it("keeps the row, counts the attempt and schedules the retry", async () => {
    await appendOutbox([scanEventRow(event({ id: "event-1" }), "scan")]);
    server.failNext = () => ({ message: "TypeError: Failed to fetch", code: null });

    const result = await pushOutbox({ client, userId: USER, now: () => NOW });

    expect(result).toMatchObject({ pushed: 0, deferred: 1, stopped: "transport" });
    const row = await db.outbox.get("event-1");
    expect(row).toMatchObject({
      attempts: 1,
      nextAttemptAt: new Date(NOW + 5_000).toISOString(),
      lastError: "TypeError: Failed to fetch",
    });
  });

  it("stops the drain on a failure the server never answered", async () => {
    await appendOutbox([
      at("2026-09-04T06:00:00Z", scanEventRow(event({ id: "a", vin: VIN }), "scan")),
      at("2026-09-04T06:00:01Z", vehicleDeleteRow(VIN_B)),
    ]);
    server.failNext = (request) =>
      request.target === "scan_events" ? { message: "network error", code: null } : null;

    const result = await pushOutbox({ client, userId: USER, now: () => NOW });

    expect(result.stopped).toBe("transport");
    // The unrelated delete is untouched: the radio, not the row, is what failed.
    expect(server.requests.map((r) => r.target)).toEqual(["scan_events"]);
    expect(await db.outbox.get("a")).toMatchObject({ attempts: 1 });
  });

  it("blocks only the VIN the server rejected, and keeps every other VIN moving", async () => {
    const savedB = await record(VIN_B);
    await db.outbox.clear();
    await appendOutbox([
      at("2026-09-04T06:00:00Z", vehicleMetaRow({ ...savedB, vin: "BADVIN" })),
      at("2026-09-04T06:00:01Z", vehicleMetaRow(savedB)),
    ]);

    const result = await pushOutbox({ client, userId: USER, now: () => NOW });

    expect(result).toMatchObject({ pushed: 1, deferred: 1 });
    expect(server.vehiclesOf(USER).map((row) => row.vin)).toEqual([VIN_B]);
    expect(await db.outbox.count()).toBe(1);
  });

  it("does not push a later row for a VIN whose earlier row was rejected", async () => {
    const saved = await record();
    await db.outbox.clear();
    await appendOutbox([
      at("2026-09-04T06:00:00Z", vehicleMetaRow(saved)),
      at("2026-09-04T06:00:01Z", vehicleDeleteRow(VIN)),
    ]);
    server.failNext = (request) =>
      request.target === "upsert_vehicle_meta"
        ? { message: "violates check constraint", code: "23514" }
        : null;

    await pushOutbox({ client, userId: USER, now: () => NOW });

    // The delete would otherwise overtake the meta row it was queued behind.
    expect(server.requests.map((r) => r.target)).toEqual(["upsert_vehicle_meta"]);
    expect(await db.outbox.count()).toBe(2);
  });

  it("isolates one poisoned row instead of letting it wedge its batch", async () => {
    const rows: OutboxRow[] = [];
    for (let i = 0; i < 10; i += 1) {
      rows.push(
        at(
          `2026-09-04T06:00:00.${String(i).padStart(3, "0")}Z`,
          scanEventRow(event({ id: `ok-${i}` }), "scan"),
        ),
      );
    }
    rows.splice(
      5,
      0,
      at("2026-09-04T06:00:00.0045Z", scanEventRow(event({ id: "poison", vin: VIN_B }), "scan")),
    );
    await appendOutbox(rows);
    server.failNext = (request) =>
      request.vins.includes(VIN_B) ? { message: "check constraint", code: "23514" } : null;

    const result = await pushOutbox({ client, userId: USER, now: () => NOW });

    expect(result).toMatchObject({ pushed: 10, deferred: 1 });
    expect(await db.outbox.toArray()).toMatchObject([{ id: "poison", attempts: 1 }]);
  });

  it("stops a drain the server is refusing wholesale", async () => {
    const rows: OutboxRow[] = [];
    for (let i = 0; i < 8; i += 1) {
      const saved = { ...(await record()), vin: VIN };
      rows.push(at(`2026-09-04T06:00:0${i}Z`, vehicleMetaRow({ ...saved, vin: `VIN${i}` })));
    }
    await db.outbox.clear();
    await appendOutbox(rows);
    server.failNext = () => ({ message: "permission denied", code: "42501" });

    const result = await pushOutbox({ client, userId: USER, now: () => NOW });

    expect(result.stopped).toBe("rejections");
    expect(result.deferred).toBe(5);
    expect(await db.outbox.count()).toBe(8);
  });
});

describe("isServerRejection", () => {
  it("treats a SQLSTATE as the server's verdict and everything else as transport", () => {
    expect(isServerRejection({ message: "x", code: "23514" })).toBe(true);
    expect(isServerRejection({ message: "x", code: "42501" })).toBe(true);
    // PostgREST's own codes — an expired JWT among them — say nothing about the row.
    expect(isServerRejection({ message: "x", code: "PGRST301" })).toBe(false);
    expect(isServerRejection({ message: "Failed to fetch", code: null })).toBe(false);
    expect(isServerRejection({ message: "Failed to fetch" })).toBe(false);
    expect(isServerRejection(null)).toBe(false);
  });
});
