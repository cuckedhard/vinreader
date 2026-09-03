/**
 * §6.3 scanner state machine. Pure: no DOM, no React, no timers and no clock
 * reads — every time value arrives inside an action, so the whole of §6.3 is
 * testable without a camera.
 */

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

/** §6.3: an insecure context is an error before any permission prompt happens. */
function cameraStart(secureContext: boolean): ScanMachineState {
  return secureContext ? { kind: "requesting" } : { kind: "error", error: "insecure_context" };
}

/** The states in which a track is live, so decodes and track events are real. */
function isLive(state: ScanMachineState): boolean {
  return state.kind === "streaming" || state.kind === "candidate";
}

/**
 * §6.3 cooldown, consulted rather than expired: entries are compared, never
 * swept. Both §6.3 windows are inclusive of their bound — a gap of exactly the
 * constant is inside the window.
 */
function isCoolingDown(machine: ScanMachine, vin: string, atMs: number): boolean {
  const acceptedAt = machine.cooldown[vin];
  return acceptedAt !== undefined && atMs - acceptedAt <= COOLDOWN_MS;
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
      if (machine.state.kind === "requesting" || isLive(machine.state)) {
        return { ...machine, state: { kind: "error", error: action.error } };
      }
      return machine;

    case "decoded": {
      // A late frame from a stopped stream cannot resurrect a scan.
      if (!isLive(machine.state)) return machine;
      const { sighting } = action;
      if (isCoolingDown(machine, sighting.vin, sighting.atMs)) return machine;
      const confirms =
        machine.state.kind === "candidate" &&
        machine.state.sighting.vin === sighting.vin &&
        sighting.atMs - machine.state.sighting.atMs <= CONFIRM_WINDOW_MS;
      // The confirming sighting is the one kept: its raw bytes are what clinched
      // the read and its timestamp is the moment of confirmation.
      return { ...machine, state: { kind: confirms ? "confirmed" : "candidate", sighting } };
    }

    case "track_ended":
      return isLive(machine.state) ? { ...machine, state: { kind: "idle", lost: true } } : machine;

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
      if (gap > HIDDEN_LOST_MS) return { ...next, state: { kind: "idle", lost: true } };
      // §6.3: a machine with no stream re-requests on the next visibility.
      if (machine.state.kind === "idle") {
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
