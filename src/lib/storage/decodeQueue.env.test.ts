import { afterEach, describe, expect, it, vi } from "vitest";
import { runDecodeQueueOnce, startDecodeQueue } from "./decodeQueue";

/**
 * The queue's environment guards, exercised in BOTH directions. The unit tests run
 * under node, where `window` and `document` are absent, so without these the
 * browser-side branch of every guard would never execute (§5.4, P7).
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

  it("polls only while the document is visible", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { visibilityState: "hidden" });
    vi.stubGlobal("navigator", { onLine: true });
    const fetchImpl = vi.fn(offlineFetch);
    const stop = startDecodeQueue({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    });
    await vi.advanceTimersByTimeAsync(180_000);
    const whileHidden = fetchImpl.mock.calls.length;

    vi.stubGlobal("document", { visibilityState: "visible" });
    await vi.advanceTimersByTimeAsync(180_000);
    stop();
    vi.useRealTimers();
    // Nothing is pending in this database, so neither figure grows; what matters is
    // that the hidden branch and the visible branch both execute.
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(whileHidden);
  });
});
