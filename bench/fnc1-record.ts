/**
 * §13.7 R5 question (b) — the shape of a recorded **leading-FNC1** measurement (SB-8).
 *
 * `bench/fnc1-probe.ts` renders the two shapes a GS1-128 door-jamb label can take when it
 * opens with FNC1, decodes each one twice off the same bytes — as the app sees them, and
 * with `]C1` put back — and so measures what §4.6's `stripAimIdentifier` is worth. Those rows
 * are deliberately **not** in `BENCH_SYMBOLOGIES`: adding them would move the §13.6 threshold
 * list without anyone deciding to.
 *
 * That leaves the main report with a header line reading "reads carrying the §4.6 AIM
 * identifier: 0" and nothing to say why — the newest §4.6 guard, on the app's scan path, with
 * no byte through it anywhere in the gate. So the probe records and the report quotes, under
 * the same rule as the other two recordings (SB-11): the writer and the reader share one
 * definition of the shape, and the quote carries where it came from.
 *
 * Types and a path, no side effects: importing this can never run a probe.
 */

import { fileURLToPath } from "node:url";
import type { BenchSymbology } from "./corpus";
import type { Tier } from "./degrade";
import type { Provenance } from "./provenance";

/** The recording `bench/report.md` quotes. Never `report.md` or `report.json`. */
export const FNC1_RECORD_PATH = fileURLToPath(new URL("fnc1.json", import.meta.url));

/** What the decoder was handed: the app's 1920x1080 field (SB-2), or the symbol alone. */
export type Fnc1Layout = "frame" | "crop";

/** One row × tier × layout, scored twice off the same decoded bytes. */
export interface Fnc1Cell {
  symbology: BenchSymbology;
  tier: Tier;
  /** `frame` is what the app decodes (SB-2); `crop` is the symbol alone. */
  layout: Fnc1Layout;
  attempts: number;
  /** Frames that decoded to any text at all. */
  decoded: number;
  /** Reads that carried the §4.6 AIM identifier, i.e. where the strip actually fired. */
  aimSeen: number;
  /** Correct VIN from the bytes the app sees — `]C1` already removed (§4.6). */
  shipped: number;
  /** Correct VIN from the same bytes with `]C1` put back: §4.2 before the strip existed. */
  unstripped: number;
}

/** A wrong VIN, on either scoring. Zero is the only acceptable value (§13.6). */
export interface Fnc1FalseAccept {
  vin: string;
  returned: string;
  scoring: "shipped" | "unstripped";
  symbology: BenchSymbology;
  tier: Tier;
  layout: Fnc1Layout;
  text: string | null;
  seed: number;
}

export interface Fnc1Record {
  probe: string;
  command: string;
  /** The tree the bench decoded with — `src/lib/vin/symbologies.ts` is the code under test. */
  provenance: Provenance;
  config: {
    seed: number;
    count: number;
    rows: readonly BenchSymbology[];
    tiers: readonly Tier[];
    layouts: readonly Fnc1Layout[];
    path: string;
    formats: readonly string[];
    hints: readonly string[];
  };
  cells: readonly Fnc1Cell[];
  falseAccepts: readonly Fnc1FalseAccept[];
  /** One decoded leading-FNC1 read, verbatim, so the shape is on the page. */
  sample: string | null;
}
