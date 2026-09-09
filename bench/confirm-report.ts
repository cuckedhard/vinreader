/**
 * §13.4's third number — **mean time-to-confirm** — turned into the section of
 * `bench/report.md` that quotes it (SB-5, SB-5-a).
 *
 * Its own module, and not a block inside `bench/run.ts`, for one reason: `run.ts` ends with a
 * top-level `await main()`, so importing it runs the whole bench. Rendering this section is
 * pure — a recording in, markdown lines out, no disk beyond the one read below — and
 * `tests/bench-confirm-report.test.ts` can therefore hand it the recordings a corpus does not
 * happen to produce. That is what SB-5-a needed: the sentence that was wrong was wrong only
 * for a recording whose cells never confirmed, and no assertion could reach it while the
 * function lived behind a bench run.
 */

import { readFile } from "node:fs/promises";
import { CONFIRM_WINDOW_MS } from "../src/features/scan/scanMachine";
import { CONFIRM_RECORD_PATH } from "./confirm-record";
import type { ConfirmCell, ConfirmRecord } from "./confirm-record";
import { commitsTouchingSince, shortSha } from "./provenance";

/**
 * What `bench/confirm.json` was. Two of §13.4's three report numbers are taken by the bench
 * run itself; this one cannot be — confirming is two agreeing reads inside §6.3's
 * `CONFIRM_WINDOW_MS`, so it needs the built app, a fake camera and a browser launch per cell
 * (run (b), `bench/confirm-probe.ts`). The report quotes it, with the provenance that says
 * whether the recording still describes the app (SB-5, under SB-11's rule for a quote).
 *
 * Three states, not two: absent and corrupt are different, and only one of them is anybody's
 * fault.
 */
export type ConfirmRead =
  { kind: "none" } | { kind: "bad"; reason: string } | { kind: "ok"; record: ConfirmRecord };

export async function readConfirmRecord(): Promise<ConfirmRead> {
  let text: string;
  try {
    text = await readFile(CONFIRM_RECORD_PATH, "utf8");
  } catch {
    return { kind: "none" };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as ConfirmRecord).cells) ||
      typeof (parsed as ConfirmRecord).overall !== "object"
    ) {
      return { kind: "bad", reason: "not a confirm-probe recording" };
    }
    return { kind: "ok", record: parsed as ConfirmRecord };
  } catch (error) {
    // A corrupt recording is reported, never silently read as "not measured": those are
    // different states and only one of them is anybody's fault.
    return { kind: "bad", reason: error instanceof Error ? error.message : String(error) };
  }
}

export const CONFIRM_COMMAND = "bun run build && bun run bench/confirm-probe.ts --repeats 5";

/**
 * [SB-5-a] The one-line version, for the bench's stdout summary.
 *
 * `run.ts` printed `mean 865 ms over 48 runs`, where 48 is `measured` — every repeat that
 * produced a result, confirmed or not. A mean is a statistic about the ones that confirmed, so
 * on a recording with give-ups that line quoted a number over a denominator it did not
 * measure: the same defect as the §6.3 sentence, one line further down. It names both counts
 * now, and a recording where nothing confirmed says so instead of printing a dash and a
 * denominator.
 */
export function confirmSummaryLine(read: ConfirmRead): string {
  if (read.kind !== "ok") return `not measured — ${CONFIRM_COMMAND}`;
  const { overall } = read.record;
  const quoted = "quoted from bench/confirm.json (SB-5)";
  if (overall.meanMs === null) {
    return (
      `no mean — 0 of ${overall.measured} runs confirmed inside ` +
      `${read.record.config.timeoutMs} ms, ${quoted}`
    );
  }
  return (
    `mean ${overall.meanMs.toFixed(0)} ms over the ${overall.confirmed} of ` +
    `${overall.measured} runs that confirmed, ${quoted}`
  );
}

/** `\`code_128\` severe`, the way every sentence below names a cell. */
function cellName(cell: ConfirmCell): string {
  return `\`${cell.symbology}\` ${cell.tier}`;
}

/**
 * [SB-5-a] Whether this recording's cells confirm inside §6.3's agreement window.
 *
 * The bug this replaces: the comparison was `cells.filter((c) => c.meanMs !== null && c.meanMs
 * > CONFIRM_WINDOW_MS)`, and a cell that **never confirmed** has `meanMs === null`. It was
 * filtered out *before* the comparison, so an empty result printed "Every cell's mean is
 * inside §6.3's 1500 ms agreement window, so on this scene the standing candidate typically
 * survives to meet its second read" — in exactly the case the number exists to catch. The
 * `not_confirmed` outcome had just been added to the probe and then deleted from the
 * conclusion; the reassuring branch was unreachable only when it was true and reachable only
 * when it was false.
 *
 * So the reassuring sentence now needs three things, all of them positive facts about the
 * recording rather than the absence of one: cells to talk about, a mean for every one of them,
 * and no repeat anywhere that failed to confirm. Anything else is reported, in the order a
 * reader cares about it — a cell with no mean first, because "no mean" is not a small mean,
 * then repeats lost inside a cell that did produce one, then the means that sit above the
 * window. `CONFIRM_WINDOW_MS` is §6.3's and is imported, never re-typed.
 */
export function windowVerdict(cells: readonly ConfirmCell[], timeoutMs: number): string {
  const noMean = cells.filter((cell) => cell.meanMs === null);
  const partial = cells.filter((cell) => cell.meanMs !== null && cell.notConfirmed > 0);
  const overWindow = cells.filter(
    (cell) => cell.meanMs !== null && cell.meanMs > CONFIRM_WINDOW_MS,
  );

  const shortfall: string[] = [];
  if (noMean.length > 0) {
    shortfall.push(
      `**${noMean.map(cellName).join(", ")} produced no mean at all** — ` +
        noMean
          .map(
            (cell) =>
              `${cell.confirmed}/${cell.measured} confirmed` +
              (cell.faults === 0 ? "" : `, ${cell.faults} harness faults`),
          )
          .join("; ") +
        `. A cell that never confirmed inside ${timeoutMs} ms is not a cell inside §6.3's ` +
        `${CONFIRM_WINDOW_MS} ms window; it is a cell with no answer, and every mean in this ` +
        "section is over the other cells only. This is the state a time-to-confirm number " +
        "exists to catch (SB-5-a).",
    );
  }
  if (partial.length > 0) {
    shortfall.push(
      `**${partial.map(cellName).join(", ")} lost repeats that never confirmed** — ` +
        partial.map((cell) => `${cell.notConfirmed} of ${cell.measured}`).join("; ") +
        `, given up on at ${timeoutMs} ms. Their means are over the repeats that did confirm, ` +
        "so those means are a survivor statistic and read faster than the cell is.",
    );
  }
  if (overWindow.length > 0) {
    shortfall.push(
      `**${overWindow.map(cellName).join(", ")} ` +
        `${overWindow.length === 1 ? "sits" : "sit"} above §6.3's ${CONFIRM_WINDOW_MS} ms ` +
        "agreement window** — mean " +
        overWindow.map((cell) => `${(cell.meanMs ?? 0).toFixed(0)} ms`).join(", ") +
        ". A candidate that old has lapsed, so confirmation on those labels typically " +
        "restarts at least once: the user holds the phone still through more than one " +
        "window. That is the number a confirmation change (§6.3) would be aiming at.",
    );
  }
  if (shortfall.length > 0) return shortfall.join(" ");

  if (cells.length === 0) {
    return (
      "There are no cells in this recording, so it says nothing about §6.3's " +
      `${CONFIRM_WINDOW_MS} ms agreement window either way.`
    );
  }
  return (
    `Every cell confirmed on every repeat, and every mean is inside §6.3's ` +
    `${CONFIRM_WINDOW_MS} ms agreement window, so on this scene the standing candidate ` +
    "typically survives to meet its second read."
  );
}

export function confirmSection(read: ConfirmRead): string[] {
  const out: string[] = ["## Time to confirm (§13.4 run b, SB-5)", ""];
  if (read.kind !== "ok") {
    out.push(
      (read.kind === "none"
        ? `**Not measured.** There is no recording at \`${CONFIRM_RECORD_PATH}\`. `
        : `**Unreadable recording** at \`${CONFIRM_RECORD_PATH}\` — ${read.reason}. `) +
        "§13.4 asks this report for decode rate, false accepts **and mean time-to-confirm**; " +
        `the third comes from run (b). Take it with \`${CONFIRM_COMMAND}\`.`,
    );
    out.push("");
    return out;
  }

  const { record } = read;
  const since =
    record.provenance.commit === null
      ? null
      : commitsTouchingSince(record.provenance.commit, ["src"]);
  const verdict = windowVerdict(record.cells, record.config.timeoutMs);

  out.push(
    "**Quoted, not measured by this run (SB-11).** Confirmation is a property of a stream, " +
      "not of a frame: §6.3 confirms on two agreeing reads inside " +
      `${CONFIRM_WINDOW_MS} ms, so the number below comes from run (b) — the built app, ` +
      "Chromium's fake capture device, a fresh browser context per repeat so the 10 s " +
      "cooldown is not what gets timed, and the clock running from the first frame the " +
      "`<video>` can supply to the hash change only the `confirmed` transition performs.",
  );
  out.push("");
  out.push("| | |");
  out.push("|---|---|");
  out.push(`| Taken by | \`${record.command}\` |`);
  out.push(
    `| Build measured | \`${shortSha(record.provenance.commit)}\`` +
      `${record.provenance.dirty === true ? " — **from a dirty tree, so the commit does not identify what was measured**" : ""} |`,
  );
  out.push(
    `| Scene | VIN \`${record.config.vin}\`, ${record.config.frames} distinct degraded poses ` +
      `at ${record.config.fps} fps, ${record.config.width}x${record.config.height}, ` +
      `${record.config.repeats} contexts per cell, giving up at ${record.config.timeoutMs} ms |`,
  );
  out.push(
    `| Machine | ${record.machine.cpus} cores, load ` +
      `${record.machine.loadavg.map((n) => n.toFixed(1)).join(" / ")} at recording — ` +
      "milliseconds here are wall clock on a shared box, and only the comparison between " +
      "cells is load-free |",
  );
  out.push(
    `| Still current? | ${
      since === null
        ? "git could not say whether `src/` has moved since — re-take it if in doubt"
        : since === 0
          ? "no commit has touched `src/` since that build"
          : `**${since} commit${since === 1 ? " has" : "s have"} touched \`src/\` since that ` +
            "build — re-take it (`bun run build`, then `" +
            record.command +
            "`) before quoting it**"
    } |`,
  );
  out.push("");
  out.push("| Symbology | Tier | Confirmed | Mean ms | Min ms | Max ms | Harness faults |");
  out.push("|---|---|---:|---:|---:|---:|---:|");
  for (const c of record.cells) {
    out.push(
      `| ${c.symbology} | ${c.tier} | ${c.confirmed}/${c.measured} | ` +
        `${c.meanMs === null ? "-" : c.meanMs.toFixed(0)} | ${c.minMs ?? "-"} | ` +
        `${c.maxMs ?? "-"} | ${c.faults} |`,
    );
  }
  out.push("");
  out.push(
    `**Overall: ${record.overall.confirmed} of ${record.overall.measured} confirmed, mean ` +
      `${record.overall.meanMs === null ? "-" : `${record.overall.meanMs.toFixed(0)} ms`}.** ` +
      `${record.overall.faults === 0 ? "No harness faults" : `${record.overall.faults} harness faults excluded from every mean`}` +
      `${record.overall.notConfirmed === 0 ? "" : `, ${record.overall.notConfirmed} repeats never confirmed inside ${record.config.timeoutMs} ms`}` +
      ".",
  );
  out.push("");
  // Derived rather than asserted, twice over: both the spread and the window comparison are
  // facts about *this* recording, and a sentence written down here would go stale the next
  // time it is taken (SB-11).
  const spread = [...record.cells]
    .filter((c) => c.minMs !== null && c.maxMs !== null && c.minMs > 0)
    .sort((a, b) => (b.maxMs ?? 0) / (b.minMs ?? 1) - (a.maxMs ?? 0) / (a.minMs ?? 1))[0];
  if (spread !== undefined && spread.minMs !== null && spread.maxMs !== null) {
    out.push(
      `**A mean here is a tail statistic.** The widest cell in this recording is ` +
        `\`${spread.symbology}\` ${spread.tier}, ${spread.minMs}-${spread.maxMs} ms over ` +
        `${spread.measured} repeats — a ${(spread.maxMs / spread.minMs).toFixed(1)}x spread ` +
        "on one scene at one build. Confirmation needs *two* decodable poses inside one " +
        "window, so on a hard label it waits for a coincidence, and the mean is set by how " +
        "long that takes. Read these as orders of magnitude; a 20% move between recordings " +
        "is noise, the same way a 5 pp move in a severe decode cell is (SB-7).",
    );
    out.push("");
  }
  out.push(verdict);
  out.push("");
  out.push(
    "A y4m loop is not a hand (§13.7): fixed frame rate, repeating poses, nobody moving the " +
      "phone toward the label. This bounds the confirmation logic; it does not close §7 item 4.",
  );
  out.push("");
  return out;
}
