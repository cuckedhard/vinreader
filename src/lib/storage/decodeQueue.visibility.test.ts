/**
 * [M3] §5.4's third trigger: "every 60 s **while the app is visible and online**".
 *
 * The two clauses of that sentence live in `startDecodeQueue`'s `onTick`, and nothing was
 * measuring them. `decodeQueue.env.test.ts`'s "polls only while the document is visible"
 * runs both branches — so §13.5's branch coverage is satisfied — and then asserts
 * `calls.length >= whileHidden` against a database with nothing pending, which is true of
 * every possible implementation including one with no visibility check at all. That is the
 * R4-H' / F1-a class: a guard that cannot fail. `bun run mutate` says the same thing from
 * the other side — ten survivors on `isVisible`, the whole function's worth.
 *
 * These tests put a pending row in front of the poll, so the two branches have different
 * observable outcomes: a request goes out, or it does not.
 *
 * Why the tab being hidden matters here rather than being a nicety: §5.4's poll is the one
 * thing that retries a `pending` decode, and §4.7 gives each VIN exactly one request. A
 * poll that ran in the background would spend that request — up to ~28 s of radio per row
 * on a phone in a pocket in a yard with no signal — and §5.4's counter would write the row
 * off as `failed` after ten of them, which takes it out of the automatic queue entirely.
 *
 * Fake timers are limited to `setInterval`/`clearInterval` on purpose: fake-indexeddb and
 * the awaits inside a pass run on real `setTimeout`, and faking those wedges Dexie.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VPIC_ENDPOINT } from "../vpic/client";
import type { VpicDeps, VpicRawResponse } from "../vpic/types";
import { db } from "./db";
import { DECODE_POLL_MS, startDecodeQueue } from "./decodeQueue";
import { upsertVehicle } from "./upsert";

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

function dropGlobal(name: string): void {
  delete (globalThis as unknown as Record<string, unknown>)[name];
}

function vinOf(url: string): string {
  return url.slice(VPIC_ENDPOINT.length + 1).split("?")[0]!;
}

interface Net {
  vins: string[];
  deps: VpicDeps;
}

function countingNet(): Net {
  const vins: string[] = [];
  const impl = (async (input: RequestInfo | URL): Promise<Response> => {
    vins.push(vinOf(String(input)));
    return new Response(JSON.stringify(OK_BODY), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { vins, deps: { fetchImpl: impl, sleep: async () => {} } };
}

/** Let Dexie work and awaited fetches drain on real timers. */
async function settle(turns = 12): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
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
  vi.useRealTimers();
  for (const [name, descriptor] of Object.entries(REAL)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else dropGlobal(name);
  }
});

async function seedPending(): Promise<void> {
  await upsertVehicle({
    vin: VIN_A,
    origin: "scan",
    symbology: "code_39",
    raw: VIN_A,
    checkDigitValid: true,
    at: T_OLD,
  });
}

describe("[M3] §5.4's 60 s poll runs while the app is visible and online", () => {
  it("stays off the radio while the tab is hidden, and goes out on the first tick after it returns", async () => {
    await seedPending();
    // The queue starts while the phone has no signal, so `startDecodeQueue`'s immediate
    // pass is turned away by §5.4's online check and the pending row is still pending.
    defineGlobal("navigator", { onLine: false });
    defineGlobal("document", { visibilityState: "hidden" });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    const net = countingNet();
    stops.push(startDecodeQueue(net.deps));
    await settle();
    expect(net.vins).toEqual([]);

    // Signal comes back with the phone still in a pocket. Three poll periods pass.
    defineGlobal("navigator", { onLine: true });
    await vi.advanceTimersByTimeAsync(DECODE_POLL_MS * 3);
    await settle();
    // §5.4: the poll is "while the app is **visible** and online". Nothing has been spent.
    expect(net.vins).toEqual([]);
    expect((await db.vehicles.get(VIN_A))!.decode).toMatchObject({
      status: "pending",
      attempts: 0,
    });

    // The user opens the app again; the next tick finds the row.
    defineGlobal("document", { visibilityState: "visible" });
    await vi.advanceTimersByTimeAsync(DECODE_POLL_MS);
    await settle();
    expect(net.vins).toEqual([VIN_A]);
    expect((await db.vehicles.get(VIN_A))!.decode.status).toBe("ok");
  });

  it("polls in a runtime that has no document at all", async () => {
    // The file's own rule: "no `document` means nothing is hiding the app". A missing
    // signal must not stall §5.4 forever — a queue that never runs is a sheet that never
    // fills, and §4.7's answer only ever arrives through this poll.
    await seedPending();
    defineGlobal("navigator", { onLine: false });
    dropGlobal("document");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    const net = countingNet();
    stops.push(startDecodeQueue(net.deps));
    await settle();
    expect(net.vins).toEqual([]);

    defineGlobal("navigator", { onLine: true });
    await vi.advanceTimersByTimeAsync(DECODE_POLL_MS);
    await settle();
    expect(net.vins).toEqual([VIN_A]);
  });

  it("leaves no interval running once the teardown has been called", async () => {
    // The Shell mounts this for the life of the app and unmounts it on sign-out and on
    // "Clear all data"; an interval that outlives its teardown keeps polling against a
    // database the caller believes it has finished with.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const net = countingNet();
    const stop = startDecodeQueue(net.deps);
    await settle();
    expect(vi.getTimerCount()).toBe(1);

    stop();
    expect(vi.getTimerCount()).toBe(0);

    // And a row that arrives afterwards is nobody's business any more.
    await seedPending();
    await vi.advanceTimersByTimeAsync(DECODE_POLL_MS * 3);
    await settle();
    expect(net.vins).toEqual([]);
  });
});
