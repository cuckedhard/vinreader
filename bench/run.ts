/**
 * §13.4 scan-robustness bench — runner. `bun run bench`.
 *
 * Builds the §13.4 corpus, degrades every image at every tier, decodes each one **in
 * Chromium through the app's own `BrowserMultiFormatReader`**, and pushes the decoded text
 * through the app's own §4.2 `extractVin`. The measurement is therefore of the pipeline the
 * product ships, not of a decoder in isolation: a frame that decodes to text §4.2 then throws
 * away is a miss, and a frame that decodes to text §4.2 turns into the *wrong* VIN is a false
 * accept.
 *
 * Every frame is degraded once and offered to each selected decode path (§13.4 / B2), so the
 * report's delta table compares instruments on identical pixels rather than on two runs that
 * merely used the same seed. `canvas` is the app's; `rgb` is the node `RGBLuminanceSource`
 * control this bench used to report as if it were the app; `yuv` bounds what a real camera
 * frame's colour conversion would cost.
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
import { BENCH_SYMBOLOGIES, buildCorpus, renderBarcode } from "./corpus";
import type { BenchSymbology, CorpusItem } from "./corpus";
import { openBrowserDecoder } from "./browser-decode";
import type { BrowserDecoder } from "./browser-decode";
import {
  BENCH_FORMAT_NAMES,
  BENCH_HINT_NAMES,
  DECODE_PATHS,
  DECODE_PATH_NOTES,
  decodeImage,
  suppressedWarnings,
} from "./decode";
import type { DecodeOutcome, DecodePath } from "./decode";
import { SEVERE_EXTRAS, SEVERE_EXTRAS_DRAWN, TIERS, degrade, severeExtrasFor } from "./degrade";
import type { SevereExtra, Tier } from "./degrade";
import { FRAME_HEIGHT, FRAME_WIDTH, composite } from "./frame";

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

/**
 * Frames degraded and held at once. The chunk is degraded, then handed to every selected
 * path in turn, then dropped — so a frame is warped exactly once however many instruments
 * read it, and memory stays flat at roughly `CHUNK` PNGs rather than the whole corpus.
 */
const CHUNK = 96;

/**
 * Pages in the browser pool. ZXing decodes synchronously on a page's only thread, so extra
 * pages are the only way to use a second core; past two the gain flattens, because sharp's
 * degradation threads want the same cores. Measured on 420 frames, `canvas` alone, on a
 * four-core machine that was also running `bun run mutate`: 1 page 38 s, 2 pages 29 s,
 * 4 pages 28 s end to end. Four is kept because it costs nothing and an idle machine has
 * more headroom than the one this was measured on. It cannot change a decode — only when
 * one happens.
 */
const DEFAULT_BROWSER_PAGES = 4;

/**
 * Paths a run measures unless `--paths` says otherwise. The first is the report's verdict.
 *
 * All three by default, and the cost is deliberate. `rgb` is the instrument every round
 * before this one reported as if it were the app (B2), so the delta against it is the only
 * thing that says how large that error was. `yuv` is the control that proves the delta table
 * can see a difference at all: it is the one path that reliably moves a handful of severe
 * frames, so an all-zero `rgb` column can be read as a result rather than as a harness that
 * forgot to switch instruments. A full three-path run is about nine minutes.
 */
const DEFAULT_PATHS: readonly DecodePath[] = ["canvas", "yuv", "rgb"];

/** The one path that is the app. A report whose verdict came from anything else is a diagnostic. */
const APP_PATH: DecodePath = "canvas";

/**
 * What the decoder is handed: the degraded symbol alone, or that symbol composited unscaled
 * onto the `FRAME_WIDTH` x `FRAME_HEIGHT` field the app's decoder actually reads (SB-2).
 */
type Layout = "crop" | "frame";

const LAYOUTS: readonly Layout[] = ["crop", "frame"];

/**
 * The app's layout, and therefore the canonical one (SB-2).
 *
 * Until this round the bench handed ZXing a ~1050 px symbol in a ~1100 px image: quiet zone
 * and nothing else. The app hands it a whole video frame. `useScanner` calls
 * `decodeFromStream`; `@zxing/browser` draws the entire `<video>` onto its capture canvas at
 * `videoWidth` x `videoHeight`, which under §6.3's `ideal` constraints is 1920x1080 — the
 * symbol is a band across a mostly empty field, and the decoder has to find it there.
 *
 * Measured on identical symbol pixels, that field costs up to 35 pp (code_128 severe
 * 62.5% -> 27.5%) and 2.8x the decode time. So every §13.6 margin this bench has ever
 * reported was measured on an easier problem than the product solves, in the optimistic
 * direction. `crop` is kept as a diagnostic — it is the only way to reproduce the old
 * numbers, and the only way to attribute a future change to the frame rather than to the
 * symbol — and a run using it never writes the tracked artifacts.
 *
 * This changes what the bench MEASURES. It does not touch a §13.4 tier definition or a §4.6
 * constant: the degradations, their order and their parameters are exactly what they were,
 * applied to exactly the same pixels, and the symbol is never resampled.
 */
const CANONICAL_LAYOUT: Layout = "frame";

const LAYOUT_NOTES: Readonly<Record<Layout, string>> = {
  crop: "the degraded symbol alone, ~1100 px wide — NOT what the app decodes (SB-2)",
  frame:
    `the symbol composited unscaled and centred on a white ${FRAME_WIDTH}x${FRAME_HEIGHT} ` +
    "field — what `@zxing/browser` draws from the `<video>` (SB-2)",
};

/** Which paths need Chromium. `rgb` is the only one that does not. */
function isBrowserPath(path: DecodePath): boolean {
  return path !== "rgb";
}

const REPORT_PATH = fileURLToPath(new URL("report.md", import.meta.url));
/**
 * A --quick run writes here instead. bench/report.md is the §13.6 criterion-4 evidence over
 * the full §13.4 corpus, and a 120-attempt loop silently replacing it has now happened three
 * times — round-1 review finding N-01 and again as R2-02. Separate paths make it impossible.
 */
const QUICK_REPORT_PATH = fileURLToPath(new URL("report.quick.md", import.meta.url));
/** Same split for the JSON: `bench` hardcodes --json, so --quick would otherwise overwrite
 *  the tracked full-corpus artifact through the flag rather than the report path. */
const QUICK_JSON_SUFFIX = ".quick.json";

// ---------------------------------------------------------------------------
// Quoted results (SB-11)
// ---------------------------------------------------------------------------

/**
 * The configuration axes that decide what a decode rate or a false-accept count *means*.
 * Two runs that agree on every one of these measured the same thing; two that do not are
 * not comparable, and a number carried across from one to the other is a number about
 * something else.
 */
interface Fingerprint {
  layout: Layout;
  /** The path the verdict comes from. The others cannot change it (B2). */
  appPath: DecodePath;
  /** VINs per run. */
  count: number;
  tiers: readonly string[];
  symbologies: readonly string[];
  /** §4.6 `POSSIBLE_FORMATS` and the non-format hints, as the run itself names them. */
  formats: readonly string[];
  hints: readonly string[];
  /** `severeDraw`'s own words (Z5). */
  severeDraw: string;
}

/**
 * A result this report **quotes** rather than takes (SB-11).
 *
 * The five-seed sweep below used to be a paragraph of prose in `markdownReport`: true when
 * it was written, printed unchanged by every run afterwards, and structurally unable to
 * become false, because nothing recomputed it and nothing checked that it still described
 * the same bench. That is the same defect class this ledger records at R4-H′, F1-a and
 * TA2 — a claim no run can falsify.
 *
 * So a quote now carries the configuration it was taken under, and every run compares that
 * to its own. A quote whose fingerprint no longer matches is printed as **stale**, with the
 * axes that moved, instead of being printed as a fact. What the check cannot see is stated
 * in the report beside it: a change inside `src/lib`, `bwip-js`, `sharp` or ZXing moves
 * decodes without moving any axis here, and only re-taking the measurement covers that.
 */
interface Quoted {
  /** What was measured, in one line. */
  result: string;
  /** The exact command that re-takes it. */
  command: string;
  /** Where it was taken and by whom, so it can be found again. */
  taken: string;
  config: Fingerprint;
}

interface RecordedSweep extends Quoted {
  seeds: readonly number[];
  attempts: number;
  falseAccepts: number;
  /** The widest per-cell spreads the sweep measured, quoted by `seedNoiseSection`. */
  spreads: readonly { cell: string; low: number; high: number }[];
  /** The next widest cells, as one phrase. */
  alsoWide: string;
  /** What the same sweep measured on the pre-SB-2 crop layout, in percentage points. */
  cropWidest: string;
}

/**
 * The five-seed sweep. 21,000 attempts is 75 minutes of Chromium, which is why it is not
 * taken every round — and exactly why it has to say so where it is read.
 */
const RECORDED_SWEEP: RecordedSweep = {
  result: "0 false accepts in 21,000 attempts",
  command: "bun run bench/run.ts --seed <s> --paths canvas",
  taken:
    "`harden S1` round 2, re-taken after SB-2 moved the bench onto the app's frame; ledger rows SB-1 and SB-7",
  seeds: [0x5eed_1a7c, 0x1111_1111, 0x2bad_5eed, 0x7f3a_c91d, 0xdeca_fbad],
  attempts: 21_000,
  falseAccepts: 0,
  spreads: [
    { cell: "`code_128` moderate", low: 0.75, high: 0.835 },
    { cell: "`qr_code` severe", low: 0.375, high: 0.46 },
  ],
  alsoWide: "`code_128` severe and `data_matrix` severe at 8.0 pp",
  cropWidest: "`code_128` severe at 11.5 pp",
  config: {
    layout: "frame",
    appPath: "canvas",
    count: 200,
    tiers: ["clean", "moderate", "severe"],
    symbologies: [
      "code_39",
      "code_39_i",
      "code_39_check",
      "code_128",
      "code_128_fnc1",
      "data_matrix",
      "qr_code",
    ],
    formats: ["CODE_39", "CODE_128", "DATA_MATRIX", "QR_CODE"],
    hints: ["TRY_HARDER", "ASSUME_GS1"],
    severeDraw: "2 of warp, glare, low_light, jpeg, drawn per frame from the seed",
  },
};

/** This run's own fingerprint, read off the live configuration rather than described. */
function fingerprintOf(options: Options): Fingerprint {
  return {
    layout: options.layout,
    appPath: options.paths[0],
    count: options.count,
    tiers: options.tiers,
    symbologies: options.symbologies,
    formats: BENCH_FORMAT_NAMES,
    hints: BENCH_HINT_NAMES,
    severeDraw: severeDraw(options),
  };
}

/** Every axis on which this run differs from the run a quote was taken on. Empty = comparable. */
function drift(quoted: Fingerprint, options: Options): string[] {
  const live = fingerprintOf(options);
  const out: string[] = [];
  const compare = (label: string, was: string, now: string): void => {
    if (was !== now) out.push(`${label}: recorded \`${was}\`, this run \`${now}\``);
  };
  compare("layout", quoted.layout, live.layout);
  compare("verdict path", quoted.appPath, live.appPath);
  compare("VINs", String(quoted.count), String(live.count));
  compare("tiers", quoted.tiers.join(","), live.tiers.join(","));
  compare("symbologies", quoted.symbologies.join(","), live.symbologies.join(","));
  compare("§4.6 formats", quoted.formats.join(","), live.formats.join(","));
  compare("§4.6 hints", quoted.hints.join(","), live.hints.join(","));
  compare("severe draw (Z5)", quoted.severeDraw, live.severeDraw);
  return out;
}

/**
 * The Code 128 checksum collisions this slice has found. Both are mod-103-valid misreads —
 * Code 128's own check cannot catch either — and both are open with Zach.
 *
 * They are replayed on **every** run, on that run's layout and decode path, because "neither
 * survives the frame" is a claim about the program as it is now and not about the afternoon
 * it was measured (SB-11). Two frames, two decodes: it costs about a second, and it is the
 * part of the quoted sweep that can be recomputed cheaply.
 */
interface KnownCollision {
  /** Ledger row id. */
  id: string;
  vin: string;
  /** The wrong VIN §4.2 named from the misread. */
  wrong: string;
  symbology: BenchSymbology;
  tier: Tier;
  /**
   * The seed of the frame that misread. Fixed, not derived from the run seed: this replays
   * one recorded frame, so `--seed` and `--severe-extras` do not move it.
   */
  seed: number;
}

const KNOWN_COLLISIONS: readonly KnownCollision[] = [
  {
    id: "R4-F",
    vin: "EH8U2YHX60HU8VGWD",
    wrong: "EH8U2YHX60HU7VAWD",
    symbology: "code_128",
    tier: "severe",
    seed: 0xc5d3_691c,
  },
  {
    id: "SB-1",
    vin: "KB7BWYDJ6TW0808Z3",
    wrong: "KB7BWYDJ6TW0874Z3",
    symbology: "code_128_fnc1",
    tier: "severe",
    seed: 0x55f2_df0a,
  },
];

/** One replayed collision, classified by exactly the classifier an attempt gets. */
interface Replay {
  collision: KnownCollision;
  attempt: Attempt;
}

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
  /** Which instrument read this frame. Every path sees the same pixels (B2). */
  path: DecodePath;
  /** The exact seed handed to `degrade`, so a single row can be reproduced on its own. */
  seed: number;
  /** Z5: which severe extras this frame drew, `SEVERE_EXTRAS` order. `null` off the tier. */
  severeExtras: readonly SevereExtra[] | null;
  /** Symbol width over decoded-image width: 1 on `crop`, ~0.3-0.55 on `frame` (SB-2). */
  fill: number;
  verdict: Verdict;
  missReason: MissReason | null;
  /** Raw decoder output, or null when nothing decoded. */
  decoded: string | null;
  /** Whether the §4.6 AIM identifier was stripped from this read — see `DecodeOutcome`. */
  aimStripped: boolean;
  /** ZXing's format name — `code_39_i` decodes as `CODE_39`. */
  format: string | null;
  /** What §4.2 returned, when it returned anything. */
  extracted: string | null;
  checkDigitValid: boolean | null;
  ms: number;
  error: string | null;
}

/** Everything about an attempt that is fixed before a decoder sees it. */
interface FrameIdentity {
  vin: string;
  symbology: BenchSymbology;
  tier: Tier;
  seed: number;
  severeExtras: readonly SevereExtra[] | null;
  /** How much of the decoded image the symbol occupies across, after layout (SB-2). */
  fill: number;
}

/**
 * One decode, classified.
 *
 * `code_39_i` encodes `I` + VIN (the ANSI MH10.8.2 data identifier). Ground truth stays the
 * bare VIN, and §4.2 treats the `I` as a separator because `I` is not in the §4.1 alphabet,
 * so a correct read of that row lands on `hit` with no special case here — which is exactly
 * the §4.2 behaviour this row exists to prove.
 *
 * The order of the tests is `readScanResult`'s own: the §4.6 AIM strip (in the decode path),
 * then the §4.9 carrier — a handoff payload is routed away from `extractVin` entirely —
 * then §4.2. A bench that tested them in another order would be scoring a program the app
 * is not.
 *
 * One step of `readScanResult` is not reproduced: it drops a read whose format
 * `toSymbology` does not name. That cannot fire here — `POSSIBLE_FORMATS` is the §4.6 four
 * and every one of them maps — and the app's own branch is covered by its unit tests, so
 * the bench does not carry a copy of a branch it can never exercise. The function itself
 * cannot be imported: it lives beside a React hook, and the `rgb` path runs in node.
 */
function classify(frame: FrameIdentity, path: DecodePath, outcome: DecodeOutcome): Attempt {
  const base = {
    ...frame,
    path,
    decoded: outcome.text,
    aimStripped: outcome.aimStripped,
    format: outcome.format,
    extracted: null,
    checkDigitValid: null,
    ms: outcome.ms,
    error: outcome.fault,
  };

  // A fault is neither a hit nor an honest miss: it means the bench could not measure this
  // frame at all. It is surfaced rather than folded into the miss count.
  if (outcome.fault !== null) return { ...base, verdict: "error", missReason: null };
  if (outcome.text === null) return { ...base, verdict: "miss", missReason: "no_decode" };
  // §6.3 tests the §4.9 carrier first and never extracts one. Nothing in this corpus is a
  // carrier, so this branch firing at all would itself be a finding.
  if (isPayloadCarrier(outcome.text)) return { ...base, verdict: "miss", missReason: "carrier" };

  const extracted = extractVin(outcome.text);
  if (extracted === null) return { ...base, verdict: "miss", missReason: "no_vin" };

  return {
    ...base,
    verdict: extracted.vin === frame.vin ? "hit" : "false_accept",
    missReason: null,
    extracted: extracted.vin,
    checkDigitValid: extracted.checkDigitValid,
  };
}

/**
 * Per-attempt degradation seed. Keyed by the frame's identity so that every image in the
 * corpus gets its own rotation, warp, glare and grain — one shared seed would measure a
 * single pose 1000 times — while staying a pure function of the run seed.
 *
 * The decode path is deliberately *not* in the key: the whole point of the delta table is
 * that two instruments read the same pixels.
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

/** A degraded frame, or the reason it could not be produced. */
interface Frame {
  identity: FrameIdentity;
  png: Buffer | null;
  error: string | null;
}

/** Degrade one chunk of jobs, with bounded concurrency. Results land at their job index. */
async function degradeChunk(
  jobs: readonly Job[],
  runSeed: number,
  forcedExtras: readonly SevereExtra[] | null,
  layout: Layout,
): Promise<Frame[]> {
  const frames = new Array<Frame>(jobs.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= jobs.length) return;
      const { item, tier } = jobs[index];
      const seed = attemptSeed(runSeed, item.vin, item.symbology, tier);
      // Resolved here rather than inside `degrade` so the report can say what each frame drew.
      const severeExtras = tier === "severe" ? (forcedExtras ?? severeExtrasFor(seed)) : null;
      const identity: FrameIdentity = {
        vin: item.vin,
        symbology: item.symbology,
        tier,
        seed,
        severeExtras,
        fill: 1,
      };
      try {
        const degraded = await degrade(item.png, tier, seed, severeExtras ?? undefined);
        // The frame goes on *after* the degradation and before any instrument reads it, so
        // every path still sees identical pixels (B2) and the symbol is never resampled
        // (SB-2): the bytes inside the symbol's box are the crop layout's bytes.
        if (layout === "crop") {
          frames[index] = { identity, png: degraded, error: null };
        } else {
          const framed = await composite(degraded);
          frames[index] = {
            identity: { ...identity, fill: framed.fill },
            png: framed.png,
            error: null,
          };
        }
      } catch (error) {
        frames[index] = {
          identity,
          png: null,
          error: error instanceof Error ? `degrade ${error.name}: ${error.message}` : String(error),
        };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, () => worker()));
  return frames;
}

/** A frame that never got made is an error on every path, not a miss on any of them. */
const DEGRADE_FAILED = (error: string): DecodeOutcome => ({
  text: null,
  aimStripped: false,
  format: null,
  ms: 0,
  fault: error,
});

/**
 * Decode a chunk with one instrument. `rgb` runs in this process; `canvas` and `yuv` go to
 * the browser pool. Either way the result array lines up with `frames` index for index.
 */
async function decodeChunk(
  frames: readonly Frame[],
  path: DecodePath,
  browser: BrowserDecoder | null,
): Promise<DecodeOutcome[]> {
  const outcomes = new Array<DecodeOutcome>(frames.length);
  const live: number[] = [];
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i];
    if (frame.png === null) outcomes[i] = DEGRADE_FAILED(frame.error ?? "degrade failed");
    else live.push(i);
  }

  if (path === "rgb") {
    // Sequential on purpose: `MultiFormatReader.decode` is synchronous, so a pool would only
    // interleave the timings without decoding anything sooner.
    for (const index of live) {
      outcomes[index] = await decodeImage(frames[index].png as Buffer);
    }
    return outcomes;
  }

  if (browser === null) throw new Error(`bench: ${path} needs a browser and none was opened`);
  const decoded = await browser.decode(
    live.map((index) => frames[index].png as Buffer),
    path,
  );
  for (let i = 0; i < live.length; i += 1) outcomes[live[i]] = decoded[i];
  return outcomes;
}

/**
 * The whole run: degrade a chunk, offer it to every instrument, keep the classifications.
 *
 * Attempt order is chunk-major then path-major then job-major — a pure function of the job
 * list, so the report is scheduling-independent even though the degradation pool and the
 * browser pool both finish out of order internally.
 */
async function runAll(
  jobs: readonly Job[],
  runSeed: number,
  forcedExtras: readonly SevereExtra[] | null,
  paths: readonly DecodePath[],
  browser: BrowserDecoder | null,
  layout: Layout,
): Promise<Attempt[]> {
  const attempts: Attempt[] = [];
  const total = jobs.length * paths.length;
  const step = Math.max(1, Math.floor(total / 20));
  let done = 0;
  let sinceReport = 0;

  for (let start = 0; start < jobs.length; start += CHUNK) {
    const chunk = jobs.slice(start, start + CHUNK);
    const frames = await degradeChunk(chunk, runSeed, forcedExtras, layout);
    for (const path of paths) {
      const outcomes = await decodeChunk(frames, path, browser);
      for (let i = 0; i < frames.length; i += 1) {
        attempts.push(classify(frames[i].identity, path, outcomes[i]));
      }
      done += frames.length;
      sinceReport += frames.length;
      if (sinceReport >= step || done === total) {
        process.stderr.write(`bench: decoded ${done}/${total}\n`);
        sinceReport = 0;
      }
    }
  }
  return attempts;
}

/**
 * Replay every known collision on this run's instrument (SB-11).
 *
 * Same render, same degradation, same layout composite and the same `classify` an ordinary
 * attempt gets — so a reproduced collision is a `false_accept` by the bench's own definition
 * and not by a second one written here.
 *
 * These frames are *not* corpus attempts: their seeds are fixed rather than derived from the
 * run seed, so they are reported beside the §13.6 count and never folded into it. Which
 * frames §13.6 counts is §13.4's list, not the bench's to extend — the same line
 * `orderingViolations` draws.
 */
async function replayCollisions(
  options: Options,
  browser: BrowserDecoder | null,
): Promise<Replay[]> {
  const app = options.paths[0];
  const out: Replay[] = [];
  for (const collision of KNOWN_COLLISIONS) {
    const extras = severeExtrasFor(collision.seed);
    const identity: FrameIdentity = {
      vin: collision.vin,
      symbology: collision.symbology,
      tier: collision.tier,
      seed: collision.seed,
      severeExtras: extras,
      fill: 1,
    };
    let frame: Frame;
    try {
      const png = await renderBarcode(collision.vin, collision.symbology);
      const degraded = await degrade(png, collision.tier, collision.seed, extras);
      if (options.layout === "crop") {
        frame = { identity, png: degraded, error: null };
      } else {
        const framed = await composite(degraded);
        frame = { identity: { ...identity, fill: framed.fill }, png: framed.png, error: null };
      }
    } catch (error) {
      frame = {
        identity,
        png: null,
        error: error instanceof Error ? `replay ${error.name}: ${error.message}` : String(error),
      };
    }
    const [outcome] = await decodeChunk([frame], app, browser);
    out.push({ collision, attempt: classify(frame.identity, app, outcome) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface Cell {
  path: DecodePath;
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
  path: DecodePath,
): Cell[] {
  const cells: Cell[] = [];
  const scoped = attempts.filter((a) => a.path === path);
  for (const symbology of symbologies) {
    for (const tier of tiers) {
      const rows = scoped.filter((a) => a.symbology === symbology && a.tier === tier);
      const hits = rows.filter((a) => a.verdict === "hit").length;
      const misses = rows.filter((a) => a.verdict === "miss");
      const falseAccepts = rows.filter((a) => a.verdict === "false_accept").length;
      const errors = rows.filter((a) => a.verdict === "error").length;
      const decodeRate = rows.length === 0 ? 0 : hits / rows.length;
      const threshold = THRESHOLDS[tier];
      cells.push({
        path,
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
// How much of a cell is noise (SB-7)
// ---------------------------------------------------------------------------

/**
 * Two-sided 95%. Not tunable: a band nobody can move is a band nobody can shade.
 */
const BAND_Z = 1.96;

/**
 * What one cell's number is worth.
 *
 * A cell is `attempts` frames at one run seed. Change the seed and every moderate and severe
 * frame gets a different rotation, warp, glare and grain, so the cell moves — and it moves a
 * long way: five full canvas runs at five seeds put `code_128` severe anywhere in 54.0-65.5%,
 * an 11.5 pp spread, with `code_128` moderate at 9.0 and four more cells above 7 (SB-7).
 * Nothing in this report used to say so, so a fixer who moved a moderate cell by 5 pp on one
 * seed and called it a fix had measured noise.
 *
 * `clean` is the exception and it is exact: the clean tier applies no seeded randomness at
 * all (`degrade` returns the rendered symbol untouched), so a clean cell is identical at
 * every seed — measured spread 0.0 pp at all five. That is worth stating rather than
 * estimating, because it means **a clean-tier miss is structural, never sampling** (SB-4):
 * the same three `qr_code` VINs fail at every seed, and no amount of re-running will move
 * them.
 *
 * For `moderate` and `severe` the interval is Wilson's on the cell's own `hits / attempts`.
 * Wilson rather than the normal approximation because cells sit near 0 and near 1 here, where
 * the Wald interval runs off the end of the scale; and an interval computed from the sample
 * rather than a sweep because a sweep costs five runs and this costs nothing, so it can be on
 * in every report. Its accuracy is checked against the real thing, not assumed — see the
 * measured spreads in the report section and `--seeds`.
 */
interface Band {
  low: number;
  high: number;
  halfWidth: number;
  /** True when the tier applies no randomness, so the cell does not move with the seed. */
  deterministic: boolean;
}

function seedBand(cell: Cell): Band {
  if (cell.tier === "clean" || cell.attempts === 0) {
    return {
      low: cell.decodeRate,
      high: cell.decodeRate,
      halfWidth: 0,
      deterministic: true,
    };
  }
  const n = cell.attempts;
  const p = cell.decodeRate;
  const z2 = BAND_Z * BAND_Z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const spread = (BAND_Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  const low = Math.max(0, centre - spread);
  const high = Math.min(1, centre + spread);
  return { low, high, halfWidth: (high - low) / 2, deterministic: false };
}

/**
 * The band as a margin, for a cell in a table: `±6.7`, `exact`, or — when the run actually
 * swept seeds — the measured spread, which needs no estimator.
 */
function bandLabel(cell: Cell, seedRuns: readonly SeedRun[]): string {
  const band = seedBand(cell);
  // `exact` is reserved for the tier that cannot move. A swept cell that happened to land on
  // the same number every time is not exact — it is a measurement that came out flat, and
  // saying so keeps the two claims apart.
  if (band.deterministic) return "exact";
  const measured = measuredBand(cell, seedRuns);
  if (measured !== null) return `[${pct(measured.min)}-${pct(measured.max)}]`;
  return `±${(band.halfWidth * 100).toFixed(1)}`;
}

/** One further seed's cells, for the measured band (`--seeds`, SB-7). */
interface SeedRun {
  seed: number;
  cells: Cell[];
}

/** What one cell actually did across every seed measured. `null` at a single seed. */
interface MeasuredBand {
  seeds: number;
  min: number;
  max: number;
  mean: number;
  /** max - min: the number SB-7 reports, because it is the one a reader can act on. */
  spread: number;
}

function measuredBand(cell: Cell, seedRuns: readonly SeedRun[]): MeasuredBand | null {
  if (seedRuns.length === 0) return null;
  const rates = [cell.decodeRate];
  for (const run of seedRuns) {
    const match = run.cells.find(
      (c) => c.symbology === cell.symbology && c.tier === cell.tier && c.attempts > 0,
    );
    if (match !== undefined) rates.push(match.decodeRate);
  }
  if (rates.length < 2) return null;
  const min = Math.min(...rates);
  const max = Math.max(...rates);
  return {
    seeds: rates.length,
    min,
    max,
    mean: rates.reduce((sum, rate) => sum + rate, 0) / rates.length,
    spread: max - min,
  };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Facts about the run that are not options and not measurements. */
interface Provenance {
  /** The Chromium that decoded, or `null` when no browser path ran. */
  executable: string | null;
}

interface Options {
  count: number;
  tiers: Tier[];
  symbologies: BenchSymbology[];
  /**
   * Instruments, in canonical order. `paths[0]` is the one the §13.6 verdict comes from, and
   * a tracked report is only written when that is `canvas` — the app's path (B2).
   */
  paths: DecodePath[];
  /** Pages in the browser pool. Wall clock only; it cannot change a decode. */
  browserPages: number;
  /** Chromium binary, or `null` to let Playwright resolve one. */
  chromiumPath: string | null;
  json: string | null;
  quick: boolean;
  seed: number;
  /**
   * What the decoder is handed (SB-2). `frame` is the app's and the canonical one; `crop` is
   * the diagnostic that reproduces every number this bench reported before SB-2.
   */
  layout: Layout;
  /**
   * Further run seeds, each measuring the whole corpus again (SB-7). The report then carries
   * the *measured* seed band per cell instead of the estimated one. A diagnostic: it is many
   * runs in a trench coat, and the tracked artifact is one run.
   */
  extraSeeds: number[];
  /**
   * Z5 diagnostic: force every severe frame to carry exactly these extras instead of drawing
   * `SEVERE_EXTRAS_DRAWN` of them. This is how the per-subset table in the ledger was
   * measured, and a run using it is not measuring the tier — see `nonCanonical`.
   */
  severeExtras: SevereExtra[] | null;
}

const USAGE = `bun run bench [options]

  --count N            VINs in the corpus (default ${DEFAULT_COUNT}, ${QUICK_COUNT} with --quick)
  --quick              fast loop: fewer VINs, all tiers, all symbologies
  --tiers a,b          subset of ${TIERS.join(",")}
  --symbologies a,b    subset of ${BENCH_SYMBOLOGIES.join(",")}
  --seed N             run seed (default 0x${DEFAULT_SEED.toString(16)})
  --seeds a,b,c        run the whole corpus once per seed and report the MEASURED per-cell
                       band instead of the estimated one (SB-7; diagnostic, N runs)
  --paths a,b          decode paths, subset of ${DECODE_PATHS.join(",")} (default
                       ${DEFAULT_PATHS.join(",")}). The first is the report's verdict;
                       only a run led by "${APP_PATH}" writes the tracked report
  --layout l           ${LAYOUTS.join(" | ")} (default ${CANONICAL_LAYOUT}). "frame" is what
                       the app decodes; "crop" is the pre-SB-2 diagnostic and never
                       writes the tracked report
  --browser-pages N    pages decoding in parallel (default ${DEFAULT_BROWSER_PAGES})
  --chromium PATH      Chromium binary (default: whatever Playwright resolves)
  --severe-extras a,b  force the severe draw to exactly these (diagnostic; never writes
                       the tracked report). Default: ${SEVERE_EXTRAS_DRAWN} of
                       ${SEVERE_EXTRAS.join(",")} per frame, from the seed
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
  let paths: DecodePath[] = [...DEFAULT_PATHS];
  let browserPages = DEFAULT_BROWSER_PAGES;
  let chromiumPath: string | null = null;
  let json: string | null = null;
  let quick = false;
  let seed = DEFAULT_SEED;
  let severeExtras: SevereExtra[] | null = null;
  let layout: Layout = CANONICAL_LAYOUT;
  let extraSeeds: number[] = [];

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
      case "--paths":
        paths = parseList(value(), DECODE_PATHS, "--paths");
        break;
      case "--browser-pages":
        browserPages = parseCount(value(), "--browser-pages");
        break;
      case "--chromium":
        chromiumPath = value();
        break;
      case "--severe-extras":
        severeExtras = parseList(value(), SEVERE_EXTRAS, "--severe-extras");
        break;
      case "--layout":
        layout = parseList(value(), LAYOUTS, "--layout")[0];
        break;
      case "--seeds": {
        const parsed = value()
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
          .map(parseSeed);
        if (parsed.length === 0) throw new UsageError("--seeds: expected a comma-separated list");
        // The first is the run's own seed, so `--seeds a,b,c` reads as "these three seeds"
        // rather than "the default plus these three".
        seed = parsed[0];
        extraSeeds = parsed.slice(1).filter((value_) => value_ !== seed);
        break;
      }
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
    paths,
    browserPages,
    chromiumPath,
    json,
    quick,
    seed,
    severeExtras,
    layout,
    extraSeeds,
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

/**
 * §13.4: "each a superset of the one before it. The ordering is load-bearing: §13.6's
 * 99/90/70 ladder is meaningless if a lower tier is harder than a higher one, and it was."
 *
 * It was broken once, silently, for a whole slice, and nothing in the report said so — the
 * numbers were there to be compared and no one compared them. So the run compares them and
 * prints the answer. This is reported rather than added to the §13.6 failures: which
 * thresholds fail a run is §13.6's list, not the bench's to extend, and on a small --quick
 * cell two tiers that genuinely differ by 20 points can still cross by sampling noise.
 */
function orderingViolations(
  allCells: readonly Cell[],
  tiers: readonly Tier[],
  path: DecodePath,
): string[] {
  const cells = allCells.filter((c) => c.path === path);
  const violations: string[] = [];
  for (let i = 1; i < tiers.length; i += 1) {
    const [easier, harder] = [tiers[i - 1], tiers[i]];
    for (const cell of cells.filter((c) => c.tier === harder && c.attempts > 0)) {
      const above = cells.find((c) => c.symbology === cell.symbology && c.tier === easier);
      if (above === undefined || above.attempts === 0) continue;
      if (cell.decodeRate > above.decodeRate) {
        violations.push(
          `${cell.symbology}: ${harder} ${pct(cell.decodeRate)} > ${easier} ` +
            `${pct(above.decodeRate)}`,
        );
      }
    }
  }
  return violations;
}

/**
 * What the severe tier drew, for the report header. A forced list is a diagnostic and says
 * so, because a table headed "severe" that measured something else is worse than no table.
 */
function severeDraw(options: Options): string {
  if (options.severeExtras !== null) {
    return `FORCED to ${options.severeExtras.join(" + ")} — diagnostic, not the tier`;
  }
  return `${SEVERE_EXTRAS_DRAWN} of ${SEVERE_EXTRAS.join(", ")}, drawn per frame from the seed`;
}

/**
 * Decode rate per drawn subset (Z5). This is the evidence for `SEVERE_EXTRAS_DRAWN`, and it
 * is regenerated by every run rather than written down once: if one extra starts dominating
 * the tier again, this table is where it shows.
 */
function severeSubsetTable(
  attempts: readonly Attempt[],
  symbologies: readonly BenchSymbology[],
  path: DecodePath,
): string[] {
  const severe = attempts.filter(
    (a) => a.path === path && a.tier === "severe" && a.severeExtras !== null,
  );
  if (severe.length === 0) return [];

  const keys = [...new Set(severe.map((a) => (a.severeExtras ?? []).join(" + ")))].sort();
  const out: string[] = [];
  out.push("### Severe: what each frame drew");
  out.push("");
  out.push(`| Drawn extras | Frames | ${symbologies.join(" | ")} |`);
  out.push(`|---|---:|${symbologies.map(() => "---:").join("|")}|`);
  for (const key of keys) {
    const rows = severe.filter((a) => (a.severeExtras ?? []).join(" + ") === key);
    const cells = symbologies.map((symbology) => {
      const cell = rows.filter((a) => a.symbology === symbology);
      if (cell.length === 0) return "-";
      return pct(cell.filter((a) => a.verdict === "hit").length / cell.length);
    });
    out.push(`| ${key} | ${rows.length} | ${cells.join(" | ")} |`);
  }
  out.push("");
  out.push(
    "§13.4 lists six degradations for `severe`; two of them — 50% scale and heavier grain — " +
      "are harder settings of degradations `moderate` already applies, so they are on for " +
      "every frame and the tier stays a strict superset of `moderate` whatever is drawn. " +
      "The other four are drawn " +
      `${SEVERE_EXTRAS_DRAWN} at a time (Z5): all four at once is not one bad photo, it is ` +
      "every bad photo, and it left no cell above 57%.",
  );
  out.push("");
  return out;
}

// ---------------------------------------------------------------------------
// The instrument delta (B2)
// ---------------------------------------------------------------------------

/** One symbology × tier, as the app's path read it and as another instrument read it. */
interface Delta {
  path: DecodePath;
  symbology: BenchSymbology;
  tier: Tier;
  appRate: number;
  otherRate: number;
  /** Frames only one of the two got right, and the two agreements. */
  appOnly: number;
  otherOnly: number;
  both: number;
  neither: number;
}

/** A single frame the two instruments read differently, with everything needed to repeat it. */
interface Disagreement {
  path: DecodePath;
  vin: string;
  symbology: BenchSymbology;
  tier: Tier;
  seed: number;
  severeExtras: readonly SevereExtra[] | null;
  appVerdict: Verdict;
  appText: string | null;
  otherVerdict: Verdict;
  otherText: string | null;
}

function frameKey(attempt: Attempt): string {
  return `${attempt.vin}|${attempt.symbology}|${attempt.tier}`;
}

function byFrame(attempts: readonly Attempt[], path: DecodePath): Map<string, Attempt> {
  const map = new Map<string, Attempt>();
  for (const attempt of attempts) {
    if (attempt.path === path) map.set(frameKey(attempt), attempt);
  }
  return map;
}

/**
 * The headline of finding B2: not the new numbers, the difference between the old instrument
 * and the new one on identical frames. Every previous round's bench numbers carried this
 * difference as an unmeasured error.
 */
function deltas(
  attempts: readonly Attempt[],
  symbologies: readonly BenchSymbology[],
  tiers: readonly Tier[],
  app: DecodePath,
  others: readonly DecodePath[],
): { cells: Delta[]; disagreements: Disagreement[] } {
  const appFrames = byFrame(attempts, app);
  const cells: Delta[] = [];
  const disagreements: Disagreement[] = [];

  for (const path of others) {
    const otherFrames = byFrame(attempts, path);
    for (const symbology of symbologies) {
      for (const tier of tiers) {
        let appOnly = 0;
        let otherOnly = 0;
        let both = 0;
        let neither = 0;
        let total = 0;
        for (const [key, appAttempt] of appFrames) {
          if (appAttempt.symbology !== symbology || appAttempt.tier !== tier) continue;
          const otherAttempt = otherFrames.get(key);
          if (otherAttempt === undefined) continue;
          total += 1;
          const a = appAttempt.verdict === "hit";
          const b = otherAttempt.verdict === "hit";
          if (a && b) both += 1;
          else if (a) appOnly += 1;
          else if (b) otherOnly += 1;
          else neither += 1;
          if (
            appAttempt.verdict !== otherAttempt.verdict ||
            appAttempt.decoded !== otherAttempt.decoded
          ) {
            disagreements.push({
              path,
              vin: appAttempt.vin,
              symbology,
              tier,
              seed: appAttempt.seed,
              severeExtras: appAttempt.severeExtras,
              appVerdict: appAttempt.verdict,
              appText: appAttempt.decoded,
              otherVerdict: otherAttempt.verdict,
              otherText: otherAttempt.decoded,
            });
          }
        }
        if (total === 0) continue;
        cells.push({
          path,
          symbology,
          tier,
          appRate: (both + appOnly) / total,
          otherRate: (both + otherOnly) / total,
          appOnly,
          otherOnly,
          both,
          neither,
        });
      }
    }
  }
  return { cells, disagreements };
}

/** How many disagreeing frames the markdown lists in full before it starts counting. */
const DISAGREEMENT_SAMPLE = 20;

function deltaSection(
  options: Options,
  app: DecodePath,
  others: readonly DecodePath[],
  delta: { cells: Delta[]; disagreements: Disagreement[] },
): string[] {
  const out: string[] = [];
  out.push("## Instrument delta (finding B2)");
  out.push("");
  if (others.length === 0) {
    out.push(
      `Only \`${app}\` ran, so there is nothing to compare. Run \`--paths ${app},rgb\` for the ` +
        "difference between the app's decoder and the node control this bench used to report as " +
        "if it were the app.",
    );
    out.push("");
    return out;
  }

  out.push(
    "Same corpus, same seed, **same degraded pixels** — the frame is warped once and offered " +
      `to each instrument. \`${app}\` is the app's decode path; the columns beside it are what ` +
      "the other instruments made of the identical frames. A positive Δ means the app reads " +
      "more than the other instrument did.",
  );
  out.push("");
  out.push(
    "**Why a column can come out identical, and how to tell that is a result rather than a " +
      "harness fault.** On a grey frame the two luminance sources reduce to the same bytes: " +
      "`RGBLuminanceSource` takes the green-favouring average `(r + 2g + b) / 4` and " +
      "`HTMLCanvasElementLuminanceSource` takes `(306r + 601g + 117b + 512) >> 10`, and at " +
      "`r = g = b = v` both are exactly `v`. This corpus renders grey. What is left between " +
      "them is `isRotateSupported()` — true only on the canvas source, so `OneDReader` gets a " +
      "90°-rotated retry under `TRY_HARDER`, which cannot help a symbol that is already " +
      "horizontal — and `decodeWithState` against `decode(bitmap, hints)`, which rebuild the " +
      "same readers from the same hints. The `yuv` column is the control: it is the one path " +
      "that moves frames, so a delta table that shows it moving is a table that can see a " +
      "difference when there is one.",
  );
  out.push("");
  for (const path of others) {
    const rows = delta.cells.filter((c) => c.path === path);
    if (rows.length === 0) continue;
    out.push(`### \`${app}\` vs \`${path}\``);
    out.push("");
    out.push(`\`${path}\`: ${DECODE_PATH_NOTES[path]}.`);
    out.push("");
    out.push(
      `| Symbology | Tier | ${app} | ${path} | Δ pp | ${app} only | ${path} only | both | neither |`,
    );
    out.push("|---|---|---:|---:|---:|---:|---:|---:|---:|");
    for (const row of rows) {
      const d = (row.appRate - row.otherRate) * 100;
      out.push(
        `| ${row.symbology} | ${row.tier} | ${pct(row.appRate)} | ${pct(row.otherRate)} | ` +
          `${d >= 0 ? "+" : ""}${d.toFixed(1)} | ${row.appOnly} | ${row.otherOnly} | ` +
          `${row.both} | ${row.neither} |`,
      );
    }
    out.push("");
    const totalApp = rows.reduce((sum, r) => sum + r.both + r.appOnly, 0);
    const totalOther = rows.reduce((sum, r) => sum + r.both + r.otherOnly, 0);
    const frames = rows.reduce((sum, r) => sum + r.both + r.appOnly + r.otherOnly + r.neither, 0);
    const appOnly = rows.reduce((sum, r) => sum + r.appOnly, 0);
    const otherOnly = rows.reduce((sum, r) => sum + r.otherOnly, 0);
    out.push(
      `Over ${frames} frames: \`${app}\` ${totalApp} correct, \`${path}\` ${totalOther} ` +
        `correct — ${appOnly} read only by \`${app}\`, ${otherOnly} read only by \`${path}\`.`,
    );
    out.push("");
  }

  const shown = delta.disagreements.slice(0, DISAGREEMENT_SAMPLE);
  if (delta.disagreements.length === 0) {
    out.push(
      "**No frame decoded differently on any path.** Every disagreement the two instruments " +
        "could have had, they did not have: the decoded text matched byte for byte on all " +
        `${options.symbologies.length * options.tiers.length} cells.`,
    );
    out.push("");
    return out;
  }
  out.push(
    `### The ${delta.disagreements.length} frame` +
      `${delta.disagreements.length === 1 ? "" : "s"} that read differently` +
      `${delta.disagreements.length > shown.length ? ` (first ${shown.length})` : ""}`,
  );
  out.push("");
  out.push("| Path | VIN | Symbology | Tier | Drawn extras | app | other | Seed |");
  out.push("|---|---|---|---|---|---|---|---|");
  for (const row of shown) {
    out.push(
      `| ${row.path} | \`${row.vin}\` | ${row.symbology} | ${row.tier} | ` +
        `${row.severeExtras === null ? "-" : row.severeExtras.join(" + ")} | ` +
        `${row.appVerdict} ${row.appText === null ? "(no decode)" : `\`${row.appText.replace(/\|/g, "\\|")}\``} | ` +
        `${row.otherVerdict} ${row.otherText === null ? "(no decode)" : `\`${row.otherText.replace(/\|/g, "\\|")}\``} | ` +
        `\`0x${row.seed.toString(16)}\` |`,
    );
  }
  out.push("");
  return out;
}

/**
 * The five-seed sweep, printed as a **quote** with its provenance and a staleness check
 * (SB-11), because this run does not take it.
 *
 * The paragraph this replaces was a string literal: 21,000 attempts and two named collisions
 * asserted by every run that produced no false accepts of its own, whether or not anything
 * had measured them since. It could not become false. This can: change the layout, the
 * verdict path, the corpus size, the symbology set, the §4.6 hints or the Z5 draw and the
 * quote prints as stale, naming what moved.
 */
function quotedSweepSection(options: Options, seedRuns: readonly SeedRun[]): string[] {
  const sweep = RECORDED_SWEEP;
  const stale = drift(sweep.config, options);
  const out: string[] = [];
  out.push("### Quoted, not measured by this run (SB-11)");
  out.push("");
  out.push(
    "Everything above this line is this run's own count over its own attempts. What follows " +
      "is a **record of a measurement taken once and not re-taken here**: no part of this run " +
      `recomputes those ${sweep.attempts.toLocaleString("en-US")} attempts, and this block ` +
      "will go on printing until someone does.",
  );
  out.push("");
  out.push("| | |");
  out.push("|---|---|");
  out.push(`| Quoted result | **${sweep.result}** |`);
  out.push(
    `| Seeds | ${sweep.seeds.map((seed) => `\`0x${seed.toString(16)}\``).join(", ")} — ` +
      `${sweep.config.count} VINs each |`,
  );
  out.push(`| Taken at | ${sweep.taken} |`);
  out.push(`| Re-take with | \`${sweep.command}\` |`);
  out.push(
    stale.length === 0
      ? "| Still comparable? | **Yes** — this run matches the sweep's configuration on layout, " +
          "verdict path, corpus size, symbology set, §4.6 formats and hints, and the Z5 severe " +
          "draw. |"
      : `| Still comparable? | **NO — STALE.** ${stale.join("; ")}. The quoted number describes ` +
          "a different measurement and is not evidence about this one; re-take it before " +
          "anyone leans on it. |",
  );
  out.push("");
  out.push(
    "**What that check cannot see.** It compares the bench's configuration, not the program: " +
      "a change inside `src/lib/vin`, in `bwip-js`'s rendering, in `sharp`'s degradations or " +
      "in ZXing itself moves decodes without moving a single axis above. Nothing short of " +
      "re-running the command covers that, and a quote is never evidence that a **current** " +
      "run is clean.",
  );
  out.push("");
  if (seedRuns.length > 0) {
    out.push(
      `This run swept ${seedRuns.length + 1} seeds of its own (` +
        `${[options.seed, ...seedRuns.map((r) => r.seed)].map((seed) => `\`0x${seed.toString(16)}\``).join(", ")}), ` +
        "so its bands below are measured — but it is still not the sweep quoted here.",
    );
    out.push("");
  }
  return out;
}

/**
 * The half of the quoted claim that **is** recomputed, every run (SB-11).
 *
 * "Neither collision survives the frame" was the load-bearing sentence in the old paragraph
 * and the cheapest one to check: two frames, two decodes, on this run's layout and this
 * run's decode path. If a future change — an ROI crop above all, SB-3/SB-10 — makes either
 * frame decodable again, this table says so on the same page as the headline instead of
 * leaving a stale sentence claiming otherwise.
 */
function replaySection(options: Options, replays: readonly Replay[]): string[] {
  if (replays.length === 0) return [];
  const out: string[] = [];
  const reproduced = replays.filter((r) => r.attempt.verdict === "false_accept");
  out.push("### Replayed by this run: the known Code 128 collisions (SB-11)");
  out.push("");
  out.push(
    `Both mod-103-valid misreads this slice has found, re-decoded on this run's ` +
      `\`${options.layout}\` layout through \`${options.paths[0]}\`. Fixed seeds, so ` +
      "`--seed` and `--severe-extras` do not move them; they are recorded frames, not corpus " +
      "attempts, and they are counted nowhere above.",
  );
  out.push("");
  out.push(
    "| Ledger | Expected VIN | Collision reads | Symbology | Drawn extras | This run | Decoded text |",
  );
  out.push("|---|---|---|---|---|---|---|");
  for (const { collision, attempt } of replays) {
    const verdict =
      attempt.verdict === "false_accept"
        ? `**REPRODUCES — \`${attempt.extracted ?? ""}\`**`
        : attempt.verdict === "hit"
          ? "reads correctly"
          : attempt.verdict === "error"
            ? `error: ${attempt.error ?? ""}`
            : attempt.decoded === null
              ? "reads nothing"
              : "decodes, no VIN";
    out.push(
      `| ${collision.id} | \`${collision.vin}\` | \`${collision.wrong}\` | ` +
        `${collision.symbology} | ${(attempt.severeExtras ?? []).join(" + ")} | ${verdict} | ` +
        `${attempt.decoded === null ? "-" : `\`${attempt.decoded.replace(/\|/g, "\\|")}\``} |`,
    );
  }
  out.push("");
  if (reproduced.length === 0) {
    out.push(
      "Neither reads on this instrument, which is what the quoted sweep's explanation rests " +
        "on: the frame changed which frames decode at all, and a decode that no longer happens " +
        "cannot be wrong. **That is not a disproof.** The collisions are arithmetic in Code " +
        "128's own check, not artefacts of a crop, and the quoted 21,000 attempts bound the " +
        "rate at roughly 1 in 7,000 at 95% — which is not zero.",
    );
    out.push("");
    out.push(
      "**If you are about to crop the frame (SB-3), this is the number you are about to " +
        "change.** Both rows above read as nothing because of the frame the app decodes; an " +
        "ROI band recovers marginal Code 128 frames, which is the population they came from. " +
        "Read *What ROI risks* below before writing it.",
    );
  } else {
    out.push(
      `**${reproduced.length} of ${replays.length} REPRODUCES ITS WRONG VIN on this run's ` +
        "layout and decode path** — " +
        reproduced.map((r) => r.collision.id).join(", ") +
        ". The quoted sweep described a configuration in which these frames read as nothing; " +
        "it does not describe this one, and the zero above is a count over the corpus that " +
        "does not include them. Re-take the sweep before any headline here is believed, and " +
        "read R4-F and SB-1 in the ledger first.",
    );
  }
  out.push("");
  return out;
}

/**
 * What the frame costs and what an ROI crop would buy back — SB-2 and SB-3, measured by
 * `bench/frame-probe.ts` and reproduced here because the next person to read this table will
 * reach for a crop, and one of the two obvious crops destroys 2D entirely.
 *
 * These are recorded numbers from a named command, not this run's. They are in the report
 * because a warning that lives only in a ledger row is a warning nobody reads before writing
 * the code.
 */
function roiSection(): string[] {
  return [
    "## The frame, and the ROI crop somebody is about to write (SB-2 / SB-3 / SB-10)",
    "",
    "Measured by `bun run bench/frame-probe.ts --count 40` at seed `0x5eed1a7c` — **not by " +
      "this run** — on identical symbol pixels across four layouts. `crop` is what this bench " +
      "measured before SB-2; `frame` is what it measures now and what the app decodes; `roi` " +
      "and `roi_tall` are two crops the app could apply to that frame.",
    "",
    "| Layout | What it is | Overall | Mean decode |",
    "|---|---|---:|---:|",
    "| `crop` | the tight crop — the pre-SB-2 bench, an image the app never sees | 571/840 " +
      "(68.0%) | 14.3 ms |",
    "| `frame` | 1920x1080, symbol unscaled and centred — **what the app decodes** | 535/840 " +
      "(63.7%) | 40.0 ms |",
    "| `roi` | that frame cropped to §6.1's guide box **as drawn**, 90% x 22% = 1728x238 | " +
      "392/840 (46.7%) | - |",
    "| `roi_tall` | that frame cropped to a taller band, 90% x 40% = 1728x432 | 547/840 " +
      "(65.1%) | 29.0 ms |",
    "",
    "**Do not crop to the guide box as drawn.** §6.1's box is `h-[22%] w-[90%]` " +
      "(`CameraView.tsx:92`); at 1080 px tall that is a 238 px band, and a label-realistic " +
      "Data Matrix or QR is ~480-500 px tall. Cropping to it takes `data_matrix` clean from " +
      "100% to **0%** and `qr_code` clean from 95% to **0%** — it does not degrade 2D, it " +
      "deletes it. The taller 90% x 40% band is the one that helps: `code_128` severe " +
      "27.5% -> 40.0% (+12.5 pp), `code_39_i` severe 30.0% -> 40.0% (+10.0), `code_39` severe " +
      "37.5% -> 40.0%, 2D fully restored, and mean decode time 40.0 ms -> 29.0 ms (-27%). " +
      "**Those 1D severe cells are 40 frames each and are superseded by the 200-frame " +
      "measurement below (SB-10); the 2D result is not.**",
    "",
    "So an ROI crop buys back about a third of what the frame costs — it does not reach the " +
      "tight crop's 68.0%, and no ROI band turns a failing §13.6 cell into a passing one. It " +
      "is a `useScanner` change (SB-3) and it is a fixer's to make, not the bench's; the bench " +
      "measures it and stops there. Separately, and independently of any of this: §6.1 draws " +
      "a box telling the field user where to put the label and nothing downstream uses it.",
    "",
    "### What ROI risks — the part that is not a decode rate (SB-10)",
    "",
    "**An ROI crop does not decode better. It makes _different frames_ decode.** It raises a " +
      "rate by turning frames that currently read as nothing into frames that read as " +
      "something — and a marginal Code 128 frame is precisely where both of this slice's " +
      "known checksum collisions were found. R4-F and SB-1 are mod-103-valid misreads, which " +
      "Code 128's own check cannot catch, and the zero-false-accept headline at the top of " +
      "this report holds on the `frame` layout **because** those two frames read as nothing " +
      "on it. That is measured every run, in the replay table under the headline.",
    "",
    "Recorded, not taken by this run — `bun run bench/frame-probe.ts --count 200 " +
      "--symbologies code_39,code_39_i,code_128,code_128_fnc1 --tiers severe` at seed " +
      "`0x5eed1a7c`, the four 1D severe rows, 800 frames per layout:",
    "",
    "| Layout | Correct | False accepts | Frames dark on `frame` that this layout decodes |",
    "|---|---:|---:|---|",
    "| `frame` (the app) | 157/800 (19.6%) | 0 | - |",
    "| `roi` (guide box as drawn) | 187/800 (23.4%) | 0 | 33 |",
    "| `roi_tall` (90% x 40%) | 187/800 (23.4%) | 0 | 33 — 31 correct, **0 wrong VIN**, 2 " +
      "decoded without naming a VIN, 0 frames lost |",
    "",
    "Three things follow, and the third is the one that matters.",
    "",
    "1. **The gain is smaller than SB-3 recorded.** At 200 VINs, `roi_tall` moves `code_128` " +
      "severe 25.0% -> 31.0% (+6.0 pp), `code_39` 30.0% -> 34.0%, `code_39_i` 23.5% -> 28.5%, " +
      "and leaves `code_128_fnc1` at 0.0%. SB-3's +12.5 pp on `code_128` severe was a 40-VIN " +
      "cell, which is a ±15 pp measurement — see *What a cell is worth*. ROI is still worth " +
      "having; it is worth about half of what the ledger row claims. The -27% decode time is " +
      "the drawn box's, not the tall band's: in the same 200-VIN run, on the same machine " +
      "under the same load, `frame` cost 141.2 ms, `roi` 103.7 ms (-27%) and `roi_tall` " +
      "131.1 ms (-7%).",
    "",
    "2. **On 1D rows the two bands are the same measurement.** `roi` and `roi_tall` decode " +
      "identically here, because a severe 1D symbol fits inside the 238 px drawn box. SB-3's " +
      "difference between them is entirely 2D, where the drawn box deletes the symbol " +
      "outright. A fixer testing an ROI crop on Code 39 alone will not see the failure mode " +
      "that matters.",
    "",
    "3. **Zero false accepts in the recovered population is not the reassurance it looks " +
      "like.** 33 recovered frames, against a phenomenon this bench has measured at 2 in " +
      "21,000 attempts, is roughly 300x too small a sample to contain one; the rule of three " +
      "puts the 95% upper bound on the recovered-frame rate at 3/33, about 9%. The " +
      "measurement cannot see the thing ROI risks.",
    "",
    "**Therefore: implementing ROI (SB-3) requires re-taking the five-seed sweep before this " +
      "report's false-accept headline may be believed.** `" +
      RECORDED_SWEEP.command +
      "` at " +
      RECORDED_SWEEP.seeds.map((seed) => `\`0x${seed.toString(16)}\``).join(", ") +
      `, ${RECORDED_SWEEP.config.count} VINs each — the same ` +
      `${RECORDED_SWEEP.attempts.toLocaleString("en-US")} attempts the headline quotes. The ` +
      "headline is a count over the frames the current layout decodes; ROI changes which " +
      "frames those are, so afterwards it is a count about a different population and the " +
      "old one says nothing. A decode rate that goes up while the false-accept count goes " +
      "unmeasured is not an improvement, it is an unmeasured trade — and §13.3 grades the " +
      "losing side of that trade S1.",
    "",
  ];
}

/**
 * What a cell is worth (SB-7). Without this, every number above reads as exact, and the loop
 * spends rounds chasing 5 pp moves that were the seed.
 */
function seedNoiseSection(
  options: Options,
  cells: readonly Cell[],
  seedRuns: readonly SeedRun[],
): string[] {
  const out: string[] = [];
  const moving = cells.filter((c) => c.tier !== "clean" && c.attempts > 0);
  const widest = [...moving].sort(
    (a, b) =>
      (measuredBand(b, seedRuns)?.spread ?? seedBand(b).halfWidth * 2) -
      (measuredBand(a, seedRuns)?.spread ?? seedBand(a).halfWidth * 2),
  )[0];

  out.push("## What a cell is worth (SB-7)");
  out.push("");
  const sweep = RECORDED_SWEEP;
  const stale = drift(sweep.config, options);
  out.push(
    `A cell above is ${moving[0]?.attempts ?? 0} frames at **one run seed**. Change the seed ` +
      "and every `moderate` and `severe` frame draws a different rotation, warp, glare, grain " +
      "and JPEG quality, so the cell moves.",
  );
  out.push("");
  // Quoted, with its provenance and its staleness check, rather than asserted (SB-11): these
  // spreads are the same recorded sweep the headline quotes, and nothing here re-measures them.
  out.push(
    `**Quoted, not measured by this run (SB-11).** The five-seed sweep recorded at ` +
      `${sweep.taken} — ${sweep.config.count} VINs at ` +
      `${sweep.seeds.map((seed) => `\`0x${seed.toString(16)}\``).join(", ")} — spread ` +
      sweep.spreads.map((s2) => `${s2.cell} over ${pct(s2.low)}-${pct(s2.high)}`).join(" and ") +
      ` — ${((sweep.spreads[0].high - sweep.spreads[0].low) * 100).toFixed(1)} pp each — with ` +
      `${sweep.alsoWide}. (On the pre-SB-2 crop layout the widest was ${sweep.cropWidest}.) ` +
      (stale.length === 0
        ? "Its configuration still matches this run's, so those spreads describe these cells. "
        : `**Its configuration no longer matches this run's — ${stale.join("; ")} — so those ` +
          "spreads describe different cells and this run's own band is the one to use.** ") +
      "Re-take it with `" +
      sweep.command +
      "`. None of it was ever stated here, so a fixer who moved a moderate cell by 5 pp on " +
      "one seed and called it a fix had measured noise.",
  );
  out.push("");
  out.push(
    "**`clean` is exact.** The clean tier applies no seeded randomness at all — `degrade` " +
      "returns the rendered symbol untouched — so a clean cell is byte-identical at every " +
      "seed, and its measured spread across those five runs was 0.0 pp in every symbology. " +
      "That is not a small band, it is no band: **a clean-tier miss is structural** " +
      "(SB-4). The same three `qr_code` VINs fail at every seed and no re-run will move them.",
  );
  out.push("");
  if (seedRuns.length > 0) {
    out.push(
      `**Measured, not estimated.** This run swept ${seedRuns.length + 1} seeds ` +
        `(\`0x${options.seed.toString(16)}\`, ` +
        `${seedRuns.map((r) => `\`0x${r.seed.toString(16)}\``).join(", ")}) over the whole ` +
        "corpus, so the band on every cell is the range those runs actually produced.",
    );
  } else {
    out.push(
      "**This run measured one seed**, so the band on each `moderate` and `severe` cell is " +
        "estimated from that cell's own sample: a 95% Wilson interval on `hits / attempts`. " +
        "It estimates the same thing a sweep measures — a cell is n independent frames either " +
        "way — and it was checked against the sweep rather than trusted. A 95% interval is " +
        "about 3.9 standard errors wide and the range of five draws is about 2.3, so a " +
        "five-seed spread should come out near 0.6 of this band; over the twenty-one cells " +
        "swept it came out at 0.24-1.06, median 0.48. The band is therefore honest and, for " +
        "a five-run comparison, slightly generous — which is the safe direction. Wilson " +
        "rather than the normal approximation because cells sit near 0 and near 1 here. To " +
        "measure it instead of estimating it: `bun run bench/run.ts --seeds a,b,c --paths " +
        "canvas` — a diagnostic, n runs, which never writes this file.",
    );
  }
  out.push("");
  if (widest !== undefined) {
    const measured = measuredBand(widest, seedRuns);
    const width = measured !== null ? measured.spread : seedBand(widest).halfWidth * 2;
    out.push(
      `**The operating rule.** The widest band in this run is \`${widest.symbology}\` ` +
        `${widest.tier}, ${(width * 100).toFixed(1)} pp wide. Comparing two runs carries that ` +
        "uncertainty twice, so a before/after difference has to clear roughly 1.4x the band " +
        `— about ${(width * 1.41 * 100).toFixed(1)} pp on that cell — before it is a claim ` +
        "rather than a coincidence. Below that, sweep three seeds before it goes in a ledger " +
        "row. It cuts both ways: a regression inside the band is not a regression either.",
    );
    out.push("");
  }
  // Derived, not asserted: whether any failing cell could reach its threshold at a lucky
  // seed is a question this run can answer about itself, and a claim that goes stale if it
  // is written down instead.
  const failing = moving.filter((c) => !c.pass);
  const reachable = failing.filter((c) => {
    const measured = measuredBand(c, seedRuns);
    return (measured !== null ? measured.max : seedBand(c).high) >= c.threshold;
  });
  const closest = [...failing].sort(
    (a, b) =>
      (measuredBand(a, seedRuns)?.max ?? seedBand(a).high) -
      a.threshold -
      ((measuredBand(b, seedRuns)?.max ?? seedBand(b).high) - b.threshold),
  )[failing.length - 1];
  if (reachable.length === 0 && closest !== undefined) {
    const top = measuredBand(closest, seedRuns)?.max ?? seedBand(closest).high;
    out.push(
      "**No verdict changes inside these bands.** Not one failing cell reaches its threshold " +
        `at the top of its band; the closest is \`${closest.symbology}\` ${closest.tier} at ` +
        `${pct(closest.decodeRate)}, whose band tops out at ${pct(top)} against ` +
        `${pct(closest.threshold)}. And the false-accept threshold is a count, not a rate, so ` +
        "no band applies to it at all: one is one.",
    );
  } else if (reachable.length > 0) {
    out.push(
      `**${reachable.length} failing cell${reachable.length === 1 ? "" : "s"} could reach ` +
        "the threshold at the top of the band** — " +
        reachable.map((c) => `\`${c.symbology}\` ${c.tier}`).join(", ") +
        " — so those verdicts are seed-sensitive and want a sweep before anyone acts on them. " +
        "The false-accept threshold is a count, not a rate, so no band applies to it: one is " +
        "one.",
    );
  }
  out.push("");
  return out;
}

function markdownReport(
  options: Options,
  provenance: Provenance,
  allCells: readonly Cell[],
  timings: readonly Timing[],
  attempts: readonly Attempt[],
  vinCount: number,
  failures: readonly string[],
  diagnosticReasons: readonly string[],
  seedRuns: readonly SeedRun[],
  replays: readonly Replay[],
): string {
  const app = options.paths[0];
  const others = options.paths.slice(1);
  const cells = allCells.filter((c) => c.path === app);
  const scoped = attempts.filter((a) => a.path === app);
  const falseAccepts = scoped.filter((a) => a.verdict === "false_accept");
  const offPathFalseAccepts = attempts.filter(
    (a) => a.path !== app && a.verdict === "false_accept",
  );
  const errors = attempts.filter((a) => a.verdict === "error");
  const stripped = attempts.filter((a) => a.aimStripped).length;
  const meanFill =
    scoped.length === 0 ? 0 : scoped.reduce((sum, a) => sum + a.fill, 0) / scoped.length;
  const out: string[] = [];

  out.push("# §13.4 scan-robustness bench");
  out.push("");
  if (diagnosticReasons.length > 0) {
    out.push(
      "> **DIAGNOSTIC RUN — NOT §13.6 EVIDENCE.** This is not the canonical `bun run bench`: " +
        `${diagnosticReasons.join("; ")}. The verdict below is the verdict *of this run*, ` +
        "over whatever subset it measured, and it says nothing about the thresholds. The " +
        "tracked artifacts were not written (SB-6).",
    );
    out.push("");
  }
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
  out.push(`| Attempts | ${attempts.length} (${scoped.length} per path) |`);
  out.push(`| **Decode path (verdict)** | \`${app}\` — ${DECODE_PATH_NOTES[app]} |`);
  out.push(`| **Frame (SB-2)** | \`${options.layout}\` — ${LAYOUT_NOTES[options.layout]} |`);
  out.push(
    `| Symbol fill | ${pct(meanFill)} of the frame width, mean over ${scoped.length} frames |`,
  );
  for (const path of others) {
    out.push(`| Also measured | \`${path}\` — ${DECODE_PATH_NOTES[path]} |`);
  }
  out.push(`| Browser pages | ${options.paths.some(isBrowserPath) ? options.browserPages : "-"} |`);
  out.push(`| Chromium | ${provenance.executable ?? "-"} |`);
  out.push(
    `| Decoder hints (§4.6) | ${BENCH_FORMAT_NAMES.join(", ")}; ${BENCH_HINT_NAMES.join(", ")} |`,
  );
  out.push(`| Severe extras (Z5) | ${severeDraw(options)} |`);
  out.push(`| ZXing per-reader warnings swallowed (\`rgb\` only) | ${suppressedWarnings()} |`);
  out.push(`| Reads carrying the §4.6 AIM identifier | ${stripped} |`);
  out.push("");
  out.push(
    'Every degradation seed is `runSeed ^ fnv1a("vin|symbology|tier")` — the decode path is ' +
      "deliberately not in the key, so every instrument reads the same pixels. This run " +
      "reproduces exactly, and any single row below reproduces on its own.",
  );
  out.push("");
  out.push(
    `Every rate, miss reason and false accept below is \`${app}\`'s unless it says otherwise. ` +
      "The instrument delta is its own section.",
  );
  out.push("");
  out.push(
    `**These numbers are measured on the frame the app decodes (SB-2), and they are much ` +
      `worse than the ones this report used to carry.** The bench used to hand ZXing a tight ` +
      `crop — a ~1050 px symbol in a ~1100 px image. \`useScanner\` calls \`decodeFromStream\`, ` +
      `and \`@zxing/browser\` draws the whole \`<video>\` onto its capture canvas at ` +
      `\`videoWidth\` x \`videoHeight\`, so under §6.3's \`ideal\` constraints the decoder gets ` +
      `${FRAME_WIDTH}x${FRAME_HEIGHT} with the symbol filling ${pct(meanFill)} of the width ` +
      `and the rest of the field empty. The symbol pixels are byte-identical either way — the ` +
      `degraded image is composited unscaled and centred, never resampled — so the whole ` +
      `difference between the old table and this one is the field around the symbol. Nothing ` +
      `about the corpus, the tiers or the §4.6 hints changed. The old numbers were a ` +
      `measurement of an easier problem than the product solves, and they were optimistic in ` +
      `the direction that matters. \`--layout crop\` reproduces them, as a diagnostic that ` +
      `cannot write this file.`,
  );
  out.push("");

  out.push("## Headline: false accepts (§13.6 requires 0)");
  out.push("");
  if (falseAccepts.length === 0) {
    out.push(
      `**0 false accepts** in ${scoped.length} attempts on \`${app}\`. ` +
        `Threshold ${FALSE_ACCEPT_THRESHOLD}.`,
    );
    out.push("");
    out.push(
      `Zero at ${seedRuns.length === 0 ? "one seed" : `${seedRuns.length + 1} seeds`} is not ` +
        "zero (SB-7). §13.6's zero is a claim about the whole corpus, and a run is one draw " +
        "from it: R4-F was found at one seed, and SB-1 only turned up on the fourth seed of a " +
        "five-seed sweep, at 2 in 21,000. A clean headline here means this run produced none " +
        "— nothing more.",
    );
  } else {
    out.push(
      `**${falseAccepts.length} FALSE ACCEPT${falseAccepts.length === 1 ? "" : "S"}** ` +
        `in ${scoped.length} attempts on \`${app}\` ` +
        `(threshold ${FALSE_ACCEPT_THRESHOLD}). A wrong VIN accepted is an S1 blocker (§13.3).`,
    );
    out.push("");
    out.push(
      "| Expected VIN | Returned VIN | Symbology | Tier | Drawn extras | ZXing format | Check digit | Decoded text | Seed |",
    );
    out.push("|---|---|---|---|---|---|---|---|---|");
    for (const a of falseAccepts) {
      out.push(
        `| \`${a.vin}\` | \`${a.extracted ?? ""}\` | ${a.symbology} | ${a.tier} | ` +
          `${a.severeExtras === null ? "-" : a.severeExtras.join(" + ")} | ` +
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
  out.push(...quotedSweepSection(options, seedRuns));
  out.push(...replaySection(options, replays));
  if (offPathFalseAccepts.length > 0) {
    out.push(
      `Off the app's path, ${offPathFalseAccepts.length} further false accept` +
        `${offPathFalseAccepts.length === 1 ? "" : "s"} — a wrong VIN a *different* ZXing ` +
        "plumbing produced from the same frames. Not counted against §13.6, which is about " +
        "the program that ships, and listed here because a bench that hid one would be the " +
        "B2 defect again:",
    );
    out.push("");
    out.push("| Path | Expected VIN | Returned VIN | Symbology | Tier | Decoded text | Seed |");
    out.push("|---|---|---|---|---|---|---|");
    for (const a of offPathFalseAccepts) {
      out.push(
        `| ${a.path} | \`${a.vin}\` | \`${a.extracted ?? ""}\` | ${a.symbology} | ${a.tier} | ` +
          `\`${(a.decoded ?? "").replace(/\|/g, "\\|")}\` | \`0x${a.seed.toString(16)}\` |`,
      );
    }
    out.push("");
  }

  out.push("## Decode rate per symbology × tier");
  out.push("");
  out.push(
    `| Symbology | ${options.tiers.map((t) => `${t} (>= ${pct(THRESHOLDS[t])})`).join(" | ")} |`,
  );
  out.push(`|---|${options.tiers.map(() => "---").join("|")}|`);
  for (const symbology of options.symbologies) {
    const row = options.tiers.map((tier) => {
      const cell = cells.find(
        (c) => c.path === app && c.symbology === symbology && c.tier === tier,
      );
      if (cell === undefined) return "-";
      return `${pct(cell.decodeRate)} ${bandLabel(cell, seedRuns)} ${cell.pass ? "PASS" : "FAIL"}`;
    });
    out.push(`| ${symbology} | ${row.join(" | ")} |`);
  }
  out.push("");
  out.push("Decode rate is end to end: the fraction of frames that produced the **correct** VIN");
  out.push("through ZXing and §4.2 `extractVin`, not the fraction that merely decoded.");
  out.push("");
  out.push(
    `Each cell reads \`rate ${seedRuns.length > 0 ? "measured-band" : "±band"} PASS/FAIL\`. ` +
      `**${seedRuns.length > 0 ? "The band is what this cell measured across the seeds swept" : "The band is how far this cell moves when the run seed moves"}** ` +
      "— see *What a cell is worth* below. `exact` means the cell cannot move: the clean tier " +
      "applies no seeded randomness, so a clean-tier miss is structural and re-running will " +
      "never fix it.",
  );
  out.push("");
  const ordering = orderingViolations(allCells, options.tiers, app);
  out.push(
    ordering.length === 0
      ? `**Tier ordering holds** (§13.4): ${options.tiers.join(" >= ")} in every cell.`
      : `**TIER ORDERING BROKEN** (§13.4) — a lower tier measured easier than a higher one, ` +
          `so §13.6's ladder does not mean what it says: ${ordering.join("; ")}.`,
  );
  out.push("");

  out.push("### Detail");
  out.push("");
  out.push(
    "| Symbology | Tier | Attempts | Hits | Misses | Errors | False accepts | Rate | Seed band | Threshold | Margin | Status |",
  );
  out.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const c of cells) {
    const band = seedBand(c);
    const measured = measuredBand(c, seedRuns);
    const bandCell =
      measured !== null
        ? `${pct(measured.min)}-${pct(measured.max)} over ${measured.seeds} seeds`
        : band.deterministic
          ? "exact (no randomness)"
          : `${pct(band.low)}-${pct(band.high)}`;
    out.push(
      `| ${c.symbology} | ${c.tier} | ${c.attempts} | ${c.hits} | ${c.misses} | ${c.errors} | ` +
        `${c.falseAccepts} | ${pct(c.decodeRate)} | ${bandCell} | ${pct(c.threshold)} | ` +
        `${margin(c)} | ${c.pass ? "PASS" : "FAIL"} |`,
    );
  }
  out.push("");

  out.push(...severeSubsetTable(attempts, options.symbologies, app));

  out.push(
    ...deltaSection(
      options,
      app,
      others,
      deltas(attempts, options.symbologies, options.tiers, app, others),
    ),
  );

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

  out.push(...seedNoiseSection(options, cells, seedRuns));

  out.push(...roiSection());

  out.push("## Decode time");
  out.push("");
  out.push("| Scope | Decodes | Mean ms | p95 ms |");
  out.push("|---|---:|---:|---:|");
  for (const t of timings) {
    out.push(`| ${t.scope} | ${t.decodes} | ${ms(t.meanMs)} | ${ms(t.p95Ms)} |`);
  }
  out.push("");
  out.push(
    "Times cover the ZXing read only — binarisation and the decode — and exclude getting the " +
      "frame onto the canvas, because the app never parses a PNG either: it draws a video " +
      "frame it already has. Timings are the one part of this report that is not " +
      "bit-reproducible; no threshold rides on them. §13.4's mean **time-to-confirm** is not " +
      "here: confirmation is two agreeing reads inside §6.3's window, which run (b) — the " +
      "Playwright fake-camera pass — is what exercises. This run measures one frame at a time.",
  );
  out.push("");

  if (errors.length > 0) {
    out.push("## Decoder faults");
    out.push("");
    out.push("| Path | VIN | Symbology | Tier | Seed | Error |");
    out.push("|---|---|---|---|---|---|");
    for (const a of errors) {
      out.push(
        `| ${a.path} | \`${a.vin}\` | ${a.symbology} | ${a.tier} | \`0x${a.seed.toString(16)}\` | ` +
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
    `These numbers came out of \`${app}\` — ${DECODE_PATH_NOTES[app]} — on ` +
      `${options.layout === "frame" ? `the ${FRAME_WIDTH}x${FRAME_HEIGHT} field the app's decoder is handed (SB-2)` : "a tight crop the app never sees (SB-2)"}. ` +
      "That is the app's decoder, in the app's engine, on the app's frame geometry; the " +
      "bench's node path was none of those (B2) and the crop layout was not the last of them. " +
      "What it still is not is a **camera frame**. The app draws a `<video>` whose pixels came " +
      "off a sensor through an ISP and YUV 4:2:0; this composites a PNG onto a uniform white " +
      "field. A real jamb is a darker, textured surround, and a clean white field is the " +
      "*easier* of the two for a row-histogram binariser, so even these rates are a ceiling " +
      "and not a floor. `bench/camera-probe.ts` measures the colour step on a subset — the " +
      "same frames through Chromium's own fake capture device and a real `<video>` — and " +
      "finds the camera reads slightly *worse*, deterministically. Nothing here models a " +
      "lens, and nothing here is a label.",
  );
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
  provenance: Provenance,
  cells: readonly Cell[],
  timings: readonly Timing[],
  attempts: readonly Attempt[],
  vinCount: number,
  failures: readonly string[],
  diagnosticReasons: readonly string[],
  seedRuns: readonly SeedRun[],
  replays: readonly Replay[],
): string {
  const app = options.paths[0];
  const others = options.paths.slice(1);
  const scoped = attempts.filter((a) => a.path === app);
  const falseAccepts = attempts.filter((a) => a.verdict === "false_accept");
  const errors = attempts.filter((a) => a.verdict === "error");
  const delta = deltas(attempts, options.symbologies, options.tiers, app, others);
  return `${JSON.stringify(
    {
      spec: "§13.4 scan-robustness bench",
      canonical: diagnosticReasons.length === 0,
      nonCanonicalReasons: diagnosticReasons,
      config: {
        seed: options.seed,
        seedHex: `0x${options.seed.toString(16)}`,
        count: options.count,
        vins: vinCount,
        quick: options.quick,
        severeExtras: options.severeExtras,
        severeExtrasDrawn: SEVERE_EXTRAS_DRAWN,
        layout: options.layout,
        layoutNote: LAYOUT_NOTES[options.layout],
        frame: options.layout === "frame" ? { width: FRAME_WIDTH, height: FRAME_HEIGHT } : null,
        tiers: options.tiers,
        symbologies: options.symbologies,
        paths: options.paths,
        appPath: app,
        pathNotes: DECODE_PATH_NOTES,
        browserPages: options.paths.some(isBrowserPath) ? options.browserPages : 0,
        chromium: provenance.executable,
        concurrency: CONCURRENCY,
        chunk: CHUNK,
        hints: { possibleFormats: BENCH_FORMAT_NAMES, hints: BENCH_HINT_NAMES },
        suppressedZxingWarnings: suppressedWarnings(),
      },
      thresholds: { decodeRate: THRESHOLDS, falseAccepts: FALSE_ACCEPT_THRESHOLD },
      totals: {
        attempts: attempts.length,
        appPathAttempts: scoped.length,
        hits: scoped.filter((a) => a.verdict === "hit").length,
        misses: scoped.filter((a) => a.verdict === "miss").length,
        falseAccepts: scoped.filter((a) => a.verdict === "false_accept").length,
        errors: scoped.filter((a) => a.verdict === "error").length,
        aimIdentifiersStripped: attempts.filter((a) => a.aimStripped).length,
      },
      cells,
      seedRuns: seedRuns.map((run) => ({ seed: run.seed, cells: run.cells })),
      // Quoted, never taken by this run (SB-11): the record, plus whether this run's
      // configuration still matches the one it was taken under.
      quoted: {
        sweep: RECORDED_SWEEP,
        drift: drift(RECORDED_SWEEP.config, options),
        thisRun: fingerprintOf(options),
      },
      // Taken by this run, on this run's instrument.
      collisionReplay: replays.map(({ collision, attempt }) => ({
        id: collision.id,
        expected: collision.vin,
        collisionReads: collision.wrong,
        verdict: attempt.verdict,
        extracted: attempt.extracted,
        decoded: attempt.decoded,
        layout: options.layout,
        path: attempt.path,
        seed: attempt.seed,
      })),
      seedBands: cells
        .filter((c) => c.path === app)
        .map((c) => ({
          symbology: c.symbology,
          tier: c.tier,
          decodeRate: c.decodeRate,
          estimated: seedBand(c),
          measured: measuredBand(c, seedRuns),
        })),
      timings,
      delta: delta.cells,
      disagreements: delta.disagreements,
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

/**
 * §13.6, judged on the app's path and nothing else — a threshold met by a decoder the
 * product does not ship is not met (B2). Faults and off-path false accepts still fail the
 * run, the first because an unmeasured frame is not a measured one, the second because a
 * wrong VIN out of any ZXing configuration on these frames is worth stopping for.
 */
function checkThresholds(
  allCells: readonly Cell[],
  attempts: readonly Attempt[],
  app: DecodePath,
): string[] {
  const failures: string[] = [];
  const cells = allCells.filter((c) => c.path === app);
  const scoped = attempts.filter((a) => a.path === app);

  const falseAccepts = scoped.filter((a) => a.verdict === "false_accept");
  if (falseAccepts.length > FALSE_ACCEPT_THRESHOLD) {
    failures.push(
      `false accepts: ${falseAccepts.length} (§13.6 requires ${FALSE_ACCEPT_THRESHOLD}) — ` +
        falseAccepts.map((a) => `${a.symbology}/${a.tier} ${a.vin} -> ${a.extracted}`).join("; "),
    );
  }

  const offPath = attempts.filter((a) => a.path !== app && a.verdict === "false_accept");
  if (offPath.length > 0) {
    failures.push(
      `false accepts off the app's path: ${offPath.length} — ` +
        offPath
          .map((a) => `${a.path} ${a.symbology}/${a.tier} ${a.vin} -> ${a.extracted}`)
          .join("; "),
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

/**
 * Why a run is not the canonical §13.6 run, or an empty list when it is.
 *
 * R2-E gave the tracked report a guard and keyed it on the three flags that had broken it —
 * `--quick`, `--severe-extras`, a non-app decode path. `--seed`, `--count`, `--tiers`,
 * `--symbologies` and `--paths` were not in it, so a diagnostic could and did overwrite
 * `bench/report.md` with a headline reading "**PASS** — every §13.6 threshold met." over
 * `Attempts | 2` (SB-6 — the fourth occurrence of the class, after the round-1 review's
 * N-01, R2-E itself and the Z1 commit message).
 *
 * So the guard is no longer a list of the flags that have burned someone. It is the
 * definition of the canonical run — exactly what `bun run bench` does with no further
 * arguments — and any deviation from it, through any flag, present or added later, sends
 * the output to the diagnostic paths. A new flag is non-canonical unless someone adds it
 * here deliberately, which is the opposite of the failure this keeps repeating.
 *
 * The reasons are returned rather than a bare boolean so the run can say out loud which
 * artifact it is writing and why, in stderr and in the report itself: a diagnostic that
 * announces itself cannot be mistaken for evidence later.
 */
function nonCanonicalReasons(options: Options, app: DecodePath): string[] {
  const reasons: string[] = [];
  if (options.quick) reasons.push("--quick");
  if (options.severeExtras !== null) {
    reasons.push(`--severe-extras ${options.severeExtras.join(",")} forces the severe tier`);
  }
  if (app !== APP_PATH) reasons.push(`the verdict path is ${app}, not the app's ${APP_PATH}`);
  if (options.layout !== CANONICAL_LAYOUT) {
    reasons.push(`--layout ${options.layout}, not the app's ${CANONICAL_LAYOUT} (SB-2)`);
  }
  if (options.seed !== DEFAULT_SEED) {
    reasons.push(`--seed 0x${options.seed.toString(16)}, not 0x${DEFAULT_SEED.toString(16)}`);
  }
  if (options.extraSeeds.length > 0) {
    reasons.push(`--seeds measured ${options.extraSeeds.length + 1} seeds, not 1 (SB-7)`);
  }
  if (options.count !== DEFAULT_COUNT) {
    reasons.push(`--count ${options.count}, not ${DEFAULT_COUNT}`);
  }
  if (options.tiers.length !== TIERS.length) {
    reasons.push(
      `--tiers ${options.tiers.join(",")}, not all ${TIERS.length} of ${TIERS.join(",")}`,
    );
  }
  if (options.symbologies.length !== BENCH_SYMBOLOGIES.length) {
    reasons.push(
      `--symbologies ${options.symbologies.join(",")}, not all ${BENCH_SYMBOLOGIES.length}`,
    );
  }
  if (options.paths.length !== DEFAULT_PATHS.length) {
    reasons.push(`--paths ${options.paths.join(",")}, not all of ${DEFAULT_PATHS.join(",")}`);
  }
  return reasons;
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

  const app = options.paths[0];
  process.stderr.write(
    `bench: seed 0x${options.seed.toString(16)}, ${options.count} VINs, ` +
      `${options.symbologies.length} symbologies, ${options.tiers.length} tiers\n` +
      `bench: severe extras — ${severeDraw(options)}\n` +
      `bench: decode paths — ${options.paths.join(", ")} (verdict from ${app})\n`,
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

  const needsBrowser = options.paths.some(isBrowserPath);
  let browser: BrowserDecoder | null = null;
  if (needsBrowser) {
    process.stderr.write(`bench: launching Chromium, ${options.browserPages} page(s)\n`);
    browser = await openBrowserDecoder({
      pages: options.browserPages,
      chromiumPath: options.chromiumPath,
    });
  }

  const executable = browser?.executable ?? null;
  let attempts: Attempt[];
  let pageErrors: readonly string[];
  // `--seeds`: the whole corpus again, once per further seed, so the report can state the
  // band a cell actually has instead of estimating it (SB-7). Same browser, same corpus, same
  // jobs — only the degradation seed moves, which is exactly the quantity being measured.
  const seedRuns: SeedRun[] = [];
  let replays: Replay[];
  try {
    attempts = await runAll(
      jobs,
      options.seed,
      options.severeExtras,
      options.paths,
      browser,
      options.layout,
    );
    for (const extraSeed of options.extraSeeds) {
      process.stderr.write(`bench: sweeping seed 0x${extraSeed.toString(16)} (SB-7)\n`);
      const extraAttempts = await runAll(
        jobs,
        extraSeed,
        options.severeExtras,
        options.paths,
        browser,
        options.layout,
      );
      seedRuns.push({
        seed: extraSeed,
        cells: summarise(extraAttempts, options.symbologies, options.tiers, app),
      });
      // A false accept at any seed is the headline, so the sweep's are folded into the run's
      // attempts rather than summarised away — §13.6's zero is a count over everything seen.
      attempts.push(...extraAttempts.filter((a) => a.verdict === "false_accept"));
    }
    // Two extra frames, on the same instrument, while it is still open: the recomputable
    // half of the quoted sweep (SB-11).
    replays = await replayCollisions(options, browser);
    // Read before `close()` disposes the pages that recorded them.
    pageErrors = browser?.pageErrors() ?? [];
  } finally {
    await browser?.close();
  }

  const cells = options.paths.flatMap((path) =>
    summarise(attempts, options.symbologies, options.tiers, path),
  );
  const timings: Timing[] = options.paths.flatMap((path) => {
    const scoped = attempts.filter((a) => a.path === path);
    return [
      timing(`${path}: all`, scoped),
      ...options.tiers.map((tier) =>
        timing(
          `${path}: ${tier}`,
          scoped.filter((a) => a.tier === tier),
        ),
      ),
    ];
  });
  const failures = checkThresholds(cells, attempts, app);
  // An uncaught error in the page means the bundle, not the barcode, decided the outcome.
  for (const message of pageErrors) failures.push(`browser page error: ${message}`);

  // A run that is not exactly `bun run bench` never writes the tracked full-corpus
  // artifacts — see `nonCanonicalReasons`. The reasons are printed, and carried into the
  // report, so a diagnostic can never be read later as evidence.
  const reasons = nonCanonicalReasons(options, app);
  const nonCanonical = reasons.length > 0;
  if (nonCanonical) {
    process.stderr.write(
      `bench: DIAGNOSTIC RUN — ${reasons.join("; ")}\n` +
        `bench: the tracked §13.6 artifacts are untouched; writing ${QUICK_REPORT_PATH}\n`,
    );
  }

  await writeFile(
    nonCanonical ? QUICK_REPORT_PATH : REPORT_PATH,
    markdownReport(
      options,
      { executable },
      cells,
      timings,
      attempts,
      vinCount,
      failures,
      reasons,
      seedRuns,
      replays,
    ),
    "utf8",
  );
  const jsonPath =
    options.json === null
      ? null
      : nonCanonical
        ? options.json.replace(/\.json$/, QUICK_JSON_SUFFIX)
        : options.json;

  if (jsonPath !== null) {
    await writeFile(
      resolve(process.cwd(), jsonPath),
      jsonReport(
        options,
        { executable },
        cells,
        timings,
        attempts,
        vinCount,
        failures,
        reasons,
        seedRuns,
        replays,
      ),
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
  lines.push(`  decode path: ${app} (${options.paths.join(" + ")} measured)`);
  lines.push(`  frame:       ${options.layout} — ${LAYOUT_NOTES[options.layout]}`);
  lines.push("");
  const width = Math.max(...options.symbologies.map((s) => s.length));
  const column = 30;
  lines.push(
    `  ${"symbology".padEnd(width)}  ` +
      options.tiers.map((t) => `${t} (>=${pct(THRESHOLDS[t])})`.padEnd(column)).join(""),
  );
  for (const symbology of options.symbologies) {
    const row = options.tiers.map((tier) => {
      const cell = cells.find(
        (c) => c.path === app && c.symbology === symbology && c.tier === tier,
      );
      if (cell === undefined) return "-".padEnd(column);
      return `${pct(cell.decodeRate)} ${cell.pass ? "PASS" : "FAIL"} ${margin(cell)} ${bandLabel(cell, seedRuns)}`.padEnd(
        column,
      );
    });
    lines.push(`  ${symbology.padEnd(width)}  ${row.join("")}`);
  }
  lines.push("");
  lines.push(
    seedRuns.length > 0
      ? `  seed band: measured over ${seedRuns.length + 1} seeds (SB-7)`
      : "  seed band: estimated, 95% Wilson on this run's own sample; `exact` = the clean" +
          " tier applies no randomness (SB-7)",
  );
  lines.push("");
  const falseAccepts = attempts.filter((a) => a.verdict === "false_accept");
  lines.push(
    `  false accepts: ${falseAccepts.filter((a) => a.path === app).length} on ${app} ` +
      `(threshold ${FALSE_ACCEPT_THRESHOLD}) ` +
      `${falseAccepts.length === 0 ? "OK" : "BLOCKER (§13.3 S1)"}`,
  );
  for (const a of falseAccepts) {
    lines.push(`    [${a.path}] ${a.symbology}/${a.tier}: expected ${a.vin}, got ${a.extracted}`);
    lines.push(`      decoded ${JSON.stringify(a.decoded)} as ${a.format}`);
    lines.push(`      ${reproduce(a)}`);
  }
  // The recomputed half of the quoted sweep (SB-11), in one line.
  const reproduced = replays.filter((r) => r.attempt.verdict === "false_accept");
  lines.push(
    `  collision replay: ${replays.length - reproduced.length}/${replays.length} read as ` +
      `nothing on ${options.layout}/${app}` +
      (reproduced.length === 0
        ? " (R4-F, SB-1 — recorded frames, not corpus attempts)"
        : ` — ${reproduced.map((r) => r.collision.id).join(", ")} REPRODUCES A WRONG VIN`),
  );
  // What the instrument change was worth, in one line, on the same frames.
  for (const path of options.paths.slice(1)) {
    const appHits = attempts.filter((a) => a.path === app && a.verdict === "hit").length;
    const otherHits = attempts.filter((a) => a.path === path && a.verdict === "hit").length;
    const of = attempts.filter((a) => a.path === app).length;
    lines.push(
      `  delta vs ${path}: ${appHits} vs ${otherHits} correct of ${of} ` +
        `(${appHits - otherHits >= 0 ? "+" : ""}${appHits - otherHits} frames, ` +
        `${(((appHits - otherHits) / Math.max(1, of)) * 100).toFixed(2)} pp)`,
    );
  }
  const all = timings[0];
  lines.push(`  decode time (${all.scope}): mean ${ms(all.meanMs)} ms, p95 ${ms(all.p95Ms)} ms`);
  lines.push(
    `  report: ${nonCanonical ? QUICK_REPORT_PATH : REPORT_PATH}` +
      (nonCanonical ? `  (diagnostic — ${reasons.join("; ")})` : "  (canonical §13.6 evidence)"),
  );
  if (jsonPath !== null) lines.push(`  json:   ${resolve(process.cwd(), jsonPath)}`);
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
