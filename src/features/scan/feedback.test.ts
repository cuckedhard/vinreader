/**
 * §6.1 confirmed-scan feedback: "short beep (Web Audio, off if `settings.sound` false) +
 * `navigator.vibrate(60)` where available. **Never rely on either** — the screen change is
 * the primary feedback."
 *
 * That last clause is the whole test plan. `scanFeedback` runs inside `ScanScreen`'s commit,
 * between the write landing and `accept()` recording the §6.3 cooldown, so a throw from here
 * would take the rest of that path down with it. Every environment below is one a real phone
 * presents: no Web Audio, iOS's prefixed constructor, a context suspended until a gesture, a
 * refused vibration.
 *
 * The module caches one AudioContext for the app's lifetime, so every test re-imports it.
 */

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeAudioParam {
  value = 0;
  readonly ramps: Array<{ kind: "set" | "ramp"; value: number; at: number }> = [];
  setValueAtTime(value: number, at: number): this {
    this.ramps.push({ kind: "set", value, at });
    return this;
  }
  linearRampToValueAtTime(value: number, at: number): this {
    this.ramps.push({ kind: "ramp", value, at });
    return this;
  }
}

class FakeOscillator {
  type = "";
  frequency = { value: 0 };
  onended: (() => void) | null = null;
  readonly connected: unknown[] = [];
  disconnects = 0;
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  connect(node: unknown): void {
    this.connected.push(node);
  }
  disconnect(): void {
    this.disconnects += 1;
  }
  start(at: number): void {
    this.startedAt = at;
  }
  stop(at: number): void {
    this.stoppedAt = at;
  }
}

class FakeGain {
  readonly gain = new FakeAudioParam();
  readonly connected: unknown[] = [];
  disconnects = 0;
  connect(node: unknown): void {
    this.connected.push(node);
  }
  disconnect(): void {
    this.disconnects += 1;
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: "running" | "suspended" | "closed" = "running";
  currentTime = 12.5;
  readonly destination = { id: "destination" };
  readonly oscillators: FakeOscillator[] = [];
  readonly gains: FakeGain[] = [];
  resume = vi.fn((): Promise<void> => Promise.resolve());
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createOscillator(): FakeOscillator {
    const osc = new FakeOscillator();
    this.oscillators.push(osc);
    return osc;
  }
  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
}

/** The one instance a test built, or a failure if the module never built one. */
function onlyContext(): FakeAudioContext {
  expect(FakeAudioContext.instances).toHaveLength(1);
  const context = FakeAudioContext.instances[0];
  if (context === undefined) throw new Error("no AudioContext was constructed");
  return context;
}

function withAudio(ctor: unknown, key = "AudioContext"): void {
  vi.stubGlobal("window", { [key]: ctor });
}

function withVibrate(vibrate: unknown): void {
  vi.stubGlobal("navigator", { vibrate });
}

async function load() {
  return import("./feedback");
}

const BOTH = { sound: true, haptics: true };

beforeEach(() => {
  vi.resetModules();
  FakeAudioContext.instances = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scanFeedback — §6.1 settings gate", () => {
  it("does nothing at all when both are off", async () => {
    const vibrate = vi.fn();
    withAudio(FakeAudioContext);
    withVibrate(vibrate);
    const { scanFeedback } = await load();

    scanFeedback({ sound: false, haptics: false });

    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("beeps but does not vibrate when only sound is on", async () => {
    const vibrate = vi.fn();
    withAudio(FakeAudioContext);
    withVibrate(vibrate);
    const { scanFeedback } = await load();

    scanFeedback({ sound: true, haptics: false });

    expect(onlyContext().oscillators).toHaveLength(1);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("vibrates for exactly 60 ms and stays silent when only haptics are on", async () => {
    // §6.1 names the duration: `navigator.vibrate(60)`.
    const vibrate = vi.fn();
    withAudio(FakeAudioContext);
    withVibrate(vibrate);
    const { scanFeedback } = await load();

    scanFeedback({ sound: false, haptics: true });

    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith(60);
    expect(FakeAudioContext.instances).toHaveLength(0);
  });
});

describe("scanFeedback — the tone", () => {
  it("plays one bounded tone through the gain into the destination", async () => {
    withAudio(FakeAudioContext);
    withVibrate(vi.fn());
    const { scanFeedback } = await load();

    scanFeedback(BOTH);

    const context = onlyContext();
    const osc = context.oscillators[0];
    const gain = context.gains[0];
    if (osc === undefined || gain === undefined) throw new Error("no tone was built");
    expect(osc.connected).toEqual([gain]);
    expect(gain.connected).toEqual([context.destination]);
    // A tone that starts and never stops is a scanner that hums until the tab closes.
    expect(osc.startedAt).toBe(context.currentTime);
    expect(osc.stoppedAt).toBeGreaterThan(context.currentTime);
    // §6.1's "short": under a quarter second, so it cannot overlap the next confirmation.
    expect((osc.stoppedAt ?? 0) - context.currentTime).toBeLessThanOrEqual(0.25);
  });

  it("opens from and returns to silence, so the tone neither clicks nor sticks", async () => {
    withAudio(FakeAudioContext);
    withVibrate(vi.fn());
    const { scanFeedback } = await load();

    scanFeedback(BOTH);

    const gain = onlyContext().gains[0];
    if (gain === undefined) throw new Error("no gain node was built");
    const { ramps } = gain.gain;
    expect(ramps[0]?.value).toBe(0);
    expect(ramps[ramps.length - 1]?.value).toBe(0);
    expect(Math.max(...ramps.map((ramp) => ramp.value))).toBeGreaterThan(0);
    // Times move forward, so the envelope is a real shape and not four points at once.
    const times = ramps.map((ramp) => ramp.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("releases the nodes when the tone ends", async () => {
    // One context for the app's lifetime means the nodes are what accumulate; a scan
    // every few seconds for a shift adds up.
    withAudio(FakeAudioContext);
    withVibrate(vi.fn());
    const { scanFeedback } = await load();

    scanFeedback(BOTH);
    const context = onlyContext();
    const osc = context.oscillators[0];
    const gain = context.gains[0];
    if (osc === undefined || gain === undefined) throw new Error("no tone was built");
    expect(osc.onended).toBeTypeOf("function");
    osc.onended?.();
    expect(osc.disconnects).toBe(1);
    expect(gain.disconnects).toBe(1);
  });

  it("reuses one AudioContext across scans", async () => {
    withAudio(FakeAudioContext);
    withVibrate(vi.fn());
    const { scanFeedback } = await load();

    scanFeedback(BOTH);
    scanFeedback(BOTH);
    scanFeedback(BOTH);

    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(onlyContext().oscillators).toHaveLength(3);
  });

  it("replaces a context the browser closed", async () => {
    withAudio(FakeAudioContext);
    withVibrate(vi.fn());
    const { scanFeedback } = await load();

    scanFeedback(BOTH);
    const first = FakeAudioContext.instances[0];
    if (first === undefined) throw new Error("no AudioContext was constructed");
    first.state = "closed";
    scanFeedback(BOTH);

    expect(FakeAudioContext.instances).toHaveLength(2);
    expect(FakeAudioContext.instances[1]?.oscillators).toHaveLength(1);
  });

  it("resumes a context iOS suspended, and survives a resume that never lands", async () => {
    // Safari suspends any context created outside a user gesture; the first scan of a
    // session is exactly that case.
    class Suspended extends FakeAudioContext {
      override state: "running" | "suspended" | "closed" = "suspended";
      override resume = vi.fn((): Promise<void> => Promise.reject(new Error("not allowed")));
    }
    withAudio(Suspended);
    withVibrate(vi.fn());
    const { scanFeedback } = await load();

    expect(() => scanFeedback(BOTH)).not.toThrow();

    const context = onlyContext();
    expect(context.resume).toHaveBeenCalledTimes(1);
    // The tone is still scheduled: §6.1 says it may go unheard, not that the scan stops.
    expect(context.oscillators).toHaveLength(1);
  });

  it("uses the prefixed constructor when that is all the browser has", async () => {
    withAudio(FakeAudioContext, "webkitAudioContext");
    withVibrate(vi.fn());
    const { scanFeedback } = await load();

    scanFeedback(BOTH);

    expect(FakeAudioContext.instances).toHaveLength(1);
  });
});

describe("scanFeedback — §6.1 'never rely on either'", () => {
  it("still vibrates on a browser with no Web Audio at all", async () => {
    const vibrate = vi.fn();
    vi.stubGlobal("window", {});
    withVibrate(vibrate);
    const { scanFeedback } = await load();

    expect(() => scanFeedback(BOTH)).not.toThrow();
    expect(vibrate).toHaveBeenCalledWith(60);
  });

  it("still vibrates when the AudioContext constructor throws", async () => {
    const vibrate = vi.fn();
    withAudio(
      class {
        constructor() {
          throw new Error("audio is not available");
        }
      },
    );
    withVibrate(vibrate);
    const { scanFeedback } = await load();

    expect(() => scanFeedback(BOTH)).not.toThrow();
    expect(vibrate).toHaveBeenCalledWith(60);
  });

  it("still beeps on a device with no vibration motor", async () => {
    withAudio(FakeAudioContext);
    vi.stubGlobal("navigator", {});
    const { scanFeedback } = await load();

    expect(() => scanFeedback(BOTH)).not.toThrow();
    expect(onlyContext().oscillators).toHaveLength(1);
  });

  it("survives a vibration the browser refuses", async () => {
    // Chrome throws on `vibrate` in a frame that has never seen a tap.
    withAudio(FakeAudioContext);
    withVibrate(() => {
      throw new Error("blocked without a user gesture");
    });
    const { scanFeedback } = await load();

    expect(() => scanFeedback(BOTH)).not.toThrow();
  });

  it("survives a browser with no window and no navigator", async () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("navigator", undefined);
    const { scanFeedback } = await load();

    expect(() => scanFeedback(BOTH)).not.toThrow();
  });

  it("never throws, whatever the settings and whatever the device offers", async () => {
    // The law behind all of the above, since a throw here would strand `ScanScreen`
    // between the write and the §6.3 `accept()` that records the cooldown.
    const environments = [
      () => {
        withAudio(FakeAudioContext);
        withVibrate(vi.fn());
      },
      () => {
        vi.stubGlobal("window", {});
        withVibrate(vi.fn());
      },
      () => {
        withAudio(
          class {
            constructor() {
              throw new Error("nope");
            }
          },
        );
        vi.stubGlobal("navigator", {});
      },
      () => {
        withAudio(
          class extends FakeAudioContext {
            override createOscillator(): FakeOscillator {
              throw new Error("nope");
            }
          },
        );
        withVibrate(() => {
          throw new Error("nope");
        });
      },
      () => {
        vi.stubGlobal("window", undefined);
        vi.stubGlobal("navigator", undefined);
      },
    ];

    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 0, max: environments.length - 1 }),
        async (sound, haptics, index) => {
          vi.resetModules();
          vi.unstubAllGlobals();
          FakeAudioContext.instances = [];
          environments[index]?.();
          const { scanFeedback } = await load();
          expect(() => scanFeedback({ sound, haptics })).not.toThrow();
        },
      ),
      { seed: 0x5c9_0007, numRuns: 120 },
    );
  });
});
