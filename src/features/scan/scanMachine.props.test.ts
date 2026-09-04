/**
 * §6.3 laws — the invariants that must hold over *every* action sequence, plus the
 * branches `scanMachine.test.ts` executes without asserting on.
 *
 * Deliberately NOT repeated from `scanMachine.test.ts`, which already proves them: that no
 * sequence reaches an unknown state, that only `accepted` ever writes the cooldown map, and
 * that a confirmation's VIN is the VIN of the candidate it replaced.
 *
 * Two generators, because one model is not enough. `chaosArb` is action soup — every §4.10
 * error, every camera symbology, timestamps in any order — and catches anything that
 * assumes an ordering. `sessionArb` is a device: the clock only moves forward, the sequence
 * starts the way `useScanner` starts it, and readings arrive in bursts. Only the second one
 * reaches the states where a cooldown decides anything; a generator that never gets there
 * proves nothing, however green it reports.
 *
 * Every generator is seeded, so a failure reproduces exactly. Sizes are pinned with
 * `size: "max"` and a `minLength`: fast-check's default size bias produces mostly very
 * short arrays, and a scan session five actions long never reaches a candidate.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  COOLDOWN_MS,
  CONFIRM_WINDOW_MS,
  HIDDEN_LOST_MS,
  initialScanMachine,
  scanReducer,
} from "./scanMachine";
import type { ScanAction, ScanMachine } from "./scanMachine";
import type { ScanError, Symbology } from "../../lib/vin/types";

/** §4.11 fixtures. Two VINs are enough: the machine compares them, never parses them. */
const VIN_A = "1HGCM82633A004352";
const VIN_B = "1HGCM826X3A004350";

/** §4.10, the four a camera can report. `scanMachine.test.ts` generates two of them. */
const SYMBOLOGIES = [
  "code_39",
  "code_128",
  "data_matrix",
  "qr_code",
] as const satisfies readonly Symbology[];

/** §4.10, all four. `scanMachine.test.ts` generates two of them. */
const ERRORS = [
  "permission_denied",
  "no_camera",
  "insecure_context",
  "stream_lost",
] as const satisfies readonly ScanError[];

/**
 * A device stamps `Date.now()` — about 1.8e12, six orders of magnitude above the timestamps
 * the case tests use. Generating in that range is what makes an "absolute time read as an
 * elapsed gap" fault visible at all.
 */
const EPOCH = Date.UTC(2026, 8, 4, 12, 0, 0);

const MOUNT: ScanAction = { type: "mount", secureContext: true };
const STARTED: ScanAction = { type: "stream_started" };

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const chaosTime = fc.integer({ min: EPOCH, max: EPOCH + 120_000 });

const chaosActionArb: fc.Arbitrary<ScanAction> = fc.oneof(
  fc.record({ type: fc.constant("mount" as const), secureContext: fc.boolean() }),
  fc.constant<ScanAction>({ type: "stream_started" }),
  fc.record({ type: fc.constant("stream_failed" as const), error: fc.constantFrom(...ERRORS) }),
  fc.record({
    type: fc.constant("decoded" as const),
    sighting: fc.record({
      vin: fc.constantFrom(VIN_A, VIN_B),
      raw: fc.string(),
      checkDigitValid: fc.boolean(),
      symbology: fc.constantFrom(...SYMBOLOGIES),
      atMs: chaosTime,
    }),
  }),
  // Z9's timer, drawn like everything else here: a tick from any moment, in any state,
  // including the ones where the hook would never have armed one.
  fc.record({ type: fc.constant("tick" as const), atMs: chaosTime }),
  fc.constant<ScanAction>({ type: "track_ended" }),
  fc.record({ type: fc.constant("hidden" as const), atMs: chaosTime }),
  fc.record({
    type: fc.constant("visible" as const),
    atMs: chaosTime,
    secureContext: fc.boolean(),
  }),
  fc.record({ type: fc.constant("retry" as const), secureContext: fc.boolean() }),
  fc.constant<ScanAction>({ type: "rescan" }),
  fc.record({
    type: fc.constant("accepted" as const),
    vin: fc.constantFrom(VIN_A, VIN_B),
    atMs: chaosTime,
  }),
);

const chaosArb = fc.array(chaosActionArb, { minLength: 20, maxLength: 60, size: "max" });

/** One thing that happens to a scanner, and how long after the last thing. */
type Step =
  | { k: "decode"; vin: string; dt: number }
  | { k: "accept"; vin: string; dt: number }
  | { k: "tick"; dt: number }
  | { k: "hidden"; dt: number }
  | { k: "visible"; dt: number }
  | { k: "failed"; error: ScanError }
  | { k: "rescan" }
  | { k: "track_ended" }
  | { k: "mount" };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  // Weighted like a real stream: mostly readings, occasionally everything else.
  {
    arbitrary: fc.record({
      k: fc.constant("decode" as const),
      vin: fc.constantFrom(VIN_A, VIN_B),
      dt: fc.integer({ min: 0, max: 2_500 }),
    }),
    weight: 8,
  },
  {
    arbitrary: fc.record({
      k: fc.constant("accept" as const),
      vin: fc.constantFrom(VIN_A, VIN_B),
      dt: fc.integer({ min: 0, max: 500 }),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      k: fc.constant("hidden" as const),
      dt: fc.integer({ min: 0, max: 40_000 }),
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      k: fc.constant("visible" as const),
      dt: fc.integer({ min: 0, max: 40_000 }),
    }),
    weight: 1,
  },
  {
    // Z9: the hook arms this while a candidate stands, so on a device it lands a beat after
    // one — but the reducer must answer for it wherever it arrives.
    arbitrary: fc.record({
      k: fc.constant("tick" as const),
      dt: fc.integer({ min: 0, max: 2_500 }),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({ k: fc.constant("failed" as const), error: fc.constantFrom(...ERRORS) }),
    weight: 1,
  },
  { arbitrary: fc.constant<Step>({ k: "rescan" }), weight: 1 },
  { arbitrary: fc.constant<Step>({ k: "track_ended" }), weight: 1 },
  { arbitrary: fc.constant<Step>({ k: "mount" }), weight: 2 },
);

/** Steps → actions on a clock that never goes backwards. */
function toSession(steps: readonly Step[]): ScanAction[] {
  let clock = EPOCH;
  const out: ScanAction[] = [MOUNT, STARTED];
  for (const step of steps) {
    if ("dt" in step) clock += step.dt;
    switch (step.k) {
      case "decode":
        out.push({
          type: "decoded",
          sighting: {
            vin: step.vin,
            raw: step.vin,
            checkDigitValid: true,
            symbology: "code_39",
            atMs: clock,
          },
        });
        break;
      case "accept":
        out.push({ type: "accepted", vin: step.vin, atMs: clock });
        break;
      case "tick":
        out.push({ type: "tick", atMs: clock });
        break;
      case "hidden":
        out.push({ type: "hidden", atMs: clock });
        break;
      case "visible":
        out.push({ type: "visible", atMs: clock, secureContext: true });
        break;
      case "failed":
        out.push({ type: "stream_failed", error: step.error });
        break;
      case "rescan":
        out.push({ type: "rescan" });
        break;
      case "track_ended":
        out.push({ type: "track_ended" });
        break;
      case "mount":
        // A remount is followed by the stream coming up; `useScanner` dispatches both.
        out.push(MOUNT, STARTED);
        break;
    }
  }
  return out;
}

const sessionArb = fc.array(stepArb, { minLength: 30, maxLength: 80, size: "max" }).map(toSession);

/** Both models, in every property. */
const sequenceArb = fc.oneof(chaosArb, sessionArb);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("§6.3 constants", () => {
  // N6: the constants are authoritative and tests pin them. The case tests pin all three
  // from both sides (1499/1501, 9999/10001, 29999/30001); this states the values
  // themselves, so a change fails here first and says which one moved.
  it("pins the three §6.3 windows to their spec values", () => {
    expect(CONFIRM_WINDOW_MS).toBe(1_500);
    expect(COOLDOWN_MS).toBe(10_000);
    expect(HIDDEN_LOST_MS).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// Laws
// ---------------------------------------------------------------------------

describe("§6.3 laws over every action sequence", () => {
  it("never confirms a VIN that is inside its own cooldown window", () => {
    fc.assert(
      fc.property(sequenceArb, (actions) => {
        let machine = initialScanMachine;
        for (const action of actions) {
          machine = scanReducer(machine, action);
          if (machine.state.kind !== "confirmed") continue;
          const { vin, atMs } = machine.state.sighting;
          const acceptedAt = machine.cooldown[vin];
          if (acceptedAt === undefined) continue;
          // §6.3: "the same VIN confirmed again within 10 s is ignored". A confirmed read
          // therefore never sits inside the window that its own last acceptance opened.
          // Stated as the window and not as `gap > COOLDOWN_MS`, so that tightening the
          // comparison at the other end — a sighting stamped *before* the acceptance is
          // not "within 10 s" of anything — satisfies this law rather than breaking it.
          const gap = atMs - acceptedAt;
          expect(gap >= 0 && gap <= COOLDOWN_MS).toBe(false);
        }
      }),
      { seed: 0x5c9_0001, numRuns: 500 },
    );
  });

  it("ignores every sighting of an accepted VIN for the whole cooldown window", () => {
    // The targeted form of the law above: whatever the machine was doing beforehand, once
    // a VIN is accepted, no sequence of readings of that VIN inside the window confirms.
    const insideWindow = fc.integer({ min: 0, max: COOLDOWN_MS });
    fc.assert(
      fc.property(
        sequenceArb,
        fc.integer({ min: EPOCH, max: EPOCH + 120_000 }),
        // `accepted` is excluded from the suffix: a second acceptance would move the
        // window's anchor, and the generated offsets would no longer be inside it.
        fc.array(
          fc.oneof(
            fc.record({
              type: fc.constant("decoded" as const),
              sighting: fc.record({
                vin: fc.constant(VIN_A),
                raw: fc.constant(VIN_A),
                checkDigitValid: fc.boolean(),
                symbology: fc.constantFrom(...SYMBOLOGIES),
                atMs: insideWindow,
              }),
            }),
            fc.record({ type: fc.constant("mount" as const), secureContext: fc.constant(true) }),
            fc.constant<ScanAction>({ type: "stream_started" }),
            fc.constant<ScanAction>({ type: "rescan" }),
            fc.constant<ScanAction>({ type: "track_ended" }),
            fc.record({ type: fc.constant("hidden" as const), atMs: insideWindow }),
            fc.record({
              type: fc.constant("visible" as const),
              atMs: insideWindow,
              secureContext: fc.constant(true),
            }),
            fc.record({ type: fc.constant("retry" as const), secureContext: fc.constant(true) }),
          ),
          { minLength: 10, maxLength: 30, size: "max" },
        ),
        (prefix, acceptedAt, suffix) => {
          let machine = prefix.reduce(scanReducer, initialScanMachine);
          machine = scanReducer(machine, { type: "accepted", vin: VIN_A, atMs: acceptedAt });
          for (const action of suffix) {
            // Offsets resolve against the acceptance, so every reading lands inside the
            // window however the generator shrinks.
            const shifted: ScanAction =
              action.type === "decoded"
                ? {
                    type: "decoded",
                    sighting: { ...action.sighting, atMs: acceptedAt + action.sighting.atMs },
                  }
                : action.type === "hidden"
                  ? { type: "hidden", atMs: acceptedAt + action.atMs }
                  : action.type === "visible"
                    ? { ...action, atMs: acceptedAt + action.atMs }
                    : action;
            machine = scanReducer(machine, shifted);
            expect(machine.state.kind).not.toBe("confirmed");
          }
        },
      ),
      { seed: 0x5c9_0002, numRuns: 500 },
    );
  });

  it("only confirms on a second reading taken inside the 1.5 s window", () => {
    // The VIN half of this law is proved next door; this is the timing half.
    fc.assert(
      fc.property(sequenceArb, (actions) => {
        let machine = initialScanMachine;
        for (const action of actions) {
          const before = machine;
          machine = scanReducer(before, action);
          if (machine.state.kind !== "confirmed" || before.state.kind === "confirmed") continue;
          expect(before.state.kind).toBe("candidate");
          if (before.state.kind !== "candidate") return;
          expect(machine.state.sighting.atMs - before.state.sighting.atMs).toBeLessThanOrEqual(
            CONFIRM_WINDOW_MS,
          );
        }
      }),
      { seed: 0x5c9_0003, numRuns: 500 },
    );
  });

  it("never mutates the machine or the action handed to it", () => {
    // The module's own contract is "pure". A reducer that mutated in place would still
    // pass every case test in this directory, because they all read what it returns.
    fc.assert(
      fc.property(sequenceArb, (actions) => {
        let machine: ScanMachine = deepFreeze({ ...initialScanMachine });
        for (const action of actions) {
          const frozen = deepFreeze(action);
          const machineBefore = JSON.stringify(machine);
          const actionBefore = JSON.stringify(frozen);
          const next = scanReducer(machine, frozen);
          expect(JSON.stringify(machine)).toBe(machineBefore);
          expect(JSON.stringify(frozen)).toBe(actionBefore);
          machine = deepFreeze(next);
        }
      }),
      { seed: 0x5c9_0004, numRuns: 500 },
    );
  });

  it("returns the identical machine whenever a decode changes nothing", () => {
    // ZXing calls back on nearly every frame, so a dropped reading that allocated a new —
    // but equal — machine would re-render the scan screen many times a second for as long
    // as the camera is pointed at a VIN inside its cooldown window. §6.3 says such a
    // reading is "ignored"; ignored means nothing downstream sees it.
    fc.assert(
      fc.property(sequenceArb, (actions) => {
        let machine = initialScanMachine;
        for (const action of actions) {
          const before = machine;
          machine = scanReducer(before, action);
          if (action.type !== "decoded") continue;
          if (JSON.stringify(machine) === JSON.stringify(before)) expect(machine).toBe(before);
        }
      }),
      { seed: 0x5c9_0005, numRuns: 500 },
    );
  });

  it("keeps `hiddenAtMs` exactly as the last action left it", () => {
    // The 30 s rule is a subtraction from this field and nothing else, so its whole
    // lifecycle is worth stating: `hidden` sets it, the three actions that (re)start the
    // camera clear it, everything else leaves it alone.
    fc.assert(
      fc.property(sequenceArb, (actions) => {
        let machine = initialScanMachine;
        for (const action of actions) {
          const before = machine;
          machine = scanReducer(before, action);
          if (action.type === "hidden") {
            expect(machine.hiddenAtMs).toBe(action.atMs);
          } else if (
            action.type === "mount" ||
            action.type === "retry" ||
            action.type === "visible"
          ) {
            expect(machine.hiddenAtMs).toBeNull();
          } else {
            expect(machine.hiddenAtMs).toBe(before.hiddenAtMs);
          }
        }
      }),
      { seed: 0x5c9_0006, numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// Branches the case tests run through without asserting on
// ---------------------------------------------------------------------------

const run = (actions: ScanAction[], from: ScanMachine = initialScanMachine): ScanMachine =>
  actions.reduce(scanReducer, from);
const streaming = (): ScanMachine => run([MOUNT, STARTED]);
const saw = (vin: string, atMs: number): ScanAction => ({
  type: "decoded",
  sighting: { vin, raw: vin, checkDigitValid: true, symbology: "code_39", atMs },
});

describe("§6.3 branches with no standing assertion", () => {
  it("surfaces a camera that dies while a candidate is standing", () => {
    // §6.3 routes `requesting` and `streaming` failures to `error`; a candidate is a live
    // stream too, and losing the camera mid-read must not leave "Reading… hold steady" up.
    const candidate = run([saw(VIN_A, EPOCH)], streaming());
    expect(candidate.state.kind).toBe("candidate");
    const machine = scanReducer(candidate, { type: "stream_failed", error: "no_camera" });
    expect(machine.state).toEqual({ kind: "error", error: "no_camera" });
  });

  it("never lets a second failure rewrite the error already on screen", () => {
    // §6.4 gives permission_denied its own copy and its own remedy; overwriting it with a
    // late no_camera would send the user to the wrong one.
    const denied = run([MOUNT, { type: "stream_failed", error: "permission_denied" }]);
    expect(scanReducer(denied, { type: "stream_failed", error: "no_camera" })).toBe(denied);
    expect(denied.state).toEqual({ kind: "error", error: "permission_denied" });
  });

  it("never lets a track ending rewrite an error or disturb an idle machine", () => {
    const denied = run([MOUNT, { type: "stream_failed", error: "permission_denied" }]);
    expect(scanReducer(denied, { type: "track_ended" })).toBe(denied);
    expect(scanReducer(initialScanMachine, { type: "track_ended" })).toBe(initialScanMachine);
  });

  it("does not read a wall-clock timestamp as a 30 s absence", () => {
    // `visible` with no `hidden` recorded — the state after a dead track, and the first
    // thing a real tab dispatches. The gap is zero, not `Date.now()`; the case test passes
    // 1 ms, which cannot tell those two apart.
    const lost = run([{ type: "track_ended" }], streaming());
    expect(lost.hiddenAtMs).toBeNull();
    const machine = scanReducer(lost, { type: "visible", atMs: EPOCH, secureContext: true });
    expect(machine.state).toEqual({ kind: "requesting" });
  });

  it("re-requests the camera on the visibility after a saved scan", () => {
    // `accepted` leaves `idle` with `lost: false`; §6.3's "re-request on next visibility"
    // is written for the lost case, and this is the other way into `idle`.
    const accepted = run([{ type: "accepted", vin: VIN_A, atMs: EPOCH }], streaming());
    expect(accepted.state).toEqual({ kind: "idle", lost: false });
    const machine = scanReducer(accepted, {
      type: "visible",
      atMs: EPOCH + 5,
      secureContext: true,
    });
    expect(machine.state).toEqual({ kind: "requesting" });
    expect(machine.cooldown).toEqual({ [VIN_A]: EPOCH });
  });

  it("re-requests a stream that stayed hidden past the window while the prompt was open", () => {
    // `hidden` records its time in every state, not only under a candidate. Pocketing the
    // phone during the permission prompt for over 30 s is a lost stream like any other.
    const machine = run(
      [
        { type: "hidden", atMs: EPOCH },
        { type: "visible", atMs: EPOCH + HIDDEN_LOST_MS + 1, secureContext: true },
      ],
      run([MOUNT]),
    );
    // §6.3: "return to idle and re-request on next visibility" — the visibility that
    // measures the gap IS that next visibility, so it re-requests rather than dead-ending.
    expect(machine.state).toEqual({ kind: "requesting" });
  });
});

// ---------------------------------------------------------------------------
// The three windows on a device clock
// ---------------------------------------------------------------------------

describe("§6.3 windows on a wall clock", () => {
  // Every case test in this directory counts from 0, where an absolute timestamp and an
  // elapsed gap are the same number. On a device they are not.
  it("confirms two readings 1.500 s apart and not 1.501 s apart", () => {
    expect(
      run([saw(VIN_A, EPOCH), saw(VIN_A, EPOCH + CONFIRM_WINDOW_MS)], streaming()).state.kind,
    ).toBe("confirmed");
    expect(
      run([saw(VIN_A, EPOCH), saw(VIN_A, EPOCH + CONFIRM_WINDOW_MS + 1)], streaming()).state.kind,
    ).toBe("candidate");
  });

  it("ignores an accepted VIN at 10.000 s and reads it again at 10.001 s", () => {
    const accepted = run(
      [{ type: "accepted", vin: VIN_A, atMs: EPOCH }, MOUNT, STARTED],
      streaming(),
    );
    expect(scanReducer(accepted, saw(VIN_A, EPOCH + COOLDOWN_MS))).toBe(accepted);
    const after = run(
      [saw(VIN_A, EPOCH + COOLDOWN_MS + 1), saw(VIN_A, EPOCH + COOLDOWN_MS + 2)],
      accepted,
    );
    expect(after.state.kind).toBe("confirmed");
  });

  it("survives 30.000 s hidden and re-requests at 30.001 s", () => {
    const hidden = run([{ type: "hidden", atMs: EPOCH }], streaming());
    expect(
      scanReducer(hidden, { type: "visible", atMs: EPOCH + HIDDEN_LOST_MS, secureContext: true })
        .state,
    ).toEqual({ kind: "streaming" });
    expect(
      scanReducer(hidden, {
        type: "visible",
        atMs: EPOCH + HIDDEN_LOST_MS + 1,
        secureContext: true,
      }).state,
    ).toEqual({ kind: "requesting" });
  });
});
