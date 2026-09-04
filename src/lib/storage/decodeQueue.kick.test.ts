/**
 * §13.2 adversary, round 3 of `harden S1`. The decode run a **scan** kicks off, against
 * the decode run §5.4's own triggers are already driving.
 *
 * §4.7: "one request per VIN ever (cache is permanent; a manual Refresh details button on
 * the sheet is the only way to re-fetch)". `startDecodeQueue` enforces that with an
 * in-flight guard and `decodeQueue.test.ts` pins it ("does not start a second run while
 * one is in flight"). The scan path does not go through that guard: `useVinCommit.kickDecode`
 * calls `runDecodeQueueOnce` directly (useVinCommit.ts:24) on every successful save, and
 * `Shell` wires `startDecodeQueue` for the lifetime of the app (Shell.tsx:11).
 *
 * Deterministic: the response is held on an explicit gate, never on a delay, so no
 * assertion here depends on how fast anything runs.
 *
 * Finding: [R3-A] — both tests FAIL today.
 *
 * [R3-Q] adds the third entry point to the same argument. R3-A's guard is per *pass*, and
 * `refreshDecode` cannot take it — a Refresh button that goes quiet whenever a background
 * pass happens to be running is a dead control (P7). The guard the two paths share is
 * per VIN instead, so the queue skips a VIN Refresh has out and Refresh joins the answer
 * already coming rather than opening a second connection for it (§4.7).
 *
 * [R5-Q] is the half of R3-Q that its own tests never reached: every R3-Q case releases a
 * *successful* response, so the join path's effect on §5.4's attempt counter was never
 * exercised. The join was written above `refreshDecode`'s arming transaction, so the one
 * thing the tap is for — putting `attempts` back to 0 — was skipped exactly when a request
 * was already out. FAILS before the fix.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "./db";
import {
  DECODE_MAX_ATTEMPTS,
  refreshDecode,
  runDecodeQueueOnce,
  startDecodeQueue,
} from "./decodeQueue";
import { upsertVehicle } from "./upsert";
import { VPIC_ENDPOINT } from "../vpic/client";
import type { VpicRawResponse } from "../vpic/types";

const VIN_A = "1HGCM82633A004352";
const T_OLD = "2026-01-05T08:15:00.000-06:00";

/** Synthetic, hand-built to the §4.7 documented shape. Nothing here came off the wire. */
const OK_BODY: VpicRawResponse = {
  Count: 1,
  Message: "synthetic",
  SearchCriteria: null,
  Results: [{ ErrorCode: "0", Make: "HONDA", Model: "Accord", ModelYear: "2003" }],
};

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
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function vinOf(url: string): string {
  return url.slice(VPIC_ENDPOINT.length + 1).split("?")[0]!;
}

/** A fetch whose response is released by hand, so a request can be held open. */
function gatedFetch(body: () => VpicRawResponse) {
  const vins: string[] = [];
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const impl = (async (input: RequestInfo | URL): Promise<Response> => {
    vins.push(vinOf(String(input)));
    await gate;
    return new Response(JSON.stringify(body()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { vins, impl, release: (): void => open() };
}

const noSleep = async (): Promise<void> => {};
const stops: (() => void)[] = [];

beforeEach(async () => {
  await db.open();
  await Promise.all(db.tables.map((table) => table.clear()));
  defineGlobal("navigator", { onLine: true, userAgent: "vitest" });
  defineGlobal("document", { visibilityState: "visible" });
  defineGlobal("window", new EventTarget());
  await upsertVehicle({
    vin: VIN_A,
    origin: "scan",
    symbology: "code_39",
    raw: VIN_A,
    checkDigitValid: true,
    at: T_OLD,
  });
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const [name, descriptor] of Object.entries(REAL)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[name];
  }
});

describe("[R3-A] §4.7 one request per VIN, across both decode entry points", () => {
  it("does not re-request a VIN a running queue already has in flight", async () => {
    const network = gatedFetch(() => OK_BODY);
    const deps = { fetchImpl: network.impl, sleep: noSleep };

    // §5.4 trigger 1: the app is up, and the request for the one pending row is out.
    stops.push(startDecodeQueue(deps));
    await settle();
    expect(network.vins).toEqual([VIN_A]);

    // A scan lands while that request is still out. This is `kickDecode` verbatim
    // (useVinCommit.ts:24) — the guard inside `startDecodeQueue` is not in this path.
    const kicked = runDecodeQueueOnce(deps);
    await settle();
    network.release();
    await kicked;
    await settle();

    // FAILS today: ["1HGCM82633A004352", "1HGCM82633A004352"] — one VIN, two requests.
    // §4.7's budget is one request per VIN *ever*; the client spends up to 38 s on a bad
    // radio (10 s timeout x 3 attempts, 2 s + 6 s backoff), so the overlap is the field
    // case, not the edge case.
    expect(network.vins).toEqual([VIN_A]);
  });

  it("spends one attempt per failed round, not one per overlapping run", async () => {
    const network = gatedFetch(() => {
      throw new Error("connection refused");
    });
    const deps = { fetchImpl: network.impl, sleep: noSleep };

    stops.push(startDecodeQueue(deps));
    await settle();
    const kicked = runDecodeQueueOnce(deps);
    network.release();
    await kicked;
    await settle(20);

    // §5.4 gives a row ten attempts before it is written off as `failed` and drops out
    // of the automatic queue until the user finds "Refresh details". Two overlapping
    // runs spend two of the ten for one round of bad signal, so the row is written off
    // in half the rounds §5.4 allows. FAILS today: attempts is 2.
    expect((await db.vehicles.get(VIN_A))!.decode.attempts).toBe(1);
  });
});

describe("[R3-Q] §4.7 one request per VIN, with Refresh as the third entry point", () => {
  it("does not re-request a VIN Refresh already has in flight", async () => {
    const network = gatedFetch(() => OK_BODY);
    const deps = { fetchImpl: network.impl, sleep: noSleep };

    // The user is on the sheet and taps "Refresh details" (§4.7's one sanctioned
    // re-fetch); that request is out, against a row it has armed `pending`.
    const refreshed = refreshDecode(VIN_A, deps);
    await settle();
    expect(network.vins).toEqual([VIN_A]);

    // §5.4's poll comes round while it is still out and finds that pending row. R3-A's
    // pass-level guard is no help here: Refresh never took it. Started rather than
    // awaited, so a pass that does issue the second request is caught at the assertion
    // below instead of deadlocking on the gate this test still holds.
    const passed = runDecodeQueueOnce(deps);
    await settle();
    expect(network.vins).toEqual([VIN_A]);

    network.release();
    expect(await passed).toBe(0);
    await refreshed;
    await settle();

    // One VIN, one request, and the skipped row still got its answer.
    expect(network.vins).toEqual([VIN_A]);
    expect((await db.vehicles.get(VIN_A))!.decode.status).toBe("ok");
  });

  it("joins the request the queue has out rather than opening a second", async () => {
    const network = gatedFetch(() => OK_BODY);
    const deps = { fetchImpl: network.impl, sleep: noSleep };

    // §5.4 trigger 1: the app is up and the request for the pending row is out.
    stops.push(startDecodeQueue(deps));
    await settle();
    expect(network.vins).toEqual([VIN_A]);

    let landed = false;
    const refreshed = refreshDecode(VIN_A, deps).then(() => {
      landed = true;
    });
    await settle();
    expect(network.vins).toEqual([VIN_A]);
    // The tap is not silently dropped, which is the whole reason the guard is per VIN and
    // not per pass: it resolves when the answer lands, so the sheet's button stays busy
    // and then fills in front of the user (P7).
    expect(landed).toBe(false);

    network.release();
    await refreshed;

    expect(landed).toBe(true);
    expect(network.vins).toEqual([VIN_A]);
    expect((await db.vehicles.get(VIN_A))!.decode.status).toBe("ok");
  });

  it("makes one request out of two taps on the same VIN", async () => {
    const network = gatedFetch(() => OK_BODY);
    const deps = { fetchImpl: network.impl, sleep: noSleep };

    const first = refreshDecode(VIN_A, deps);
    await settle();
    const second = refreshDecode(VIN_A, deps);
    await settle();

    network.release();
    await Promise.all([first, second]);

    expect(network.vins).toEqual([VIN_A]);
    expect((await db.vehicles.get(VIN_A))!.decode.status).toBe("ok");
  });
});

/**
 * §5.4's counter, on the path R3-Q added and never failed a request on.
 *
 * `refreshDecode`'s reset exists so "a transient failure puts the row back in the normal
 * queue instead of leaving it failed on one miss" — the file's own words. §5.4 makes the
 * tenth attempt terminal and names Refresh as the one way back for a `failed` row, so a
 * tap that charges an attempt instead of clearing the counter is the trapdoor where the
 * escape hatch should be.
 *
 * The window is the field case: §4.7's client spends up to ~28 s on a bad radio (10 s
 * timeout x 3 attempts, 2 s + 6 s backoff) against §5.4's 60 s poll, so roughly half of
 * all Refresh taps on an unfilled row land while the queue's request is still out.
 */
async function setAttempts(vin: string, attempts: number): Promise<void> {
  const row = await db.vehicles.get(vin);
  if (!row) throw new Error(`no row for ${vin}`);
  await db.vehicles.put({
    ...row,
    decode: { ...row.decode, status: "pending", attempts, lastError: "connection refused" },
  });
}

describe("[R5-Q] Refresh resets §5.4's attempts on the join path too", () => {
  it("is not the tap that writes the row off as failed", async () => {
    // One short of §5.4's ten: the next charged attempt is terminal.
    await setAttempts(VIN_A, DECODE_MAX_ATTEMPTS - 1);

    const network = gatedFetch(() => {
      throw new Error("connection refused");
    });
    const deps = { fetchImpl: network.impl, sleep: noSleep };

    // §5.4's poll has this row's request out and held, the way a dead radio holds it.
    const passed = runDecodeQueueOnce(deps);
    await settle();
    expect(network.vins).toEqual([VIN_A]);

    // The user, looking at a sheet that has not filled, taps "Refresh details" — §4.7's
    // one sanctioned re-fetch. It joins the request already out (§4.7 budgets one per
    // VIN), which is right; what it must not do is skip the arming that reset exists for.
    const refreshed = refreshDecode(VIN_A, deps);
    await settle();

    network.release();
    await passed;
    await refreshed;
    await settle(20);

    const decode = (await db.vehicles.get(VIN_A))!.decode;
    // FAILS before the fix: status "failed", attempts 10. The tap the user made to retry
    // is the tap that takes the row out of §5.4's automatic queue.
    expect(decode.status).toBe("pending");
    // 1, not 10 and not 2: the reset ran, and the join still spent §4.7's single request
    // once — a second request would have charged a second attempt.
    expect(decode.attempts).toBe(1);
  });

  it("puts a row already written off back in §5.4's automatic queue", async () => {
    // §5.4: a `failed` row is "still retried on manual Refresh details" — and Refresh is
    // reached from the sheet at any moment, including while the queue holds another VIN.
    await setAttempts(VIN_A, DECODE_MAX_ATTEMPTS);
    const row = (await db.vehicles.get(VIN_A))!;
    await db.vehicles.put({ ...row, decode: { ...row.decode, status: "failed" } });

    const network = gatedFetch(() => OK_BODY);
    const deps = { fetchImpl: network.impl, sleep: noSleep };

    const refreshed = refreshDecode(VIN_A, deps);
    await settle();
    expect(network.vins).toEqual([VIN_A]);

    // A second tap while the first is out: it joins, and arming is idempotent apart from
    // the one field that matters.
    const second = refreshDecode(VIN_A, deps);
    await settle();
    expect(network.vins).toEqual([VIN_A]);

    network.release();
    await Promise.all([refreshed, second]);
    await settle();

    const decode = (await db.vehicles.get(VIN_A))!.decode;
    expect(decode.status).toBe("ok");
    expect(decode.attempts).toBe(0);
  });
});
