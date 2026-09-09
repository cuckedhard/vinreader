import { describe, expect, it } from "vitest";
import { CONFIRM_WINDOW_MS } from "../src/features/scan/scanMachine";
import type { ConfirmCell, ConfirmRecord } from "../bench/confirm-record";
import { confirmSection, confirmSummaryLine, windowVerdict } from "../bench/confirm-report";

/**
 * [SB-5-a] The §6.3 sentence in `bench/report.md` must not be reassuring about a cell that
 * never confirmed.
 *
 * `bench/run.ts` compared cell means against §6.3's agreement window with
 * `cells.filter((c) => c.meanMs !== null && c.meanMs > CONFIRM_WINDOW_MS)`, and a cell that
 * never confirmed has `meanMs === null`. It was dropped *before* the comparison, so an empty
 * result printed "Every cell's mean is inside §6.3's 1500 ms agreement window, so on this
 * scene the standing candidate typically survives to meet its second read" — in exactly the
 * case a time-to-confirm number exists to catch. The commit that added the `not_confirmed`
 * outcome to the probe deleted it from the conclusion in the same breath: the false branch was
 * unreachable when it mattered, the fifth guard in this slice that could not fail.
 *
 * The corpus does not oblige with a non-confirming cell — the recording in the tree is 48 of
 * 48 — so the recordings below are constructed. That is the point: a report sentence has to be
 * true of every recording, and the one it was false for is the one nobody had.
 *
 * `CONFIRM_WINDOW_MS` is imported from `scanMachine`, never re-typed (§4, §7 item 5), and the
 * numbers below are written relative to it so a change to §6.3's constant cannot leave this
 * file quietly asserting the old window.
 */

const INSIDE = CONFIRM_WINDOW_MS - 500;
const OUTSIDE = CONFIRM_WINDOW_MS + 500;
const REASSURING = "typically survives to meet its second read";

function cell(over: Partial<ConfirmCell>): ConfirmCell {
  return {
    symbology: "code_128",
    tier: "clean",
    measured: 8,
    confirmed: 8,
    notConfirmed: 0,
    faults: 0,
    meanMs: INSIDE,
    minMs: INSIDE - 20,
    maxMs: INSIDE + 20,
    ...over,
  };
}

/** A cell that never confirmed: eight attempts, eight give-ups, and therefore no mean. */
const NEVER = cell({
  symbology: "code_39_i",
  tier: "severe",
  confirmed: 0,
  notConfirmed: 8,
  meanMs: null,
  minMs: null,
  maxMs: null,
});

describe("[SB-5-a] windowVerdict", () => {
  it("is reassuring only when every cell confirmed on every repeat", () => {
    const verdict = windowVerdict([cell({}), cell({ symbology: "code_39_i" })], 25_000);
    expect(verdict).toContain(REASSURING);
    expect(verdict).toContain(`${CONFIRM_WINDOW_MS} ms`);
  });

  it("does not print the reassuring sentence for a cell that never confirmed", () => {
    const verdict = windowVerdict([cell({}), NEVER], 25_000);
    expect(verdict, "the sentence the row is about").not.toContain(REASSURING);
    expect(verdict).toContain("`code_39_i` severe produced no mean at all");
    expect(verdict).toContain("0/8 confirmed");
    expect(verdict, "and says why a null mean is not a small mean").toContain(
      "is not a cell inside",
    );
  });

  it("does not print it for a recording where every cell never confirmed", () => {
    const verdict = windowVerdict([NEVER], 25_000);
    expect(verdict).not.toContain(REASSURING);
    expect(verdict).toContain("produced no mean at all");
  });

  /**
   * The subtler half of the same bias: the cell *did* produce a mean, from the three repeats
   * that confirmed, and the five that never did are invisible in it. A mean over survivors is
   * inside the window by construction and says nothing about the cell.
   */
  it("does not print it for a cell whose mean is over survivors only", () => {
    const verdict = windowVerdict([cell({ confirmed: 3, notConfirmed: 5 })], 25_000);
    expect(verdict).not.toContain(REASSURING);
    expect(verdict).toContain("lost repeats that never confirmed");
    expect(verdict).toContain("5 of 8");
    expect(verdict).toContain("survivor statistic");
  });

  it("still names the cells whose means sit above the window", () => {
    const verdict = windowVerdict([cell({}), cell({ tier: "severe", meanMs: OUTSIDE })], 25_000);
    expect(verdict).not.toContain(REASSURING);
    expect(verdict).toContain("`code_128` severe sits above");
    expect(verdict).toContain(`${OUTSIDE} ms`);
  });

  it("reports both a missing mean and an over-window mean rather than one of them", () => {
    const verdict = windowVerdict([NEVER, cell({ tier: "severe", meanMs: OUTSIDE })], 25_000);
    expect(verdict).toContain("produced no mean at all");
    expect(verdict).toContain("sits above");
    expect(verdict).not.toContain(REASSURING);
  });

  it("says nothing reassuring about a recording with no cells", () => {
    const verdict = windowVerdict([], 25_000);
    expect(verdict).not.toContain(REASSURING);
    expect(verdict).toContain("no cells in this recording");
  });

  /** The give-up clock is the recording's, not a number written down here. */
  it("quotes the recording's own timeout", () => {
    expect(windowVerdict([NEVER], 9_999)).toContain("9999 ms");
  });
});

/**
 * And the section that goes into `bench/report.md` carries the verdict, so the fix is not
 * stranded in a function the report does not call. The table and the Overall paragraph are
 * asserted alongside it because those are the two places SB-5-a's partial mitigation lived —
 * they were true and the sentence beneath them was not, which is how a reader ends up
 * believing the sentence.
 */
function record(cells: readonly ConfirmCell[]): ConfirmRecord {
  const confirmed = cells.reduce((sum, c) => sum + c.confirmed, 0);
  const measured = cells.reduce((sum, c) => sum + c.measured, 0);
  return {
    probe: "bench/confirm-probe.ts",
    command: "bun run bench/confirm-probe.ts --repeats 8",
    provenance: { commit: null, dirty: false },
    dist: "dist",
    machine: { cpus: 4, loadavg: [1, 1, 1] },
    config: {
      vin: "1HGCM82633A004352",
      runSeed: 1,
      frames: 12,
      fps: 10,
      width: 1920,
      height: 1080,
      repeats: 8,
      timeoutMs: 25_000,
      symbologies: ["code_128"],
      tiers: ["clean", "severe"],
      chromium: null,
    },
    overall: {
      symbology: "all",
      tier: "all",
      measured,
      confirmed,
      notConfirmed: measured - confirmed,
      faults: 0,
      meanMs: confirmed === 0 ? null : INSIDE,
      minMs: confirmed === 0 ? null : INSIDE,
      maxMs: confirmed === 0 ? null : INSIDE,
    },
    cells,
    measurements: [],
  };
}

describe("[SB-5-a] the report section the bench writes", () => {
  it("carries the shortfall, not the reassurance, when a cell never confirmed", () => {
    const text = confirmSection({ kind: "ok", record: record([cell({}), NEVER]) }).join("\n");
    expect(text, "the sentence run.ts used to print here").not.toContain(REASSURING);
    expect(text).toContain("produced no mean at all");
    // The mitigation that was already there and did not settle it: a `-` in the table and a
    // count in the Overall line, under a sentence that contradicted both.
    expect(text, "the null mean still reads as `-` in the table").toContain(
      "| code_39_i | severe | 0/8 | - | - | - | 0 |",
    );
    expect(text).toContain("8 repeats never confirmed inside 25000 ms");
  });

  it("is reassuring on a recording that earns it", () => {
    const text = confirmSection({ kind: "ok", record: record([cell({})]) }).join("\n");
    expect(text).toContain(REASSURING);
  });

  it("says the number is not measured when there is no recording", () => {
    const text = confirmSection({ kind: "none" }).join("\n");
    expect(text).toContain("**Not measured.**");
    expect(text).not.toContain(REASSURING);
  });

  it("says a corrupt recording is corrupt rather than absent", () => {
    const text = confirmSection({ kind: "bad", reason: "Unexpected token" }).join("\n");
    expect(text).toContain("**Unreadable recording**");
    expect(text).toContain("Unexpected token");
    expect(text).not.toContain(REASSURING);
  });
});

/**
 * The stdout line, which had the same defect one line further down: `mean 865 ms over 48 runs`
 * where 48 is every repeat attempted, not the ones the mean is made of.
 */
describe("[SB-5-a] the bench's own summary line", () => {
  it("names the runs the mean is made of, not the runs attempted", () => {
    const line = confirmSummaryLine({
      kind: "ok",
      record: record([cell({ confirmed: 3, notConfirmed: 5 })]),
    });
    expect(line).toContain("over the 3 of 8 runs that confirmed");
    expect(line, "not a denominator it did not measure").not.toContain("over 8 runs");
  });

  it("says there is no mean rather than printing a dash and a denominator", () => {
    const line = confirmSummaryLine({ kind: "ok", record: record([NEVER]) });
    expect(line).toContain("no mean — 0 of 8 runs confirmed inside 25000 ms");
  });

  it("names the command when there is no recording", () => {
    expect(confirmSummaryLine({ kind: "none" })).toContain("not measured —");
  });
});
