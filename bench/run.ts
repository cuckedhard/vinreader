/**
 * §13.4 scan-robustness bench — runner. `bun run bench`.
 *
 * Builds the §13.4 corpus, degrades every image at every tier, decodes each one with the
 * app's §4.6 ZXing configuration, and pushes the decoded text through the app's own §4.2
 * `extractVin`. The measurement is therefore of the pipeline the product ships, not of a
 * decoder in isolation: a frame that decodes to text §4.2 then throws away is a miss, and a
 * frame that decodes to text §4.2 turns into the *wrong* VIN is a false accept.
 *
 * False accepts are the headline. §13.6 requires zero across the whole corpus and §13.3
 * grades a wrong VIN accepted as an S1 blocker, so every one is printed with everything
 * needed to reproduce it.
 *
 * Determinism: the corpus is fixed by `corpus.ts`'s own seed, and each attempt's degradation
 * seed is a pure hash of `(runSeed, vin, symbology, tier)` — so the same command produces the
 * same images, the same decodes and the same verdict, on any machine, in any order the
 * worker pool happens to schedule. Results are written back by job index, so even the report
 * ordering is scheduling-independent. The one thing that does move between runs is wall-clock
 * decode time, which is reported but is not a threshold.
 *
 * Synthetic is not real (§13.4, §13.7): this tunes hints, ROI and confirmation logic. It does
 * not close §7 item 4.
 */

import type { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isPayloadCarrier } from "../src/lib/payload/carrier";
import { extractVin } from "../src/lib/vin/extractVin";
import { BENCH_SYMBOLOGIES, buildCorpus } from "./corpus";
import type { BenchSymbology, CorpusItem } from "./corpus";
import { BENCH_FORMAT_NAMES, decodeImage, suppressedWarnings } from "./decode";
import { TIERS, degrade } from "./degrade";
import type { Tier } from "./degrade";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** §13.4: "200 synthetic grammar-valid VINs" plus the §4.11 fixtures. */
const DEFAULT_COUNT = 200;

/** `--quick`: enough VINs to hit every symbology and both fixture shapes, in seconds. */
const QUICK_COUNT = 8;

/** Fixed run seed. Every degradation seed derives from it, so the whole run hangs off it. */
const DEFAULT_SEED = 0x5eed_1a7c;

/** §13.6 exit criteria, per symbology, per tier. */
const THRESHOLDS: Readonly<Record<Tier, number>> = {
  clean: 0.99,
  moderate: 0.9,
  severe: 0.7,
};

/** §13.6: zero, across the whole corpus. Not a rate — a count. */
const FALSE_ACCEPT_THRESHOLD = 0;

/** Bounded so a full 3000-attempt run does not hold thousands of degraded frames at once. */
const CONCURRENCY = 8;

const REPORT_PATH = fileURLToPath(new URL("report.md", import.meta.url));
/**
 * A --quick run writes here instead. bench/report.md is the §13.6 criterion-4 evidence over
 * the full §13.4 corpus, and a 120-attempt loop silently replacing it has now happened three
 * times — round-1 review finding N-01 and again as R2-02. Separate paths make it impossible.
 */
const QUICK_REPORT_PATH = fileURLToPath(new URL("report.quick.md", import.meta.url));

// ---------------------------------------------------------------------------
// Attempts
// ---------------------------------------------------------------------------

type Verdict = "hit" | "miss" | "false_accept" | "error";

/**
 * Why a miss was a miss. `no_decode` is the decoder finding nothing; `no_vin` is §4.2
 * refusing to name a VIN in text that did decode; `carrier` is a §4.9 handoff payload, which
 * §6.3 routes away from `extractVin` entirely and which therefore is not a scan result at all.
 */
type MissReason = "no_decode" | "no_vin" | "carrier";

interface Attempt {
  vin: string;
  symbology: BenchSymbology;
  tier: Tier;
  /** The exact seed handed to `degrade`, so a single row can be reproduced on its own. */
  seed: number;
  verdict: Verdict;
  missReason: MissReason | null;
  /** Raw decoder output, or null when nothing decoded. */
  decoded: string | null;
  /** ZXing's format name — `code_39_i` decodes as `CODE_39`. */
  format: string | null;
  /** What §4.2 returned, when it returned anything. */
  extracted: string | null;
  checkDigitValid: boolean | null;
  ms: number;
  error: string | null;
}

/**
 * One image: degrade, decode, extract, classify.
 *
 * `code_39_i` encodes `I` + VIN (the ANSI MH10.8.2 data identifier). Ground truth stays the
 * bare VIN, and §4.2 treats the `I` as a separator because `I` is not in the §4.1 alphabet,
 * so a correct read of that row lands on `hit` with no special case here — which is exactly
 * the §4.2 behaviour this row exists to prove.
 */
async function runAttempt(
  png: Buffer,
  vin: string,
  symbology: BenchSymbology,
  tier: Tier,
  seed: number,
): Promise<Attempt> {
  const base: Omit<Attempt, "verdict" | "missReason"> = {
    vin,
    symbology,
    tier,
    seed,
    decoded: null,
    format: null,
    extracted: null,
    checkDigitValid: null,
    ms: 0,
    error: null,
  };

  let decoded;
  try {
    decoded = await decodeImage(await degrade(png, tier, seed));
  } catch (error) {
    // A fault is neither a hit nor an honest miss: it means the bench could not measure this
    // frame at all. It is surfaced rather than folded into the miss count.
    return {
      ...base,
      verdict: "error",
      missReason: null,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }

  const withTiming = { ...base, ms: decoded.ms, decoded: decoded.text, format: decoded.format };

  if (decoded.text === null) {
    return { ...withTiming, verdict: "miss", missReason: "no_decode" };
  }
  // §6.3 tests the §4.9 carrier first and never extracts one. Nothing in this corpus is a
  // carrier, so this branch firing at all would itself be a finding.
  if (isPayloadCarrier(decoded.text)) {
    return { ...withTiming, verdict: "miss", missReason: "carrier" };
  }

  const extracted = extractVin(decoded.text);
  if (extracted === null) {
    return { ...withTiming, verdict: "miss", missReason: "no_vin" };
  }

  return {
    ...withTiming,
    verdict: extracted.vin === vin ? "hit" : "false_accept",
    missReason: null,
    extracted: extracted.vin,
    checkDigitValid: extracted.checkDigitValid,
  };
}

/**
 * Per-attempt degradation seed. Keyed by the attempt's identity so that every image in the
 * corpus gets its own rotation, warp, glare and grain — one shared seed would measure a
 * single pose 1000 times — while staying a pure function of the run seed.
 */
function attemptSeed(runSeed: number, vin: string, symbology: BenchSymbology, tier: Tier): number {
  return (runSeed ^ fnv1a(`${vin}|${symbology}|${tier}`)) >>> 0;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

interface Job {
  item: CorpusItem;
  tier: Tier;
}

/** Fixed-size worker pool. Results land at their job index, so output order is stable. */
async function runAll(jobs: readonly Job[], runSeed: number): Promise<Attempt[]> {
  const attempts = new Array<Attempt>(jobs.length);
  let next = 0;
  let done = 0;
  const step = Math.max(1, Math.floor(jobs.length / 20));

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= jobs.length) return;
      const { item, tier } = jobs[index];
      const seed = attemptSeed(runSeed, item.vin, item.symbology, tier);
      attempts[index] = await runAttempt(item.png, item.vin, item.symbology, tier, seed);
      done += 1;
      if (done % step === 0 || done === jobs.length) {
        process.stderr.write(`bench: decoded ${done}/${jobs.length}\n`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, () => worker()));
  return attempts;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface Cell {
  symbology: BenchSymbology;
  tier: Tier;
  attempts: number;
  hits: number;
  misses: number;
  falseAccepts: number;
  errors: number;
  /** Hits over attempts: the fraction of frames that produced the *right* VIN end to end. */
  decodeRate: number;
  threshold: number;
  pass: boolean;
  missReasons: Record<MissReason, number>;
}

interface Timing {
  scope: string;
  decodes: number;
  meanMs: number;
  p95Ms: number;
}

function summarise(
  attempts: readonly Attempt[],
  symbologies: readonly BenchSymbology[],
  tiers: readonly Tier[],
): Cell[] {
  const cells: Cell[] = [];
  for (const symbology of symbologies) {
    for (const tier of tiers) {
      const rows = attempts.filter((a) => a.symbology === symbology && a.tier === tier);
      const hits = rows.filter((a) => a.verdict === "hit").length;
      const misses = rows.filter((a) => a.verdict === "miss");
      const falseAccepts = rows.filter((a) => a.verdict === "false_accept").length;
      const errors = rows.filter((a) => a.verdict === "error").length;
      const decodeRate = rows.length === 0 ? 0 : hits / rows.length;
      const threshold = THRESHOLDS[tier];
      cells.push({
        symbology,
        tier,
        attempts: rows.length,
        hits,
        misses: misses.length,
        falseAccepts,
        errors,
        decodeRate,
        threshold,
        pass: rows.length > 0 && decodeRate >= threshold,
        missReasons: {
          no_decode: misses.filter((a) => a.missReason === "no_decode").length,
          no_vin: misses.filter((a) => a.missReason === "no_vin").length,
          carrier: misses.filter((a) => a.missReason === "carrier").length,
        },
      });
    }
  }
  return cells;
}

/**
 * Mean and p95 over attempts that actually reached the decoder. p95 is the nearest-rank
 * value of the sorted sample, which needs no interpolation and so cannot drift with array
 * length.
 */
function timing(scope: string, attempts: readonly Attempt[]): Timing {
  const samples = attempts.filter((a) => a.verdict !== "error").map((a) => a.ms);
  if (samples.length === 0) return { scope, decodes: 0, meanMs: 0, p95Ms: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, ms) => sum + ms, 0);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
  return { scope, decodes: sorted.length, meanMs: total / sorted.length, p95Ms: sorted[rank] };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface Options {
  count: number;
  tiers: Tier[];
  symbologies: BenchSymbology[];
  json: string | null;
  quick: boolean;
  seed: number;
}

const USAGE = `bun run bench [options]

  --count N            VINs in the corpus (default ${DEFAULT_COUNT}, ${QUICK_COUNT} with --quick)
  --quick              fast loop: fewer VINs, all tiers, all symbologies
  --tiers a,b          subset of ${TIERS.join(",")}
  --symbologies a,b    subset of ${BENCH_SYMBOLOGIES.join(",")}
  --seed N             run seed (default 0x${DEFAULT_SEED.toString(16)})
  --json PATH          also write the raw numbers as JSON
  --help               this text
`;

class UsageError extends Error {}

function parseList<T extends string>(raw: string, allowed: readonly T[], flag: string): T[] {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) throw new UsageError(`${flag}: expected a comma-separated list`);
  const chosen: T[] = [];
  for (const part of parts) {
    const match = allowed.find((value) => value === part);
    if (match === undefined) {
      throw new UsageError(`${flag}: unknown value ${JSON.stringify(part)}`);
    }
    if (!chosen.includes(match)) chosen.push(match);
  }
  // Canonical order, never the order the flag happened to list, so two spellings of the same
  // selection produce the same report.
  return allowed.filter((value) => chosen.includes(value));
}

function parseCount(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`${flag}: expected a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function parseSeed(raw: string): number {
  const value =
    raw.startsWith("0x") || raw.startsWith("0X") ? Number.parseInt(raw, 16) : Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new UsageError(`--seed: expected a uint32, got ${JSON.stringify(raw)}`);
  }
  return value >>> 0;
}

/** Hand-rolled: the bench must not grow a dependency to read five flags. */
function parseArgs(argv: readonly string[]): Options | null {
  let count: number | null = null;
  let tiers: Tier[] = [...TIERS];
  let symbologies: BenchSymbology[] = [...BENCH_SYMBOLOGIES];
  let json: string | null = null;
  let quick = false;
  let seed = DEFAULT_SEED;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const value = (): string => {
      if (inline !== null) return inline;
      i += 1;
      if (i >= argv.length) throw new UsageError(`${flag}: expected a value`);
      return argv[i];
    };

    switch (flag) {
      case "--help":
      case "-h":
        return null;
      case "--quick":
        quick = true;
        break;
      case "--count":
        count = parseCount(value(), "--count");
        break;
      case "--tiers":
        tiers = parseList(value(), TIERS, "--tiers");
        break;
      case "--symbologies":
        symbologies = parseList(value(), BENCH_SYMBOLOGIES, "--symbologies");
        break;
      case "--seed":
        seed = parseSeed(value());
        break;
      case "--json":
        json = value();
        break;
      default:
        throw new UsageError(`unknown flag ${JSON.stringify(arg)}`);
    }
  }

  // An explicit --count always wins, whichever side of --quick it was written on.
  return {
    count: count ?? (quick ? QUICK_COUNT : DEFAULT_COUNT),
    tiers,
    symbologies,
    json,
    quick,
    seed,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function margin(cell: Cell): string {
  const points = (cell.decodeRate - cell.threshold) * 100;
  return `${points >= 0 ? "+" : ""}${points.toFixed(1)} pp`;
}

function ms(value: number): string {
  return value.toFixed(1);
}

function reproduce(attempt: Attempt): string {
  return (
    `degrade(await renderBarcode("${attempt.vin}", "${attempt.symbology}"), ` +
    `"${attempt.tier}", 0x${attempt.seed.toString(16)})`
  );
}

function markdownReport(
  options: Options,
  cells: readonly Cell[],
  timings: readonly Timing[],
  attempts: readonly Attempt[],
  vinCount: number,
  failures: readonly string[],
): string {
  const falseAccepts = attempts.filter((a) => a.verdict === "false_accept");
  const errors = attempts.filter((a) => a.verdict === "error");
  const out: string[] = [];

  out.push("# §13.4 scan-robustness bench");
  out.push("");
  out.push(
    failures.length === 0
      ? "**PASS** — every §13.6 threshold met, zero false accepts."
      : `**FAIL** — ${failures.length} §13.6 threshold${failures.length === 1 ? "" : "s"} missed.`,
  );
  out.push("");
  out.push("## Run");
  out.push("");
  out.push("| | |");
  out.push("|---|---|");
  out.push(`| Run seed | \`0x${options.seed.toString(16)}\` |`);
  out.push(`| VINs | ${vinCount} (${options.quick ? "--quick" : "full"}) |`);
  out.push(`| Symbologies | ${options.symbologies.join(", ")} |`);
  out.push(`| Tiers | ${options.tiers.join(", ")} |`);
  out.push(`| Attempts | ${attempts.length} |`);
  out.push(`| Decoder hints (§4.6) | ${BENCH_FORMAT_NAMES.join(", ")}; TRY_HARDER |`);
  out.push(`| ZXing per-reader warnings swallowed | ${suppressedWarnings()} |`);
  out.push("");
  out.push(
    'Every degradation seed is `runSeed ^ fnv1a("vin|symbology|tier")`, so this run ' +
      "reproduces exactly, and any single row below reproduces on its own.",
  );
  out.push("");

  out.push("## Headline: false accepts (§13.6 requires 0)");
  out.push("");
  if (falseAccepts.length === 0) {
    out.push(
      `**0 false accepts** in ${attempts.length} attempts. Threshold ${FALSE_ACCEPT_THRESHOLD}.`,
    );
  } else {
    out.push(
      `**${falseAccepts.length} FALSE ACCEPTS** in ${attempts.length} attempts ` +
        `(threshold ${FALSE_ACCEPT_THRESHOLD}). A wrong VIN accepted is an S1 blocker (§13.3).`,
    );
    out.push("");
    out.push(
      "| Expected VIN | Returned VIN | Symbology | Tier | ZXing format | Check digit | Decoded text | Seed |",
    );
    out.push("|---|---|---|---|---|---|---|---|");
    for (const a of falseAccepts) {
      out.push(
        `| \`${a.vin}\` | \`${a.extracted ?? ""}\` | ${a.symbology} | ${a.tier} | ` +
          `${a.format ?? ""} | ${a.checkDigitValid === true ? "valid" : "invalid"} | ` +
          `\`${(a.decoded ?? "").replace(/\|/g, "\\|")}\` | \`0x${a.seed.toString(16)}\` |`,
      );
    }
    out.push("");
    out.push("Reproduce:");
    out.push("");
    out.push("```ts");
    for (const a of falseAccepts) out.push(reproduce(a));
    out.push("```");
  }
  out.push("");

  out.push("## Decode rate per symbology × tier");
  out.push("");
  out.push(
    `| Symbology | ${options.tiers.map((t) => `${t} (>= ${pct(THRESHOLDS[t])})`).join(" | ")} |`,
  );
  out.push(`|---|${options.tiers.map(() => "---").join("|")}|`);
  for (const symbology of options.symbologies) {
    const row = options.tiers.map((tier) => {
      const cell = cells.find((c) => c.symbology === symbology && c.tier === tier);
      if (cell === undefined) return "-";
      return `${pct(cell.decodeRate)} ${cell.pass ? "PASS" : "FAIL"}`;
    });
    out.push(`| ${symbology} | ${row.join(" | ")} |`);
  }
  out.push("");
  out.push("Decode rate is end to end: the fraction of frames that produced the **correct** VIN");
  out.push("through ZXing and §4.2 `extractVin`, not the fraction that merely decoded.");
  out.push("");

  out.push("### Detail");
  out.push("");
  out.push(
    "| Symbology | Tier | Attempts | Hits | Misses | Errors | False accepts | Rate | Threshold | Margin | Status |",
  );
  out.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const c of cells) {
    out.push(
      `| ${c.symbology} | ${c.tier} | ${c.attempts} | ${c.hits} | ${c.misses} | ${c.errors} | ` +
        `${c.falseAccepts} | ${pct(c.decodeRate)} | ${pct(c.threshold)} | ${margin(c)} | ` +
        `${c.pass ? "PASS" : "FAIL"} |`,
    );
  }
  out.push("");

  out.push("### Why the misses missed");
  out.push("");
  out.push("| Symbology | Tier | no_decode | no_vin | carrier |");
  out.push("|---|---|---:|---:|---:|");
  for (const c of cells) {
    out.push(
      `| ${c.symbology} | ${c.tier} | ${c.missReasons.no_decode} | ${c.missReasons.no_vin} | ` +
        `${c.missReasons.carrier} |`,
    );
  }
  out.push("");
  out.push(
    "`no_decode` — ZXing found no symbol. `no_vin` — text decoded but §4.2 named no VIN. " +
      "`carrier` — a §4.9 handoff payload, which §6.3 never extracts; nothing in this corpus " +
      "is one, so any non-zero value here is itself a finding.",
  );
  out.push("");

  out.push("## Decode time");
  out.push("");
  out.push("| Scope | Decodes | Mean ms | p95 ms |");
  out.push("|---|---:|---:|---:|");
  for (const t of timings) {
    out.push(`| ${t.scope} | ${t.decodes} | ${ms(t.meanMs)} | ${ms(t.p95Ms)} |`);
  }
  out.push("");
  out.push(
    "Times cover the ZXing pipeline only — luminance packing, binarisation and the read — " +
      "because the app hands ZXing canvas pixels and never parses a PNG. Timings are the one " +
      "part of this report that is not bit-reproducible; no threshold rides on them.",
  );
  out.push("");

  if (errors.length > 0) {
    out.push("## Decoder faults");
    out.push("");
    out.push("| VIN | Symbology | Tier | Seed | Error |");
    out.push("|---|---|---|---|---|");
    for (const a of errors) {
      out.push(
        `| \`${a.vin}\` | ${a.symbology} | ${a.tier} | \`0x${a.seed.toString(16)}\` | ` +
          `${(a.error ?? "").replace(/\|/g, "\\|")} |`,
      );
    }
    out.push("");
  }

  out.push("## §13.6 verdict");
  out.push("");
  if (failures.length === 0) {
    out.push("All thresholds met.");
  } else {
    for (const failure of failures) out.push(`- ${failure}`);
  }
  out.push("");
  out.push(
    "Synthetic is not real (§13.4, §13.7). This bench tunes hints, ROI cropping and " +
      "confirmation logic; real door-jamb labels on real trucks stay §7 item 4, and stay human.",
  );
  out.push("");
  return out.join("\n");
}

function jsonReport(
  options: Options,
  cells: readonly Cell[],
  timings: readonly Timing[],
  attempts: readonly Attempt[],
  vinCount: number,
  failures: readonly string[],
): string {
  const falseAccepts = attempts.filter((a) => a.verdict === "false_accept");
  const errors = attempts.filter((a) => a.verdict === "error");
  return `${JSON.stringify(
    {
      spec: "§13.4 scan-robustness bench",
      config: {
        seed: options.seed,
        seedHex: `0x${options.seed.toString(16)}`,
        count: options.count,
        vins: vinCount,
        quick: options.quick,
        tiers: options.tiers,
        symbologies: options.symbologies,
        concurrency: CONCURRENCY,
        hints: { possibleFormats: BENCH_FORMAT_NAMES, tryHarder: true },
        suppressedZxingWarnings: suppressedWarnings(),
      },
      thresholds: { decodeRate: THRESHOLDS, falseAccepts: FALSE_ACCEPT_THRESHOLD },
      totals: {
        attempts: attempts.length,
        hits: attempts.filter((a) => a.verdict === "hit").length,
        misses: attempts.filter((a) => a.verdict === "miss").length,
        falseAccepts: falseAccepts.length,
        errors: errors.length,
      },
      cells,
      timings,
      falseAccepts,
      errors,
      pass: failures.length === 0,
      failures,
    },
    null,
    2,
  )}\n`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function checkThresholds(cells: readonly Cell[], attempts: readonly Attempt[]): string[] {
  const failures: string[] = [];

  const falseAccepts = attempts.filter((a) => a.verdict === "false_accept");
  if (falseAccepts.length > FALSE_ACCEPT_THRESHOLD) {
    failures.push(
      `false accepts: ${falseAccepts.length} (§13.6 requires ${FALSE_ACCEPT_THRESHOLD}) — ` +
        falseAccepts.map((a) => `${a.symbology}/${a.tier} ${a.vin} -> ${a.extracted}`).join("; "),
    );
  }

  for (const cell of cells) {
    if (cell.attempts === 0) {
      failures.push(`${cell.symbology} ${cell.tier}: no attempts`);
    } else if (!cell.pass) {
      failures.push(
        `${cell.symbology} ${cell.tier}: ${pct(cell.decodeRate)} < ${pct(cell.threshold)} ` +
          `(${cell.hits}/${cell.attempts} correct, ${margin(cell)})`,
      );
    }
  }

  const errors = attempts.filter((a) => a.verdict === "error");
  if (errors.length > 0) {
    failures.push(`decoder faults: ${errors.length} (see the report)`);
  }

  return failures;
}

async function main(): Promise<number> {
  let options: Options | null;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  if (options === null) {
    process.stdout.write(USAGE);
    return 0;
  }

  process.stderr.write(
    `bench: seed 0x${options.seed.toString(16)}, ${options.count} VINs, ` +
      `${options.symbologies.length} symbologies, ${options.tiers.length} tiers\n`,
  );

  const corpus = await buildCorpus(options.count);
  const items = corpus.filter((item) => options.symbologies.includes(item.symbology));
  const vinCount = new Set(items.map((item) => item.vin)).size;

  const jobs: Job[] = [];
  for (const item of items) {
    for (const tier of options.tiers) jobs.push({ item, tier });
  }
  if (jobs.length === 0) {
    process.stderr.write("bench: nothing to run\n");
    return 2;
  }

  const attempts = await runAll(jobs, options.seed);
  const cells = summarise(attempts, options.symbologies, options.tiers);
  const timings: Timing[] = [
    timing("all", attempts),
    ...options.tiers.map((tier) =>
      timing(
        tier,
        attempts.filter((a) => a.tier === tier),
      ),
    ),
  ];
  const failures = checkThresholds(cells, attempts);

  await writeFile(
    options.quick ? QUICK_REPORT_PATH : REPORT_PATH,
    markdownReport(options, cells, timings, attempts, vinCount, failures),
    "utf8",
  );
  if (options.json !== null) {
    await writeFile(
      resolve(process.cwd(), options.json),
      jsonReport(options, cells, timings, attempts, vinCount, failures),
      "utf8",
    );
  }

  // stdout: the summary a human reads, thresholds printed beside the measurements.
  const lines: string[] = [];
  lines.push("");
  lines.push("§13.4 scan-robustness bench");
  lines.push(
    `  seed 0x${options.seed.toString(16)} · ${vinCount} VINs · ` +
      `${options.symbologies.length} symbologies · ${options.tiers.length} tiers · ` +
      `${attempts.length} attempts`,
  );
  lines.push("");
  const width = Math.max(...options.symbologies.map((s) => s.length));
  lines.push(
    `  ${"symbology".padEnd(width)}  ` +
      options.tiers.map((t) => `${t} (>=${pct(THRESHOLDS[t])})`.padEnd(22)).join(""),
  );
  for (const symbology of options.symbologies) {
    const row = options.tiers.map((tier) => {
      const cell = cells.find((c) => c.symbology === symbology && c.tier === tier);
      if (cell === undefined) return "-".padEnd(22);
      return `${pct(cell.decodeRate)} ${cell.pass ? "PASS" : "FAIL"} ${margin(cell)}`.padEnd(22);
    });
    lines.push(`  ${symbology.padEnd(width)}  ${row.join("")}`);
  }
  lines.push("");
  const falseAccepts = attempts.filter((a) => a.verdict === "false_accept");
  lines.push(
    `  false accepts: ${falseAccepts.length} (threshold ${FALSE_ACCEPT_THRESHOLD}) ` +
      `${falseAccepts.length === 0 ? "OK" : "BLOCKER (§13.3 S1)"}`,
  );
  for (const a of falseAccepts) {
    lines.push(`    ${a.symbology}/${a.tier}: expected ${a.vin}, got ${a.extracted}`);
    lines.push(`      decoded ${JSON.stringify(a.decoded)} as ${a.format}`);
    lines.push(`      ${reproduce(a)}`);
  }
  const all = timings[0];
  lines.push(`  decode time: mean ${ms(all.meanMs)} ms, p95 ${ms(all.p95Ms)} ms`);
  lines.push(`  report: ${options.quick ? QUICK_REPORT_PATH : REPORT_PATH}`);
  if (options.json !== null) lines.push(`  json:   ${resolve(process.cwd(), options.json)}`);
  lines.push("");
  if (failures.length === 0) {
    lines.push("  PASS — every §13.6 threshold met.");
  } else {
    lines.push(
      `  FAIL — ${failures.length} §13.6 threshold${failures.length === 1 ? "" : "s"} missed:`,
    );
    for (const failure of failures) lines.push(`    - ${failure}`);
  }
  lines.push("");
  process.stdout.write(`${lines.join("\n")}\n`);

  return failures.length === 0 ? 0 : 1;
}

process.exitCode = await main();
