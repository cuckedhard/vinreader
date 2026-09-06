/**
 * One worker, on demand, gone when the screen is.
 *
 * S5 addendum §4 is a list of recorded iOS failures and this is where each one is either
 * enforced or not: three fast WASM memories per web-content process (so never while the
 * camera is live, and never two engines), and roughly seven seconds of grace after
 * backgrounding before the process is suspended (so hiding the screen is a cancellation
 * and not a pause).
 *
 * And N2, which no amount of engine work changes: `recognize` returns a proposal. Nothing
 * here decides anything.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOcrEngine, onDocumentHidden, type OcrEngineDeps } from "./engine";
import type { TesseractPage, TesseractWorkerLike } from "./runtime";
import type { OcrCapabilities } from "./support";
import { OcrError } from "./types";

const ABLE: OcrCapabilities = { wasm: true, simd: true, worker: true, cacheStorage: true };

const PAGE: TesseractPage = {
  text: "WA8555",
  confidence: 92,
  blocks: [
    {
      paragraphs: [
        {
          lines: [
            {
              words: [
                {
                  symbols: [
                    { text: "W", confidence: 96 },
                    { text: "A", confidence: 93 },
                    { text: "8", confidence: 71 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

interface Harness {
  deps: OcrEngineDeps;
  calls: {
    assets: number;
    workers: number;
    recognized: { image: unknown; options: unknown; output: unknown }[];
    terminated: number;
    unsubscribed: number;
  };
  hide: () => void;
  capabilities: OcrCapabilities;
  scannerLive: boolean;
  onRecognize: (() => Promise<{ data: TesseractPage }>) | null;
  onAssets: ((signal: AbortSignal | undefined) => Promise<Uint8Array>) | null;
}

function harness(): Harness {
  const calls = {
    assets: 0,
    workers: 0,
    recognized: [] as Harness["calls"]["recognized"],
    terminated: 0,
    unsubscribed: 0,
  };
  let hidden: (() => void) | null = null;

  const state: Harness = {
    calls,
    capabilities: { ...ABLE },
    scannerLive: false,
    onRecognize: null,
    onAssets: null,
    hide: () => hidden?.(),
    deps: {
      capabilities: () => state.capabilities,
      isScannerLive: () => state.scannerLive,
      ensureAssets: async (options) => {
        calls.assets += 1;
        if (state.onAssets !== null) return state.onAssets(options.signal);
        return new Uint8Array([1]);
      },
      createWorker: async () => {
        calls.workers += 1;
        const worker: TesseractWorkerLike = {
          setParameters: async () => ({}),
          recognize: async (image, options, output) => {
            calls.recognized.push({ image, options, output });
            if (state.onRecognize !== null) return state.onRecognize();
            return { data: PAGE };
          },
          terminate: async () => {
            calls.terminated += 1;
          },
        };
        return worker;
      },
      onHidden: (listener) => {
        hidden = listener;
        return () => {
          calls.unsubscribed += 1;
          hidden = null;
        };
      },
    },
  };
  return state;
}

describe("createOcrEngine", () => {
  it("returns a proposal with a confidence per character, and decides nothing", async () => {
    const h = harness();
    const line = await createOcrEngine(h.deps).recognize("frame");

    expect(line.text).toBe("WA8");
    expect(line.chars.map((c) => c.confidence)).toEqual([96, 93, 71]);
    expect(h.calls.recognized[0]).toEqual({
      image: "frame",
      options: {},
      output: { text: true, blocks: true },
    });
  });

  it("passes the user-aligned crop box through when there is one (§5)", async () => {
    const h = harness();
    const rectangle = { left: 10, top: 20, width: 300, height: 60 };
    await createOcrEngine(h.deps).recognize("frame", { rectangle });
    expect(h.calls.recognized[0].options).toEqual({ rectangle });
  });

  it("refuses before it downloads anything when the device cannot run it", async () => {
    const h = harness();
    h.capabilities = { ...ABLE, wasm: false };
    const engine = createOcrEngine(h.deps);

    expect(engine.support()).toBe("no_wasm");
    await expect(engine.recognize("frame")).rejects.toMatchObject({ reason: "no_wasm" });
    expect(h.calls.assets).toBe(0);
    expect(h.calls.workers).toBe(0);
  });

  it("refuses while the camera is live: iOS allows three fast memories, not four (§4)", async () => {
    const h = harness();
    h.scannerLive = true;
    await expect(createOcrEngine(h.deps).recognize("frame")).rejects.toMatchObject({
      reason: "scanner_live",
    });
    expect(h.calls.assets).toBe(0);
    expect(h.calls.workers).toBe(0);
  });

  it("keeps one worker across runs, and creates it only when the first run asks", async () => {
    const h = harness();
    const engine = createOcrEngine(h.deps);
    expect(h.calls.workers).toBe(0);

    await engine.recognize("a");
    await engine.recognize("b");
    expect(h.calls.workers).toBe(1);
    expect(h.calls.recognized.length).toBe(2);
  });

  it("runs one recognition at a time", async () => {
    const h = harness();
    let release: (() => void) | null = null;
    h.onRecognize = () =>
      new Promise((resolve) => {
        release = () => resolve({ data: PAGE });
      });
    const engine = createOcrEngine(h.deps);

    const first = engine.recognize("a");
    await expect(engine.recognize("b")).rejects.toMatchObject({ reason: "busy" });
    release!();
    await first;
    // And the door is open again once the first one is done.
    h.onRecognize = null;
    await expect(engine.recognize("c")).resolves.toBeTruthy();
  });

  it("treats the screen going away as a cancellation, and drops the worker with it", async () => {
    const h = harness();
    h.onRecognize = () => new Promise(() => {});
    const engine = createOcrEngine(h.deps);

    const running = engine.recognize("frame");
    // Let the run reach the worker before the screen is hidden.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    h.hide();
    await expect(running).rejects.toMatchObject({ reason: "aborted" });
    expect(h.calls.terminated).toBe(1);

    // Nothing is parked for later: the next run builds a new one.
    h.onRecognize = null;
    await engine.recognize("frame");
    expect(h.calls.workers).toBe(2);
  });

  it("cancels on the caller's signal too, before and during the run", async () => {
    const h = harness();
    const before = new AbortController();
    before.abort();
    const engine = createOcrEngine(h.deps);
    await expect(engine.recognize("frame", { signal: before.signal })).rejects.toMatchObject({
      reason: "aborted",
    });
    expect(h.calls.assets).toBe(0);

    const during = new AbortController();
    h.onAssets = () =>
      new Promise((resolve) => {
        during.abort();
        resolve(new Uint8Array([1]));
      });
    await expect(engine.recognize("frame", { signal: during.signal })).rejects.toMatchObject({
      reason: "aborted",
    });
  });

  it("stops listening for the screen after every run, however it ended", async () => {
    const h = harness();
    const engine = createOcrEngine(h.deps);
    await engine.recognize("a");
    expect(h.calls.unsubscribed).toBe(1);

    h.onRecognize = async () => {
      throw new Error("boom");
    };
    await expect(engine.recognize("b")).rejects.toBeInstanceOf(OcrError);
    expect(h.calls.unsubscribed).toBe(2);
  });

  it("throws away a worker that failed, rather than reusing one that failed once", async () => {
    const h = harness();
    const engine = createOcrEngine(h.deps);
    h.onRecognize = async () => {
      throw new Error("wasm trap");
    };
    await expect(engine.recognize("a")).rejects.toMatchObject({ reason: "engine_failed" });
    expect(h.calls.terminated).toBe(1);

    h.onRecognize = null;
    await engine.recognize("b");
    expect(h.calls.workers).toBe(2);
  });

  it("passes a download failure through with its own reason, not as an engine failure", async () => {
    const h = harness();
    h.onAssets = async () => {
      throw new OcrError("download_failed", "offline");
    };
    await expect(createOcrEngine(h.deps).recognize("a")).rejects.toMatchObject({
      reason: "download_failed",
    });
  });

  it("hands the run's own signal to the download, so hiding stops the 4.5 MB too", async () => {
    const h = harness();
    let seen: AbortSignal | undefined;
    h.onAssets = async (signal) => {
      seen = signal;
      return new Uint8Array([1]);
    };
    await createOcrEngine(h.deps).recognize("a");
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen!.aborted).toBe(false);
    h.hide();
    expect(seen!.aborted).toBe(false); // the run is over; its listener is gone
  });

  it("disposes safely with no worker, and only once with one", async () => {
    const h = harness();
    const engine = createOcrEngine(h.deps);
    await engine.dispose();
    expect(h.calls.terminated).toBe(0);

    await engine.recognize("a");
    await engine.dispose();
    await engine.dispose();
    expect(h.calls.terminated).toBe(1);
  });

  it("does not let a failing terminate mask the reason a run ended", async () => {
    const h = harness();
    const failing: OcrEngineDeps = {
      ...h.deps,
      createWorker: async () => ({
        setParameters: async () => ({}),
        recognize: async () => {
          throw new Error("wasm trap");
        },
        terminate: async () => {
          throw new Error("terminate failed too");
        },
      }),
    };
    await expect(createOcrEngine(failing).recognize("a")).rejects.toMatchObject({
      reason: "engine_failed",
    });
  });
});

describe("onDocumentHidden", () => {
  const listeners = new Map<string, EventListener>();
  const fake = {
    visibilityState: "visible",
    addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  };

  afterEach(() => {
    listeners.clear();
    Reflect.deleteProperty(globalThis, "document");
  });

  it("fires when the document is hidden and not when it comes back", () => {
    Object.defineProperty(globalThis, "document", { value: fake, configurable: true });
    const seen = vi.fn();
    const stop = onDocumentHidden(seen);

    fake.visibilityState = "visible";
    listeners.get("visibilitychange")!(new Event("visibilitychange"));
    expect(seen).not.toHaveBeenCalled();

    fake.visibilityState = "hidden";
    listeners.get("visibilitychange")!(new Event("visibilitychange"));
    expect(seen).toHaveBeenCalledTimes(1);

    stop();
    expect(listeners.has("visibilitychange")).toBe(false);
  });
});
