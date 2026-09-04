import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cooldownStore } from "./cooldownStore";
import {
  COOLDOWN_MS,
  CONFIRM_WINDOW_MS,
  HIDDEN_LOST_MS,
  initialScanMachine,
  scanReducer,
  startingScanMachine,
} from "./scanMachine";
import type { ScanAction, ScanMachine, ScanSighting } from "./scanMachine";

const VIN_A = "1HGCM82633A004352";
const VIN_B = "1HGCM826X3A004350";

function sighting(vin: string, atMs: number, over: Partial<ScanSighting> = {}): ScanSighting {
  return { vin, raw: vin, checkDigitValid: true, symbology: "code_39", atMs, ...over };
}

function saw(vin: string, atMs: number, over: Partial<ScanSighting> = {}): ScanAction {
  return { type: "decoded", sighting: sighting(vin, atMs, over) };
}

const MOUNT: ScanAction = { type: "mount", secureContext: true };
const STARTED: ScanAction = { type: "stream_started" };

function run(actions: ScanAction[], from: ScanMachine = initialScanMachine): ScanMachine {
  return actions.reduce(scanReducer, from);
}

/** Every state before a decode: mounted, permitted, decoding. */
function streaming(): ScanMachine {
  return run([MOUNT, STARTED]);
}

/** A confirmed read of VIN_A at 1000 ms, two-read agreement satisfied. */
function confirmed(): ScanMachine {
  return run([saw(VIN_A, 0), saw(VIN_A, 1000)], streaming());
}

describe("scanReducer — startup", () => {
  it("starts idle and not lost", () => {
    expect(initialScanMachine).toEqual({
      state: { kind: "idle", lost: false },
      cooldown: {},
      hiddenAtMs: null,
    });
  });

  it("goes idle → requesting on mount", () => {
    expect(scanReducer(initialScanMachine, MOUNT).state).toEqual({ kind: "requesting" });
  });

  it("errors on an insecure context without ever requesting permission", () => {
    const machine = scanReducer(initialScanMachine, { type: "mount", secureContext: false });
    expect(machine.state).toEqual({ kind: "error", error: "insecure_context" });
  });

  it("goes requesting → streaming when the stream starts", () => {
    expect(streaming().state).toEqual({ kind: "streaming" });
  });

  it("ignores a stream start that no request is waiting on", () => {
    const machine = streaming();
    expect(scanReducer(machine, STARTED)).toBe(machine);
  });

  it("errors when permission is denied", () => {
    const machine = run([MOUNT, { type: "stream_failed", error: "permission_denied" }]);
    expect(machine.state).toEqual({ kind: "error", error: "permission_denied" });
  });

  it("errors when there is no camera", () => {
    const machine = run([MOUNT, { type: "stream_failed", error: "no_camera" }]);
    expect(machine.state).toEqual({ kind: "error", error: "no_camera" });
  });

  it("errors when a restart fails while streaming", () => {
    const machine = scanReducer(streaming(), { type: "stream_failed", error: "no_camera" });
    expect(machine.state).toEqual({ kind: "error", error: "no_camera" });
  });

  it("ignores a stream failure once the caller stopped the stream itself", () => {
    const machine = confirmed();
    expect(scanReducer(machine, { type: "stream_failed", error: "stream_lost" })).toBe(machine);
  });

  it("ignores a stream failure while idle", () => {
    expect(scanReducer(initialScanMachine, { type: "stream_failed", error: "stream_lost" })).toBe(
      initialScanMachine,
    );
  });
});

describe("scanReducer — retry", () => {
  it("re-requests from an error", () => {
    const denied = run([MOUNT, { type: "stream_failed", error: "permission_denied" }]);
    expect(scanReducer(denied, { type: "retry", secureContext: true }).state).toEqual({
      kind: "requesting",
    });
  });

  it("stays an error when the context is still insecure", () => {
    const insecure = scanReducer(initialScanMachine, { type: "mount", secureContext: false });
    expect(scanReducer(insecure, { type: "retry", secureContext: false }).state).toEqual({
      kind: "error",
      error: "insecure_context",
    });
  });

  it("clears a recorded hidden time", () => {
    const machine = run([MOUNT, STARTED, { type: "hidden", atMs: 500 }]);
    expect(scanReducer(machine, { type: "retry", secureContext: true }).hiddenAtMs).toBeNull();
  });

  it("keeps the cooldown across the mount action, which is not a React remount", () => {
    // Named for a remount before, but a `mount` action only reuses the machine object
    // it is handed. The remount §6.3's cooldown actually guards — accepting navigates
    // to the Sheet and unmounts the Scan screen — destroys that object, and only
    // `cooldownStore` survives it; that is proved at the bottom of this file.
    const machine = run([{ type: "accepted", vin: VIN_A, atMs: 5000 }, MOUNT]);
    expect(machine.cooldown).toEqual({ [VIN_A]: 5000 });
  });
});

describe("scanReducer — two-read agreement", () => {
  it("goes streaming → candidate on the first VIN seen", () => {
    const machine = scanReducer(streaming(), saw(VIN_A, 0));
    expect(machine.state).toEqual({ kind: "candidate", sighting: sighting(VIN_A, 0) });
  });

  it("stays a candidate on a single sighting", () => {
    expect(run([saw(VIN_A, 0)], streaming()).state.kind).toBe("candidate");
  });

  it("confirms a second identical VIN 1499 ms later", () => {
    const machine = run([saw(VIN_A, 0), saw(VIN_A, 1499)], streaming());
    expect(machine.state).toEqual({ kind: "confirmed", sighting: sighting(VIN_A, 1499) });
  });

  it("confirms exactly on the window boundary", () => {
    const machine = run([saw(VIN_A, 0), saw(VIN_A, CONFIRM_WINDOW_MS)], streaming());
    expect(machine.state.kind).toBe("confirmed");
  });

  it("does not confirm a second identical VIN 1501 ms later", () => {
    const machine = run([saw(VIN_A, 0), saw(VIN_A, 1501)], streaming());
    // A late repeat is a fresh first sighting; the window restarts on it.
    expect(machine.state).toEqual({ kind: "candidate", sighting: sighting(VIN_A, 1501) });
    expect(scanReducer(machine, saw(VIN_A, 2000)).state.kind).toBe("confirmed");
  });

  it("replaces the candidate when a different VIN is seen", () => {
    const machine = run([saw(VIN_A, 0), saw(VIN_B, 100)], streaming());
    expect(machine.state).toEqual({ kind: "candidate", sighting: sighting(VIN_B, 100) });
  });

  it("keeps the confirming sighting, not the first one", () => {
    const machine = run(
      [saw(VIN_A, 0, { raw: `*${VIN_A}*` }), saw(VIN_A, 200, { symbology: "data_matrix" })],
      streaming(),
    );
    expect(machine.state).toEqual({
      kind: "confirmed",
      sighting: sighting(VIN_A, 200, { symbology: "data_matrix" }),
    });
  });

  it("carries a failed check digit through to the confirmed read", () => {
    const bad = { checkDigitValid: false };
    const machine = run([saw(VIN_A, 0, bad), saw(VIN_A, 300, bad)], streaming());
    expect(machine.state).toEqual({
      kind: "confirmed",
      sighting: sighting(VIN_A, 300, bad),
    });
  });

  it("stays confirmed until accepted or rescanned", () => {
    const machine = confirmed();
    expect(scanReducer(machine, { type: "track_ended" })).toBe(machine);
    expect(scanReducer(machine, STARTED)).toBe(machine);
  });
});

describe("scanReducer — decodes that must be ignored", () => {
  it.each([
    ["idle", initialScanMachine],
    ["requesting", run([MOUNT])],
    ["confirmed", confirmed()],
    ["error", run([MOUNT, { type: "stream_failed", error: "permission_denied" }])],
  ])("ignores a decode while %s", (_kind, machine) => {
    expect(scanReducer(machine, saw(VIN_A, 9))).toBe(machine);
  });
});

describe("scanReducer — cooldown", () => {
  const accepted = run([{ type: "accepted", vin: VIN_A, atMs: 1000 }, MOUNT, STARTED], confirmed());

  it("returns to idle and records the acceptance", () => {
    const machine = scanReducer(confirmed(), { type: "accepted", vin: VIN_A, atMs: 1000 });
    expect(machine.state).toEqual({ kind: "idle", lost: false });
    expect(machine.cooldown).toEqual({ [VIN_A]: 1000 });
  });

  it("ignores the same VIN 9999 ms after it was accepted", () => {
    expect(scanReducer(accepted, saw(VIN_A, 1000 + 9999))).toBe(accepted);
  });

  it("ignores the same VIN exactly on the cooldown boundary", () => {
    expect(scanReducer(accepted, saw(VIN_A, 1000 + COOLDOWN_MS))).toBe(accepted);
  });

  it("reads the same VIN again 10001 ms after it was accepted", () => {
    const machine = run([saw(VIN_A, 1000 + 10001), saw(VIN_A, 1000 + 10500)], accepted);
    expect(machine.state.kind).toBe("confirmed");
  });

  it("never cools down a VIN that was not accepted", () => {
    const machine = scanReducer(accepted, saw(VIN_B, 1001));
    expect(machine.state).toEqual({ kind: "candidate", sighting: sighting(VIN_B, 1001) });
  });

  it("does not cool down a read the user rejected with Rescan", () => {
    const rescanned = scanReducer(confirmed(), { type: "rescan" });
    expect(rescanned.state).toEqual({ kind: "streaming" });
    expect(rescanned.cooldown).toEqual({});
    // The rejected VIN must be readable again immediately, not in ten seconds.
    const machine = run([saw(VIN_A, 1001), saw(VIN_A, 1002)], rescanned);
    expect(machine.state).toEqual({ kind: "confirmed", sighting: sighting(VIN_A, 1002) });
  });

  it("ignores a rescan outside the confirmed state", () => {
    const machine = streaming();
    expect(scanReducer(machine, { type: "rescan" })).toBe(machine);
  });
});

describe("scanReducer — stream loss and visibility", () => {
  it("returns to idle and reports the loss when the track ends while streaming", () => {
    expect(scanReducer(streaming(), { type: "track_ended" }).state).toEqual({
      kind: "idle",
      lost: true,
    });
  });

  it("returns to idle when the track ends under a candidate", () => {
    const machine = run([saw(VIN_A, 0), { type: "track_ended" }], streaming());
    expect(machine.state).toEqual({ kind: "idle", lost: true });
  });

  it("ignores a track ending that the caller caused", () => {
    const machine = run([MOUNT]);
    expect(scanReducer(machine, { type: "track_ended" })).toBe(machine);
  });

  it("drops a pending candidate when the tab is hidden", () => {
    const machine = run([saw(VIN_A, 0), { type: "hidden", atMs: 100 }], streaming());
    expect(machine.state).toEqual({ kind: "streaming" });
    expect(machine.hiddenAtMs).toBe(100);
  });

  it("records the hidden time without disturbing a state that has no candidate", () => {
    const machine = scanReducer(confirmed(), { type: "hidden", atMs: 100 });
    expect(machine.state.kind).toBe("confirmed");
    expect(machine.hiddenAtMs).toBe(100);
  });

  it("resumes streaming after 29999 ms hidden", () => {
    const machine = run(
      [
        { type: "hidden", atMs: 100 },
        { type: "visible", atMs: 100 + 29999, secureContext: true },
      ],
      streaming(),
    );
    expect(machine.state).toEqual({ kind: "streaming" });
    expect(machine.hiddenAtMs).toBeNull();
  });

  it("resumes streaming exactly on the lost boundary", () => {
    const machine = run(
      [
        { type: "hidden", atMs: 100 },
        { type: "visible", atMs: 100 + HIDDEN_LOST_MS, secureContext: true },
      ],
      streaming(),
    );
    expect(machine.state).toEqual({ kind: "streaming" });
  });

  it("re-requests the camera on the visibility that measures 30001 ms hidden", () => {
    // §6.3: a stream hidden past the window is lost and re-requested "on next
    // visibility". This event is that next visibility — there is no second one
    // coming — so stopping at idle here left the preview dead until the user
    // navigated away and back.
    const machine = run(
      [
        { type: "hidden", atMs: 100 },
        { type: "visible", atMs: 100 + 30001, secureContext: true },
      ],
      streaming(),
    );
    expect(machine.state).toEqual({ kind: "requesting" });
    expect(machine.hiddenAtMs).toBeNull();
  });

  it("errors rather than re-requesting when a long absence ends insecure", () => {
    // The re-request goes down the same path a mount takes, so §6.3's "insecure
    // context → error before any permission prompt" still applies to it.
    const machine = run(
      [
        { type: "hidden", atMs: 100 },
        { type: "visible", atMs: 100 + 30001, secureContext: false },
      ],
      streaming(),
    );
    expect(machine.state).toEqual({ kind: "error", error: "insecure_context" });
  });

  it("re-requests the camera on the visibility after a lost stream", () => {
    const lost = run([{ type: "track_ended" }], streaming());
    const machine = scanReducer(lost, { type: "visible", atMs: 1, secureContext: true });
    expect(machine.state).toEqual({ kind: "requesting" });
  });

  it("does not re-request on an insecure context", () => {
    const lost = run([{ type: "track_ended" }], streaming());
    const machine = scanReducer(lost, { type: "visible", atMs: 1, secureContext: false });
    expect(machine.state).toEqual({ kind: "error", error: "insecure_context" });
  });

  it("leaves an error standing, because the user must still act on it", () => {
    const denied = run([MOUNT, { type: "stream_failed", error: "permission_denied" }]);
    const machine = run(
      [
        { type: "hidden", atMs: 0 },
        { type: "visible", atMs: 60000, secureContext: true },
      ],
      denied,
    );
    expect(machine.state).toEqual({ kind: "error", error: "permission_denied" });
    expect(machine.hiddenAtMs).toBeNull();
  });

  it("leaves a confirmed read standing", () => {
    const machine = run(
      [
        { type: "hidden", atMs: 0 },
        { type: "visible", atMs: 60000, secureContext: true },
      ],
      confirmed(),
    );
    expect(machine.state.kind).toBe("confirmed");
  });

  it("leaves a pending permission prompt alone", () => {
    const machine = run(
      [
        { type: "hidden", atMs: 0 },
        { type: "visible", atMs: 10, secureContext: true },
      ],
      run([MOUNT]),
    );
    expect(machine.state).toEqual({ kind: "requesting" });
  });
});

describe("startingScanMachine — the cooldown that outlives the screen", () => {
  // The store is module state by design (it has to outlive a component), so each
  // test starts and leaves it empty.
  beforeEach(() => {
    cooldownStore.clear();
  });
  afterEach(() => {
    cooldownStore.clear();
  });

  it("starts a clean machine when nothing has been accepted", () => {
    expect(startingScanMachine()).toEqual(initialScanMachine);
  });

  it("starts with the cooldown the store holds, which a remount cannot destroy", () => {
    cooldownStore.record(VIN_A, 5000);
    const machine = startingScanMachine();
    expect(machine.cooldown).toEqual({ [VIN_A]: 5000 });
    expect(machine.state).toEqual({ kind: "idle", lost: false });
    // Seeded, not decorative: §6.3 ignores that VIN on the freshly mounted screen,
    // which is the double-log the cooldown exists to stop.
    const seeded = run([MOUNT, STARTED], machine);
    expect(scanReducer(seeded, saw(VIN_A, 5000 + COOLDOWN_MS))).toBe(seeded);
  });

  it("takes an explicit cooldown, so nothing has to reach for module state", () => {
    expect(startingScanMachine({ [VIN_B]: 42 }).cooldown).toEqual({ [VIN_B]: 42 });
  });

  it("leaves initialScanMachine empty however much the store has recorded", () => {
    cooldownStore.record(VIN_A, 5000);
    expect(initialScanMachine.cooldown).toEqual({});
  });

  it("hands out a snapshot, so the reducer never writes the store", () => {
    cooldownStore.record(VIN_A, 5000);
    const machine = scanReducer(startingScanMachine(), {
      type: "accepted",
      vin: VIN_B,
      atMs: 6000,
    });
    expect(machine.cooldown).toEqual({ [VIN_A]: 5000, [VIN_B]: 6000 });
    // §13.2 / purity: the hook writes through to the store, the reducer does not.
    expect(cooldownStore.read()).toEqual({ [VIN_A]: 5000 });
  });
});

describe("scanReducer — happy path", () => {
  it("runs mount → streaming → candidate → confirmed → accepted", () => {
    const steps: ScanAction[] = [
      MOUNT,
      STARTED,
      saw(VIN_A, 0),
      saw(VIN_A, 400),
      { type: "accepted", vin: VIN_A, atMs: 500 },
    ];
    const kinds = steps.map((_action, i) => run(steps.slice(0, i + 1)).state.kind);
    expect(kinds).toEqual(["requesting", "streaming", "candidate", "confirmed", "idle"]);
    expect(run(steps).cooldown).toEqual({ [VIN_A]: 500 });
  });
});

// ---------------------------------------------------------------------------
// Properties (A-29)
// ---------------------------------------------------------------------------

/**
 * A-29. These two laws used to be generated by `fc.array(actionArb, { maxLength: 40 })`
 * over actions stamped with independent random timestamps. Measured over 1,000 sampled
 * sequences: mean length 4.7, nine decodes arrived while the stream was live, eight
 * candidates were ever raised, and **zero** confirmations and zero cooldown decisions
 * happened at all. "Only ever confirms a VIN that was already the candidate" was
 * therefore vacuous — it never observed a confirmation — and "only grows the cooldown on
 * acceptance" never saw the map consulted. Against a switchable-fault copy of the reducer
 * the pair killed 2 of 16 injected faults, and both of those two are killed by the case
 * tests above as well.
 *
 * The model below is a *device*: a clock that only moves forward, frames arriving in
 * bursts at a camera's cadence, and — the part nothing else in this directory has — the
 * navigation that ends a scan. §6.3's cooldown is about "return to Scan", and a return to
 * Scan is a fresh React mount: `useVinCommit` navigates to the Sheet, ScanScreen unmounts,
 * and the next visit builds a new machine from `startingScanMachine(cooldownStore.read())`.
 * The driver does exactly that, so the store, the reducer and the remount are generated
 * together instead of one at a time.
 *
 * Every generator is seeded, and the reach gate below fails if a later edit stops the
 * sequences arriving anywhere.
 */

const KINDS = ["idle", "requesting", "streaming", "candidate", "confirmed", "error"];

/** A device stamps `Date.now()`, six orders of magnitude above a counter. */
const EPOCH = Date.UTC(2026, 8, 4, 12, 0, 0);

/** The write, the navigation and the walk back to /#/scan, in milliseconds. */
const COMMIT_MS = 40;

/**
 * Four §4.11 fixtures, not two. A yard is a row of trucks: with two VINs a session spends
 * most of itself inside one or other cooldown and the generator starves, which is the
 * failure A-29 is about. The machine compares VINs, it never parses them.
 */
const VINS = [VIN_A, VIN_B, "1FUJGLDR49SAV1234", "1HTMMAAL67H412345"] as const;

type Move =
  /** A frame ZXing resolved off the label being aimed at. `keep` is the §6.3 decision. */
  | { k: "read"; dt: number; keep: boolean }
  /** The user turns to a different vehicle. Frames come in bursts off one label, not one
   * per label: the two-read rule needs the same VIN twice running, and a generator that
   * redrew the VIN every frame would confirm only by accident (A-29). */
  | { k: "aim"; vin: number }
  | { k: "hide"; dt: number }
  | { k: "show"; dt: number }
  | { k: "lose" }
  | { k: "wait"; dt: number };

/**
 * Frame cadence. ZXing is asked for an attempt every 100 ms, so most gaps between two
 * readings fall inside the 1.5 s agreement window and a minority fall outside it.
 */
const gapArb = fc.oneof(
  { arbitrary: fc.integer({ min: 0, max: 400 }), weight: 6 },
  { arbitrary: fc.integer({ min: 0, max: 3_000 }), weight: 1 },
  // Long enough to leave the cooldown behind, so a second visit to the same vehicle is
  // reachable rather than theoretical (§6.3: the cooldown is a debounce, not a block list).
  { arbitrary: fc.integer({ min: 0, max: 20_000 }), weight: 1 },
);

const moveArb: fc.Arbitrary<Move> = fc.oneof(
  {
    arbitrary: fc.record({
      k: fc.constant("read" as const),
      dt: gapArb,
      // Most reads are clean and are written; the rest are the §6.3 mismatch branch, where
      // the user taps Rescan and nothing is persisted.
      keep: fc.oneof(
        { arbitrary: fc.constant(true), weight: 4 },
        { arbitrary: fc.constant(false), weight: 1 },
      ),
    }),
    weight: 10,
  },
  {
    arbitrary: fc.record({ k: fc.constant("aim" as const), vin: fc.nat(VINS.length - 1) }),
    weight: 3,
  },
  { arbitrary: fc.record({ k: fc.constant("hide" as const), dt: gapArb }), weight: 1 },
  {
    arbitrary: fc.record({
      k: fc.constant("show" as const),
      dt: fc.integer({ min: 0, max: 45_000 }),
    }),
    weight: 1,
  },
  { arbitrary: fc.constant<Move>({ k: "lose" }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant("wait" as const), dt: gapArb }), weight: 1 },
);

/** Sized, not left to fast-check's default bias: a five-action session reaches nothing. */
const planArb = fc.array(moveArb, { minLength: 25, maxLength: 70, size: "max" });

interface Turn {
  action: ScanAction;
  before: ScanMachine;
  after: ScanMachine;
}

interface Session {
  turns: Turn[];
  /** Every write the app performed: one §5.2 scan event each, in order. */
  writes: { vin: string; atMs: number }[];
  /** Where the session's clock finished, so a law can look at the label afterwards. */
  clock: number;
}

/**
 * Run one plan the way the app runs it: `useScanner` dispatches, and on a confirmed read
 * ScanScreen either commits (write → `cooldownStore.record` → `accept` → navigate, which
 * unmounts the screen) or, on the mismatch branch the user rejects, calls `rescan`, which
 * writes nothing anywhere.
 */
function drive(moves: readonly Move[]): Session {
  cooldownStore.clear();
  const turns: Turn[] = [];
  const writes: { vin: string; atMs: number }[] = [];
  let clock = EPOCH;
  let machine = initialScanMachine;
  let aimed = 0;

  const dispatch = (action: ScanAction): void => {
    const before = machine;
    machine = scanReducer(before, action);
    turns.push({ action, before, after: machine });
  };
  /** Landing on /#/scan: a brand new machine, seeded from the store that outlived it. */
  const openScanScreen = (): void => {
    machine = startingScanMachine(cooldownStore.read());
    dispatch(MOUNT);
    dispatch(STARTED);
  };

  openScanScreen();
  for (const move of moves) {
    if ("dt" in move) clock += move.dt;
    switch (move.k) {
      case "read":
        dispatch(saw(VINS[aimed]!, clock));
        break;
      case "aim":
        aimed = move.vin;
        break;
      case "hide":
        dispatch({ type: "hidden", atMs: clock });
        break;
      case "show":
        dispatch({ type: "visible", atMs: clock, secureContext: true });
        break;
      case "lose":
        dispatch({ type: "track_ended" });
        break;
      case "wait":
        break;
    }
    if (machine.state.kind !== "confirmed") continue;
    const { vin } = machine.state.sighting;
    if (move.k === "read" && !move.keep) {
      // §6.3 Rescan: the read was never persisted, so nothing reaches the store.
      dispatch({ type: "rescan" });
      continue;
    }
    // The write lands, then the cooldown is recorded and the Sheet takes over.
    clock += COMMIT_MS;
    writes.push({ vin, atMs: clock });
    cooldownStore.record(vin, clock);
    dispatch({ type: "accepted", vin, atMs: clock });
    clock += COMMIT_MS;
    openScanScreen();
  }
  return { turns, writes, clock };
}

describe("scanReducer — properties", () => {
  afterEach(() => {
    cooldownStore.clear();
  });

  it("[A-29] generates sessions that reach the states these laws are about", () => {
    // The generator's own gate. A-29 was not a wrong assertion, it was assertions that
    // never ran: a percentage cannot tell you a sequence arrived anywhere, so the counts
    // are stated. Measured on this seed over 200 plans: 279 confirmations, 225 writes,
    // 841 readings dropped by a cooldown, and 439 of those on a screen mounted after the
    // acceptance that opened the window — the case §6.3's rule is written for. The floors
    // sit at about half of each, so this states "the generator still gets there" rather
    // than a fixed count. The same measurement over the generator this replaced: nine live
    // decodes, zero confirmations, zero cooldown decisions.
    let confirmations = 0;
    let writes = 0;
    let cooled = 0;
    let cooledAfterRemount = 0;
    for (const moves of fc.sample(planArb, { numRuns: 200, seed: 0x5c9_3001 })) {
      const session = drive(moves);
      writes += session.writes.length;
      let mountedAt = 0;
      session.turns.forEach((turn, i) => {
        if (turn.action.type === "mount") mountedAt = i;
        if (turn.after.state.kind === "confirmed" && turn.before.state.kind !== "confirmed") {
          confirmations += 1;
        }
        if (turn.action.type !== "decoded" || turn.after !== turn.before) return;
        const acceptedAt = turn.before.cooldown[turn.action.sighting.vin];
        if (acceptedAt === undefined || turn.before.hiddenAtMs !== null) return;
        cooled += 1;
        // The §6.3 case the cooldown exists for: the acceptance happened on a screen that
        // no longer exists, and the window is being honoured by its replacement.
        if (turn.before.state.kind === "streaming" && mountedAt > 0) cooledAfterRemount += 1;
      });
    }
    expect(confirmations).toBeGreaterThan(140);
    expect(writes).toBeGreaterThan(110);
    expect(cooled).toBeGreaterThan(400);
    expect(cooledAfterRemount).toBeGreaterThan(200);
  });

  it("never reaches an unknown state and only grows the cooldown on acceptance", () => {
    fc.assert(
      fc.property(planArb, (moves) => {
        for (const { action, before, after } of drive(moves).turns) {
          expect(KINDS).toContain(after.state.kind);
          if (action.type === "accepted") {
            expect(after.cooldown).toEqual({ ...before.cooldown, [action.vin]: action.atMs });
          } else {
            // Reference equality: no other action may rewrite the map at all. A `mount`
            // included — the remount §6.3's cooldown guards must not clear what it guards.
            expect(after.cooldown).toBe(before.cooldown);
          }
        }
      }),
      { seed: 0x5c9_3002, numRuns: 300 },
    );
  });

  it("only ever confirms a VIN that was already the candidate", () => {
    fc.assert(
      fc.property(planArb, (moves) => {
        for (const { action, before, after } of drive(moves).turns) {
          if (after.state.kind !== "confirmed" || before.state.kind === "confirmed") continue;
          // The only way in is a decode agreeing with the standing candidate.
          expect(before.state.kind).toBe("candidate");
          const prior = before.state.kind === "candidate" ? before.state.sighting.vin : null;
          expect(prior).toBe(after.state.sighting.vin);
          // …and the agreement is the two-read rule, not a coincidence: §6.3 confirms on
          // "a second identical normalized VIN within 1.5 s".
          expect(action.type).toBe("decoded");
          if (action.type !== "decoded" || before.state.kind !== "candidate") return;
          const gap = action.sighting.atMs - before.state.sighting.atMs;
          expect(gap).toBeGreaterThanOrEqual(0);
          expect(gap).toBeLessThanOrEqual(CONFIRM_WINDOW_MS);
        }
      }),
      { seed: 0x5c9_3003, numRuns: 300 },
    );
  });

  it("never logs the same VIN twice inside the cooldown, however often Scan is reopened", () => {
    // §6.3's cooldown in the words it is written in: "the same VIN confirmed again within
    // 10 s is ignored — prevents double-logging on return to Scan". §5.2 is append-only, so
    // a second write inside the window is a scan the user never took (P4, N9), and the
    // screen that would make it is a *different* screen from the one that made the first —
    // which is why the map has to survive the unmount. Stated over the writes the app
    // performed, not over the reducer's own state, so it holds across the whole seam.
    fc.assert(
      fc.property(planArb, (moves) => {
        const seen = new Map<string, number>();
        for (const write of drive(moves).writes) {
          const previous = seen.get(write.vin);
          if (previous !== undefined) {
            expect(write.atMs - previous).toBeGreaterThan(COOLDOWN_MS);
          }
          seen.set(write.vin, write.atMs);
        }
      }),
      { seed: 0x5c9_3004, numRuns: 300 },
    );
  });

  it("keeps reading: a vehicle outside its window always confirms again", () => {
    // The other half, and the one a too-eager cooldown breaks silently. §6.3's window is a
    // debounce, not a block list: a VIN that was never accepted must never be held back by
    // another VIN's window, and one whose window has passed must read again on the next two
    // frames. A scanner that goes quiet in the yard reports nothing — the user just sees a
    // camera that has stopped working on that truck.
    fc.assert(
      fc.property(planArb, fc.nat(VINS.length - 1), (moves, which) => {
        const session = drive(moves);
        const vin = VINS[which]!;
        const lastWrite = session.writes.filter((w) => w.vin === vin).pop();
        // Far enough past both the last acceptance and the last frame to be a fresh look.
        const at =
          Math.max(session.clock, lastWrite === undefined ? 0 : lastWrite.atMs + COOLDOWN_MS) + 1;
        // Returning to the Scan screen: a new machine, seeded from the store, camera up.
        const reopened = run([MOUNT, STARTED], startingScanMachine(cooldownStore.read()));
        const again = run([saw(vin, at), saw(vin, at + 200)], reopened);
        expect(again.state).toEqual({ kind: "confirmed", sighting: sighting(vin, at + 200) });
      }),
      { seed: 0x5c9_3005, numRuns: 300 },
    );
  });
});
