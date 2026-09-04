/**
 * §6.3 scanner state machine. `scanReducer` is pure: no DOM, no React, no timers
 * and no clock reads — every time value arrives inside an action, so the whole of
 * §6.3 is testable without a camera. `startingScanMachine` is the one export that
 * looks outside itself, and only to seed a cooldown that has to outlive the
 * component the reducer runs in.
 */

import { cooldownStore } from "./cooldownStore";
import type { ScanError, Symbology } from "../../lib/vin/types";

/** §6.3 two-read agreement window. */
export const CONFIRM_WINDOW_MS = 1500;

/** §6.3 same-VIN cooldown; stops a return to the Scan screen double-logging. */
export const COOLDOWN_MS = 10000;

/** §6.3 a tab hidden longer than this counts as a lost stream. */
export const HIDDEN_LOST_MS = 30000;

export interface ScanSighting {
  vin: string;
  raw: string;
  checkDigitValid: boolean;
  symbology: Symbology;
  atMs: number;
}

export type ScanMachineState =
  | { kind: "idle"; lost: boolean }
  | { kind: "requesting" }
  | { kind: "streaming" }
  | { kind: "candidate"; sighting: ScanSighting }
  | { kind: "confirmed"; sighting: ScanSighting }
  | { kind: "error"; error: ScanError };

export interface ScanMachine {
  state: ScanMachineState;
  /** VIN → the time it was accepted and persisted. Only "accepted" writes here. */
  cooldown: Record<string, number>;
  hiddenAtMs: number | null;
}

export type ScanAction =
  | { type: "mount"; secureContext: boolean }
  | { type: "stream_started" }
  | { type: "stream_failed"; error: ScanError }
  | { type: "decoded"; sighting: ScanSighting }
  /**
   * The §6.3 agreement window running out under a standing candidate. The hook owns the
   * timer and stamps the instant; the reducer only compares it, so P3 holds.
   */
  | { type: "tick"; atMs: number }
  | { type: "track_ended" }
  | { type: "hidden"; atMs: number }
  | { type: "visible"; atMs: number; secureContext: boolean }
  | { type: "retry"; secureContext: boolean }
  | { type: "rescan" }
  | { type: "accepted"; vin: string; atMs: number };

export const initialScanMachine: ScanMachine = {
  state: { kind: "idle", lost: false },
  cooldown: {},
  hiddenAtMs: null,
};

/**
 * The machine a mount starts from. §6.3's cooldown guards "return to Scan", and
 * that return is a fresh React mount — so the cooldown is seeded from a store that
 * outlives the screen rather than from whatever the last component instance held.
 * `initialScanMachine` stays empty because the reducer's own tests start clean, and
 * the reducer itself never touches the store: a reducer that read module state
 * would not be pure.
 */
export function startingScanMachine(
  cooldown: Record<string, number> = cooldownStore.read(),
): ScanMachine {
  return { ...initialScanMachine, cooldown };
}

/** §6.3: an insecure context is an error before any permission prompt happens. */
function cameraStart(secureContext: boolean): ScanMachineState {
  return secureContext ? { kind: "requesting" } : { kind: "error", error: "insecure_context" };
}

/**
 * Whether a track is live, so decodes and track events are real. A hidden tab is
 * not live even while the state kind still reads `streaming`: the camera is
 * released on `hidden`, but ZXing's decode loop can still call back once from a
 * timer tick that was already queued, and that frame must not rebuild the
 * candidate `hidden` just dropped.
 */
function isLive(machine: ScanMachine): boolean {
  if (machine.hiddenAtMs !== null) return false;
  return machine.state.kind === "streaming" || machine.state.kind === "candidate";
}

/**
 * Both §6.3 windows are two-sided. Timestamps come from `Date.now()`, which follows
 * the wall clock, so after a backwards correction a one-sided `gap <= bound` reads
 * every earlier acceptance as "still cooling down" for the whole of the jump. A
 * sighting stamped before the thing it is measured against is not within any window
 * of it. The bound itself stays inclusive: a gap of exactly the constant is inside.
 */
function isWithin(gapMs: number, windowMs: number): boolean {
  return gapMs >= 0 && gapMs <= windowMs;
}

/** §6.3 cooldown, consulted rather than expired: entries are compared, never swept. */
function isCoolingDown(machine: ScanMachine, vin: string, atMs: number): boolean {
  const acceptedAt = machine.cooldown[vin];
  return acceptedAt !== undefined && isWithin(atMs - acceptedAt, COOLDOWN_MS);
}

export function scanReducer(machine: ScanMachine, action: ScanAction): ScanMachine {
  switch (action.type) {
    case "mount":
    case "retry":
      // Retry re-runs the mount logic, so an insecure context stays an error.
      // The cooldown map survives: returning to Scan is exactly what it guards.
      return { ...machine, state: cameraStart(action.secureContext), hiddenAtMs: null };

    case "stream_started":
      return machine.state.kind === "requesting"
        ? { ...machine, state: { kind: "streaming" } }
        : machine;

    case "stream_failed":
      // Honoured while the camera is coming up or running. A failure reported
      // after the caller stopped the stream itself must not overwrite a read
      // the user is still acting on.
      if (machine.state.kind === "requesting" || isLive(machine)) {
        return { ...machine, state: { kind: "error", error: action.error } };
      }
      return machine;

    case "decoded": {
      // A late frame from a stopped or hidden stream cannot resurrect a scan.
      if (!isLive(machine)) return machine;
      const { sighting } = action;
      if (isCoolingDown(machine, sighting.vin, sighting.atMs)) return machine;
      const confirms =
        machine.state.kind === "candidate" &&
        machine.state.sighting.vin === sighting.vin &&
        isWithin(sighting.atMs - machine.state.sighting.atMs, CONFIRM_WINDOW_MS);
      // The confirming sighting is the one kept: its raw bytes are what clinched
      // the read and its timestamp is the moment of confirmation.
      return { ...machine, state: { kind: confirms ? "confirmed" : "candidate", sighting } };
    }

    case "tick": {
      // §6.3 gives agreement 1.5 s, and nothing used to leave `candidate` when it ran out:
      // a phone lowered after a single read kept "Reading… hold steady." up over a live
      // preview of nothing, which in the dark reads as "keep holding" for a beep that can
      // never come (Z9). Function was never at stake — every sighting replaces the
      // candidate, so a stale one cannot confirm — but §6.1 makes that line the primary
      // feedback, and it was telling the user something untrue.
      if (machine.state.kind !== "candidate") return machine;
      // Two-sided like every other §6.3 window: a tick stamped before the candidate means
      // the clock moved, and that candidate can no longer confirm against anything either
      // (a sighting measured against a future stamp starts a fresh window), so the line
      // would be as untrue in that direction.
      return isWithin(action.atMs - machine.state.sighting.atMs, CONFIRM_WINDOW_MS)
        ? machine
        : { ...machine, state: { kind: "streaming" } };
    }

    case "track_ended":
      return isLive(machine) ? { ...machine, state: { kind: "idle", lost: true } } : machine;

    case "hidden": {
      // A candidate that survived a pocket and confirmed on return would be a
      // scan the user never took, so the pending read is dropped.
      const state: ScanMachineState =
        machine.state.kind === "candidate" ? { kind: "streaming" } : machine.state;
      return { ...machine, state, hiddenAtMs: action.atMs };
    }

    case "visible": {
      const next: ScanMachine = { ...machine, hiddenAtMs: null };
      // The user must still act on an error or on a confirmed read; coming back
      // to the tab is not that action.
      if (machine.state.kind === "error" || machine.state.kind === "confirmed") return next;
      const gap = machine.hiddenAtMs === null ? 0 : action.atMs - machine.hiddenAtMs;
      // §6.3: a stream hidden past the window is lost and re-requested "on next
      // visibility" — and this event is that next visibility, so the re-request
      // happens here. Stopping at idle left someone back from a pocket looking at a
      // dead preview with no second visibility coming. A machine that is already
      // idle (a dead track, a saved scan) re-requests down the same path, and an
      // insecure context still becomes an error without a permission prompt.
      if (gap > HIDDEN_LOST_MS || machine.state.kind === "idle") {
        return { ...next, state: cameraStart(action.secureContext) };
      }
      return next;
    }

    case "rescan":
      // No cooldown entry: the rejected read was never persisted, so the same
      // VIN must be readable again immediately.
      return machine.state.kind === "confirmed"
        ? { ...machine, state: { kind: "streaming" } }
        : machine;

    case "accepted":
      // The caller reports a persisted read; the cooldown keys on this alone.
      return {
        ...machine,
        state: { kind: "idle", lost: false },
        cooldown: { ...machine.cooldown, [action.vin]: action.atMs },
      };
  }
}
