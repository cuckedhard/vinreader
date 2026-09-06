import { afterEach, describe, expect, it, vi } from "vitest";
import { runDecodeQueueOnce, startDecodeQueue } from "./decodeQueue";

/**
 * The queue's environment guards, exercised in BOTH directions. The unit tests run
 * under node, where `window` and `document` are absent, so without these the
 * browser-side branch of every guard would never execute (§5.4, P7).
 *
 * [TA2] `document.visibilityState` used to be one of them, under "polls only while the
 * document is visible". It ran both branches of `isVisible()` — satisfying §13.5's branch
 * coverage — and then asserted `fetchImpl.mock.calls.length >= whileHidden` against a
 * database with nothing pending, which is true of every implementation including one with
 * no visibility check at all: the R4-H' / F1-a class, a guard that cannot fail. `bun run
 * mutate` said the same from the other side, ten survivors on a nine-line function. It is
 * gone, and §5.4's "every 60 s while the app is visible and online" is measured in
 * `decodeQueue.visibility.test.ts` instead, against a pending row, where the two branches
 * differ in what reaches the network.
 */
const offlineFetch = (async () => {
  throw new Error("no network");
}) as unknown as typeof fetch;

afterEach(() => vi.unstubAllGlobals());

describe("decode queue environment guards", () => {
  it("treats a missing navigator as online", async () => {
    vi.stubGlobal("navigator", undefined);
    await expect(
      runDecodeQueueOnce({ fetchImpl: offlineFetch, sleep: async () => {} }),
    ).resolves.toBeTypeOf("number");
  });

  it("starts and stops without a window to listen on", () => {
    vi.stubGlobal("window", undefined);
    startDecodeQueue({ fetchImpl: offlineFetch, sleep: async () => {} })();
  });

  it("[M3] starts and stops where `window` is not a declared binding at all", () => {
    // Not the same case as the one above, and the difference is the whole reason
    // `eventTarget` is written with `typeof`. `vi.stubGlobal("window", undefined)` DEFINES
    // the property, so evaluating a bare `window` yields `undefined`; where the binding
    // does not exist — a worker, node itself — evaluating it is a ReferenceError, and that
    // is the runtime the guard is for ("In a worker or a test there is none, so the queue
    // runs with its other two triggers rather than throwing on the way up").
    //
    // Nothing was exercising it: `bun run mutate` replaces `typeof window === "undefined"`
    // with `false` and survives, because every test had defined the property first.
    const had = Object.getOwnPropertyDescriptor(globalThis, "window");
    delete (globalThis as unknown as Record<string, unknown>).window;
    try {
      expect(() =>
        startDecodeQueue({ fetchImpl: offlineFetch, sleep: async () => {} })(),
      ).not.toThrow();
    } finally {
      if (had) Object.defineProperty(globalThis, "window", had);
    }
  });

  it("subscribes to the online event when a window exists", () => {
    const listeners: string[] = [];
    const removed: string[] = [];
    vi.stubGlobal("window", {
      addEventListener: (type: string) => listeners.push(type),
      removeEventListener: (type: string) => removed.push(type),
    });
    const stop = startDecodeQueue({ fetchImpl: offlineFetch, sleep: async () => {} });
    expect(listeners).toContain("online");
    stop();
    expect(removed).toContain("online");
  });
});
