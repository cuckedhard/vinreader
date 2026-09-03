/**
 * §5.4 / §4.7 queue behaviour, against fake-indexeddb and an injected fetch.
 *
 * Every vPIC body here is SYNTHETIC: it is hand-built to the §4.7 documented shape
 * (`{ Count, Message, SearchCriteria, Results: [flat strings] }`). The network is
 * unavailable in this environment, so no field below was captured from a live response.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VehicleDecode } from "../vin/types";
import { VPIC_ENDPOINT } from "../vpic/client";
import type { VpicDeps, VpicRawResponse, VpicResult } from "../vpic/types";
import { db } from "./db";
import {
  applyDecodeResult,
  DECODE_MAX_ATTEMPTS,
  refreshDecode,
  runDecodeQueueOnce,
  startDecodeQueue,
} from "./decodeQueue";
import { upsertVehicle } from "./upsert";

const VIN_A = "1HGCM82633A004352";
const VIN_B = "JH4KA7561PC008269";
const VIN_C = "5YJ3E1EA6PF384836";
const T_OLD = "2026-01-05T08:15:00.000-06:00";
const T_MID = "2026-02-11T09:30:00.000-06:00";
const T_NEW = "2026-03-20T14:45:00.000-06:00";
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

/** A clean decode. `BodyClass` is empty on purpose: the client drops unknowns (N2). */
const OK_RESULTS: Record<string, string> = {
  ErrorCode: "0",
  ErrorText: "0 - VIN decoded clean. Check Digit (9th position) is correct",
  Make: "HONDA",
  Model: "Accord",
  ModelYear: "2003",
  Manufacturer: "AMERICAN HONDA MOTOR CO., INC.",
  VehicleType: "PASSENGER CAR",
  BodyClass: "",
};

function bodyOf(results: Record<string, string>): VpicRawResponse {
  return {
    Count: 1,
    Message: "Results returned successfully",
    SearchCriteria: null,
    Results: [results],
  };
}

interface FetchDouble {
  impl: typeof fetch;
  urls: string[];
}

/**
 * A fetch double. The handler either returns a body to serialise or throws, which the
 * client treats as a retryable transport failure (§4.7). Cast because a plain async
 * function does not carry `fetch`'s overloads.
 */
function fetchDouble(handler: (vin: string) => VpicRawResponse): FetchDouble {
  const urls: string[] = [];
  const impl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    return new Response(JSON.stringify(handler(vinOf(url))), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, urls };
}

function failingFetch(message: string): FetchDouble {
  return fetchDouble(() => {
    throw new Error(message);
  });
}

function vinOf(url: string): string {
  return url.slice(VPIC_ENDPOINT.length + 1).split("?")[0];
}

function vinsOf(urls: string[]): string[] {
  return urls.map(vinOf);
}

/** Backoff waits are real seconds under §4.7; tests skip them. */
const noSleep = async (): Promise<void> => {};

function depsFor(double: FetchDouble): VpicDeps {
  return { fetchImpl: double.impl, sleep: noSleep };
}

async function seed(vin: string, at: string): Promise<void> {
  await upsertVehicle({
    vin,
    origin: "scan",
    symbology: "code_39",
    raw: vin,
    checkDigitValid: true,
    at,
  });
}

async function decodeOf(vin: string): Promise<VehicleDecode> {
  const row = await db.vehicles.get(vin);
  if (!row) throw new Error(`no row for ${vin}`);
  return row.decode;
}

async function patchDecode(vin: string, patch: Partial<VehicleDecode>): Promise<void> {
  const row = await db.vehicles.get(vin);
  if (!row) throw new Error(`no row for ${vin}`);
  await db.vehicles.put({ ...row, decode: { ...row.decode, ...patch } });
}

async function tombstone(vin: string): Promise<void> {
  const row = await db.vehicles.get(vin);
  if (!row) throw new Error(`no row for ${vin}`);
  await db.vehicles.put({ ...row, deletedAt: T_MID });
}

function pendingResult(lastError: string): VpicResult {
  return { status: "pending", fields: {}, errorText: null, lastError };
}

// The queue reads browser globals that node does not define, and one test needs them to
// lie. Each is replaced per test and put back afterwards.
const REAL: Record<string, PropertyDescriptor | undefined> = {
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  document: Object.getOwnPropertyDescriptor(globalThis, "document"),
  window: Object.getOwnPropertyDescriptor(globalThis, "window"),
};

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

/** Let pending Dexie work and awaited fetches drain without waiting on real timers. */
async function settle(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

const stops: (() => void)[] = [];

beforeEach(async () => {
  await db.open();
  await Promise.all(db.tables.map((table) => table.clear()));
  defineGlobal("navigator", { onLine: true, userAgent: "vitest" });
  defineGlobal("document", { visibilityState: "visible" });
  defineGlobal("window", new EventTarget());
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const [name, descriptor] of Object.entries(REAL)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[name];
  }
});

describe("applyDecodeResult", () => {
  it("lands a terminal result and leaves attempts alone", async () => {
    await seed(VIN_A, T_OLD);
    await patchDecode(VIN_A, { attempts: 3, lastError: "Timed out after 10000 ms" });

    await applyDecodeResult(VIN_A, {
      status: "ok",
      fields: { Make: "HONDA", Model: "Accord" },
      errorText: "0 - VIN decoded clean",
      lastError: null,
    });

    const decode = await decodeOf(VIN_A);
    expect(decode.status).toBe("ok");
    expect(decode.fields).toEqual({ Make: "HONDA", Model: "Accord" });
    expect(decode.fetchedAt).toMatch(ISO_WITH_OFFSET);
    expect(decode.lastError).toBeNull();
    expect(decode.source).toBe("nhtsa_vpic");
    // A success is not an attempt; the counter measures transport failures (§5.4).
    expect(decode.attempts).toBe(3);
  });

  it("keeps the structural fields and the rest of the record untouched", async () => {
    await seed(VIN_A, T_OLD);
    await applyDecodeResult(VIN_A, {
      status: "unsupported",
      fields: { ErrorCode: "0" },
      errorText: null,
      lastError: null,
    });

    const row = await db.vehicles.get(VIN_A);
    expect(row?.structural.wmi).toBe("1HG");
    expect(row?.scanCount).toBe(1);
    expect(row?.decode.status).toBe("unsupported");
  });

  it("spends one attempt and records lastError on a pending result", async () => {
    await seed(VIN_A, T_OLD);

    await applyDecodeResult(VIN_A, pendingResult("Timed out after 10000 ms"));

    const decode = await decodeOf(VIN_A);
    expect(decode.status).toBe("pending");
    expect(decode.attempts).toBe(1);
    expect(decode.lastError).toBe("Timed out after 10000 ms");
    expect(decode.fetchedAt).toBeNull();
  });

  it("flips to failed on the tenth pending attempt", async () => {
    await seed(VIN_A, T_OLD);
    await patchDecode(VIN_A, { attempts: DECODE_MAX_ATTEMPTS - 2 });

    await applyDecodeResult(VIN_A, pendingResult("HTTP 503 Service Unavailable"));
    expect(await decodeOf(VIN_A)).toMatchObject({ status: "pending", attempts: 9 });

    await applyDecodeResult(VIN_A, pendingResult("HTTP 503 Service Unavailable"));
    expect(await decodeOf(VIN_A)).toMatchObject({
      status: "failed",
      attempts: DECODE_MAX_ATTEMPTS,
      lastError: "HTTP 503 Service Unavailable",
    });
  });

  it("does not throw when the record was deleted mid-flight", async () => {
    await expect(
      applyDecodeResult(VIN_A, {
        status: "ok",
        fields: OK_RESULTS,
        errorText: null,
        lastError: null,
      }),
    ).resolves.toBeUndefined();
    expect(await db.vehicles.count()).toBe(0);
    expect(await db.wmi.count()).toBe(0);
  });
});

describe("WMI cache (§5.5)", () => {
  it("upserts the WMI row from a decode that names the manufacturer", async () => {
    await seed(VIN_A, T_OLD);
    const double = fetchDouble(() => bodyOf(OK_RESULTS));

    await runDecodeQueueOnce(depsFor(double));

    const row = await db.wmi.get("1HG");
    expect(row).toMatchObject({
      wmi: "1HG",
      manufacturer: "AMERICAN HONDA MOTOR CO., INC.",
      make: "HONDA",
      source: "vpic",
    });
    expect(row?.updatedAt).toMatch(ISO_WITH_OFFSET);
  });

  it("writes no WMI row when Manufacturer is empty", async () => {
    await seed(VIN_A, T_OLD);
    // §4.7: an empty string is how vPIC says "unknown".
    const double = fetchDouble(() => bodyOf({ ...OK_RESULTS, Manufacturer: "" }));

    await runDecodeQueueOnce(depsFor(double));

    expect(await decodeOf(VIN_A)).toMatchObject({ status: "ok" });
    expect(await db.wmi.count()).toBe(0);
  });

  it("writes no WMI row for a pending result", async () => {
    await seed(VIN_A, T_OLD);
    await applyDecodeResult(VIN_A, pendingResult("Network error: fetch failed"));
    expect(await db.wmi.count()).toBe(0);
  });

  it("caches the manufacturer from an off-highway result that carries one", async () => {
    await seed(VIN_A, T_OLD);
    const double = fetchDouble(() =>
      bodyOf({ ErrorCode: "0", Manufacturer: "CATERPILLAR INC.", Make: "", Model: "" }),
    );

    await runDecodeQueueOnce(depsFor(double));

    expect(await decodeOf(VIN_A)).toMatchObject({ status: "unsupported" });
    expect(await db.wmi.get("1HG")).toMatchObject({ manufacturer: "CATERPILLAR INC.", make: null });
  });
});

describe("runDecodeQueueOnce", () => {
  it("processes pending rows oldest first, one request each", async () => {
    // Scan order is deliberately not primary-key order (VIN_A, VIN_C, VIN_B), or the
    // assertion would pass on Dexie's natural ordering alone.
    await seed(VIN_A, T_NEW);
    await seed(VIN_B, T_OLD);
    await seed(VIN_C, T_MID);
    const double = fetchDouble(() => bodyOf(OK_RESULTS));

    expect(await runDecodeQueueOnce(depsFor(double))).toBe(3);
    expect(vinsOf(double.urls)).toEqual([VIN_B, VIN_C, VIN_A]);
  });

  it("never re-requests a VIN that already has a terminal status (§4.7)", async () => {
    await seed(VIN_A, T_OLD);
    await seed(VIN_B, T_MID);
    await seed(VIN_C, T_NEW);
    await patchDecode(VIN_A, { status: "ok" });
    await patchDecode(VIN_B, { status: "partial" });
    await patchDecode(VIN_C, { status: "unsupported" });
    const double = fetchDouble(() => bodyOf(OK_RESULTS));

    expect(await runDecodeQueueOnce(depsFor(double))).toBe(0);
    expect(double.urls).toEqual([]);
  });

  it("skips a failed row on every later automatic run", async () => {
    await seed(VIN_A, T_OLD);
    await patchDecode(VIN_A, { attempts: DECODE_MAX_ATTEMPTS - 2 });
    const double = failingFetch("connection refused");
    const deps = depsFor(double);

    expect(await runDecodeQueueOnce(deps)).toBe(1);
    expect(await decodeOf(VIN_A)).toMatchObject({ status: "pending", attempts: 9 });

    expect(await runDecodeQueueOnce(deps)).toBe(1);
    expect(await decodeOf(VIN_A)).toMatchObject({
      status: "failed",
      attempts: DECODE_MAX_ATTEMPTS,
    });
    // §4.7 allows three attempts per request, so two requests are six calls.
    expect(double.urls).toHaveLength(6);

    expect(await runDecodeQueueOnce(deps)).toBe(0);
    expect(double.urls).toHaveLength(6);
  });

  it("records the transport failure without wiping earlier fields", async () => {
    await seed(VIN_A, T_OLD);
    const double = failingFetch("connection refused");

    await runDecodeQueueOnce(depsFor(double));

    const decode = await decodeOf(VIN_A);
    expect(decode.status).toBe("pending");
    expect(decode.lastError).toContain("connection refused");
    expect(decode.fields).toEqual({});
  });

  it("does nothing and returns 0 when the device is offline", async () => {
    await seed(VIN_A, T_OLD);
    defineGlobal("navigator", { onLine: false });
    const double = fetchDouble(() => bodyOf(OK_RESULTS));

    expect(await runDecodeQueueOnce(depsFor(double))).toBe(0);
    expect(double.urls).toEqual([]);
    expect(await decodeOf(VIN_A)).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("leaves a tombstoned row's one permanent request unspent", async () => {
    await seed(VIN_A, T_OLD);
    await tombstone(VIN_A);
    const double = fetchDouble(() => bodyOf(OK_RESULTS));

    expect(await runDecodeQueueOnce(depsFor(double))).toBe(0);
    expect(double.urls).toEqual([]);
  });
});

describe("refreshDecode", () => {
  it("re-fetches a row that already decoded ok", async () => {
    await seed(VIN_A, T_OLD);
    const first = fetchDouble(() => bodyOf(OK_RESULTS));
    await runDecodeQueueOnce(depsFor(first));
    expect(await decodeOf(VIN_A)).toMatchObject({ status: "ok" });

    const second = fetchDouble(() => bodyOf({ ...OK_RESULTS, Model: "Accord Hybrid" }));
    await refreshDecode(VIN_A, depsFor(second));

    expect(vinsOf(second.urls)).toEqual([VIN_A]);
    expect((await decodeOf(VIN_A)).fields.Model).toBe("Accord Hybrid");
  });

  it("resets attempts so a refreshed row rejoins the queue instead of staying failed", async () => {
    await seed(VIN_A, T_OLD);
    await patchDecode(VIN_A, {
      status: "failed",
      attempts: DECODE_MAX_ATTEMPTS,
      lastError: "gone",
    });
    const double = failingFetch("connection refused");

    await refreshDecode(VIN_A, depsFor(double));

    const decode = await decodeOf(VIN_A);
    expect(decode.status).toBe("pending");
    expect(decode.attempts).toBe(1);
    expect(decode.lastError).toContain("connection refused");

    // Back in the automatic queue, which a "failed" row would not be.
    const recovered = fetchDouble(() => bodyOf(OK_RESULTS));
    expect(await runDecodeQueueOnce(depsFor(recovered))).toBe(1);
    expect(await decodeOf(VIN_A)).toMatchObject({ status: "ok", attempts: 1 });
  });

  it("does not request a VIN that has no record", async () => {
    const double = fetchDouble(() => bodyOf(OK_RESULTS));
    await expect(refreshDecode(VIN_A, depsFor(double))).resolves.toBeUndefined();
    expect(double.urls).toEqual([]);
  });
});

describe("startDecodeQueue", () => {
  it("runs once immediately", async () => {
    await seed(VIN_A, T_OLD);
    const double = fetchDouble(() => bodyOf(OK_RESULTS));

    stops.push(startDecodeQueue(depsFor(double)));
    await settle();

    expect(vinsOf(double.urls)).toEqual([VIN_A]);
    expect(await decodeOf(VIN_A)).toMatchObject({ status: "ok" });
  });

  it("does not start a second run while one is in flight", async () => {
    await seed(VIN_A, T_OLD);
    await seed(VIN_B, T_MID);
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const urls: string[] = [];
    const impl = (async (input: RequestInfo | URL): Promise<Response> => {
      urls.push(String(input));
      await gate;
      return new Response(JSON.stringify(bodyOf(OK_RESULTS)), { status: 200 });
    }) as typeof fetch;

    stops.push(startDecodeQueue({ fetchImpl: impl, sleep: noSleep }));
    await settle();
    expect(urls).toHaveLength(1);

    // §4.7 forbids fanning out into concurrent requests for the same VIN.
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(urls).toHaveLength(1);

    release();
    await settle(20);
    expect(vinsOf(urls)).toEqual([VIN_A, VIN_B]);
  });

  it("runs again on the online event", async () => {
    await seed(VIN_A, T_OLD);
    const double = failingFetch("connection refused");
    stops.push(startDecodeQueue(depsFor(double)));
    await settle();
    expect(await decodeOf(VIN_A)).toMatchObject({ attempts: 1 });

    window.dispatchEvent(new Event("online"));
    await settle();

    expect(await decodeOf(VIN_A)).toMatchObject({ attempts: 2 });
  });

  it("stops listening once the returned teardown runs", async () => {
    await seed(VIN_A, T_OLD);
    const double = failingFetch("connection refused");
    const stop = startDecodeQueue(depsFor(double));
    await settle();
    const after = double.urls.length;

    stop();
    window.dispatchEvent(new Event("online"));
    await settle();

    expect(double.urls).toHaveLength(after);
    expect(await decodeOf(VIN_A)).toMatchObject({ attempts: 1 });
  });
});
