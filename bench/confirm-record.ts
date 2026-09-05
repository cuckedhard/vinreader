/**
 * §13.4 run (b) — the shape of a recorded **time-to-confirm** measurement (SB-5).
 *
 * §13.4 asks the report for three things: decode rate per symbology × tier, false accepts,
 * and mean time-to-confirm. `bench/run.ts` takes the first two. The third is not a property
 * of one frame — §6.3 confirms on two agreeing reads inside `CONFIRM_WINDOW_MS` — so it can
 * only be measured by driving the built app with a fake camera, which is what
 * `bench/confirm-probe.ts` does: minutes of Chromium, a build of `dist/`, and a browser
 * launch per cell. That does not belong inside `bun run bench`.
 *
 * So the probe records and the report **quotes**, under SB-11's rule: a quote carries where
 * it came from and enough for a reader to tell whether it is stale. This module is the one
 * definition of that record — the writer and the reader share it rather than each keeping
 * their own copy of the shape (§7 item 5). It holds types and a path and nothing else, so
 * importing it can never run a probe.
 */

import { fileURLToPath } from "node:url";
import type { BenchSymbology } from "./corpus";
import type { Tier } from "./degrade";
import type { Provenance } from "./provenance";

/** The recording `bench/report.md` quotes. Never `report.md` or `report.json`. */
export const CONFIRM_RECORD_PATH = fileURLToPath(new URL("confirm.json", import.meta.url));

/**
 * One repeat. `confirmed` and `not_confirmed` are results; `fault` is the harness failing to
 * present a scene at all, and is kept out of every mean (SB-5). Folding the three together —
 * which the probe did until now, as a single `ms: number | null` — is how a launch flake
 * becomes a slow scanner in a report.
 */
export type Outcome = "confirmed" | "not_confirmed" | "fault";

export interface Measurement {
  symbology: BenchSymbology;
  tier: Tier;
  repeat: number;
  outcome: Outcome;
  /** Milliseconds from the first usable video frame to the §6.3 `confirmed` navigation. */
  ms: number | null;
  /** Why the harness could not measure this repeat, on `fault` only. */
  fault: string | null;
  /** How many attempts the harness needed before the scene came up. 1 on a clean repeat. */
  attempts: number;
}

/** One symbology × tier, or the whole run when the filter is everything. */
export interface ConfirmCell {
  symbology: BenchSymbology | "all";
  tier: Tier | "all";
  /** Repeats that produced a result — faults are not measurements and are excluded (SB-5). */
  measured: number;
  confirmed: number;
  notConfirmed: number;
  faults: number;
  meanMs: number | null;
  minMs: number | null;
  maxMs: number | null;
}

export interface ConfirmConfig {
  vin: string;
  runSeed: number;
  frames: number;
  fps: number;
  width: number;
  height: number;
  repeats: number;
  timeoutMs: number;
  symbologies: readonly BenchSymbology[];
  tiers: readonly Tier[];
  chromium: string | null;
}

export interface ConfirmRecord {
  probe: string;
  command: string;
  /** The tree the measured **build** came from, not the one the probe ran in. */
  provenance: Provenance;
  /** The build that was served, so a recording names the program it measured. */
  dist: string;
  /**
   * The machine, at the moment of recording. Unlike a decode rate, a millisecond is not a
   * property of the program alone: this bench shares a four-core box with other runs, and a
   * mean taken under load is a mean about the box as much as about §6.3. Recorded rather
   * than assumed away, so a reader can discount it. It reaches no decode and no seed.
   */
  machine: { cpus: number; loadavg: readonly number[] };
  config: ConfirmConfig;
  overall: ConfirmCell;
  cells: readonly ConfirmCell[];
  measurements: readonly Measurement[];
}
