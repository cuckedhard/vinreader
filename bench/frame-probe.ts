/**
 * §13.4 scan-robustness probe — **what the frame around the symbol costs**, and what an ROI
 * crop would buy back. `bun run bench/frame-probe.ts`.
 *
 * This probe is the evidence behind SB-2 and SB-3. The main bench used to hand ZXing a
 * tightly-cropped barcode — a ~1050 px symbol in a ~1100 px image, quiet zone and nothing
 * else — which the app never sees; since SB-2 it composites the frame instead, using this
 * file's `./frame` module, so the `frame` column below is now the bench's own layout and the
 * `crop` column is what the bench measured before. `useScanner` calls
 * `decodeFromStream`, and `@zxing/browser` draws the whole `<video>` frame onto its capture
 * canvas at `videoWidth × videoHeight` — 1920×1080 under §6.3's `ideal` constraints — so the
 * symbol is a band across a mostly-empty field. §6.1 even draws a guide box over the preview
 * (`CameraView.tsx`: `h-[22%] w-[90%]`) telling the user where to put the label, and nothing
 * downstream uses it: the decoder is offered every pixel.
 *
 * This probe measures that difference on identical symbol pixels. One degraded frame per
 * (VIN, symbology, tier) — the same seed arithmetic `run.ts` uses, so the pixels are the
 * bench's pixels — decoded three ways:
 *
 * - `crop`  — the degraded image alone. What the main bench measured before SB-2.
 * - `frame` — the same pixels composited, unscaled and centred, onto a white 1920×1080
 *             field. What the app hands ZXing.
 * - `roi`   — that frame, cropped back to a centred guide-box band. What the app would hand
 *             ZXing if it cropped to the box it already draws.
 *
 * The symbol is never resampled: `frame` and `roi` carry byte-identical symbol pixels to
 * `crop`, so any difference between the three columns is the *frame*, not the degradation.
 *
 * Determinism: same seed derivation as `run.ts`, no clock read that reaches a decode, no
 * unseeded randomness. Decode wall time is the one output that moves between runs, and it is
 * reported because it is the point — §6.3 confirms on two agreeing reads inside a 1.5 s
 * window, so how many frames fit in that window is a scan-robustness number.
 *
 * Writes nothing. It prints, so it can never overwrite the tracked §13.6 evidence.
 *
 * Synthetic is not real (§13.4, §13.7): this bounds hints, ROI and confirmation logic. It
 * does not close §7 item 4.
 */

import type { Buffer } from "node:buffer";
import process from "node:process";
import { extractVin } from "../src/lib/vin/extractVin";
import { BENCH_SYMBOLOGIES, buildCorpus } from "./corpus";
import type { BenchSymbology, CorpusItem } from "./corpus";
import { openBrowserDecoder } from "./browser-decode";
import type { BrowserDecoder } from "./browser-decode";
import { TIERS, degrade, severeExtrasFor } from "./degrade";
import type { Tier } from "./degrade";
import {
  FRAME_HEIGHT,
  FRAME_WIDTH,
  GUIDE_HEIGHT_FRACTION,
  GUIDE_WIDTH_FRACTION,
  TALL_GUIDE_HEIGHT_FRACTION,
  composite,
  cropBand,
} from "./frame";

/**
 * The frame, the guide-box fractions and the compositing all live in `./frame`, which
 * `run.ts` now imports too (SB-2): the bench composites every frame it measures, so this
 * probe and the bench must not carry two definitions of the same field.
 */

/** Same default as `run.ts`, so a probe row can be compared with a bench row directly. */
const DEFAULT_SEED = 0x5eed_1a7c;

/** Smaller than the bench's 200: three layouts per frame, and the point is the ratio. */
const DEFAULT_COUNT = 40;

type Layout = "crop" | "frame" | "roi" | "roi_tall";

const LAYOUTS: readonly Layout[] = ["crop", "frame", "roi", "roi_tall"];

const LAYOUT_NOTES: Readonly<Record<Layout, string>> = {
  crop: "the degraded image alone — what bench/run.ts measured before SB-2",
  frame: `centred, unscaled, on a white ${FRAME_WIDTH}x${FRAME_HEIGHT} field — what the app decodes`,
  roi: `that frame cropped to §6.1's guide box (${GUIDE_WIDTH_FRACTION * 100}% x ${GUIDE_HEIGHT_FRACTION * 100}%)`,
  roi_tall: `that frame cropped to a taller band (${GUIDE_WIDTH_FRACTION * 100}% x ${TALL_GUIDE_HEIGHT_FRACTION * 100}%)`,
};

interface Attempt {
  vin: string;
  symbology: BenchSymbology;
  tier: Tier;
  layout: Layout;
  seed: number;
  /** The symbol's width as a fraction of the frame — how far away the label is, in effect. */
  fill: number;
  hit: boolean;
  falseAccept: boolean;
  returned: string | null;
  text: string | null;
  ms: number;
  fault: string | null;
}

/** `run.ts`'s seed derivation, so a probe frame is a bench frame. */
function attemptSeed(runSeed: number, vin: string, symbology: BenchSymbology, tier: Tier): number {
  return (runSeed ^ fnv1a(`${vin}|${symbology}|${tier}`)) >>> 0;
}

function fnv1a(text: string): number {
  let hash = 0x811c_9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x0100_0193);
  }
  return hash >>> 0;
}

interface Variant {
  layout: Layout;
  png: Buffer;
  fill: number;
}

async function variantsFor(degraded: Buffer): Promise<Variant[]> {
  const framed = await composite(degraded);
  const fill = framed.fill;
  return [
    { layout: "crop", png: degraded, fill },
    { layout: "frame", png: framed.png, fill },
    { layout: "roi", png: await cropBand(framed.png, GUIDE_HEIGHT_FRACTION), fill },
    { layout: "roi_tall", png: await cropBand(framed.png, TALL_GUIDE_HEIGHT_FRACTION), fill },
  ];
}

interface Cell {
  symbology: BenchSymbology;
  tier: Tier;
  layout: Layout;
  attempts: number;
  hits: number;
  falseAccepts: number;
  meanMs: number;
  meanFill: number;
}

function summarise(attempts: readonly Attempt[]): Cell[] {
  const cells: Cell[] = [];
  for (const symbology of BENCH_SYMBOLOGIES) {
    for (const tier of TIERS) {
      for (const layout of LAYOUTS) {
        const scoped = attempts.filter(
          (a) => a.symbology === symbology && a.tier === tier && a.layout === layout,
        );
        if (scoped.length === 0) continue;
        cells.push({
          symbology,
          tier,
          layout,
          attempts: scoped.length,
          hits: scoped.filter((a) => a.hit).length,
          falseAccepts: scoped.filter((a) => a.falseAccept).length,
          meanMs: scoped.reduce((sum, a) => sum + a.ms, 0) / scoped.length,
          meanFill: scoped.reduce((sum, a) => sum + a.fill, 0) / scoped.length,
        });
      }
    }
  }
  return cells;
}

function pct(hits: number, attempts: number): string {
  return attempts === 0 ? "-" : `${((hits / attempts) * 100).toFixed(1)}%`;
}

interface Options {
  count: number;
  seed: number;
  symbologies: BenchSymbology[];
  tiers: Tier[];
  chromiumPath: string | null;
  pages: number;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    count: DEFAULT_COUNT,
    seed: DEFAULT_SEED,
    symbologies: [...BENCH_SYMBOLOGIES],
    tiers: [...TIERS],
    chromiumPath: null,
    pages: 4,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const read = (): string => {
      if (eq !== -1) return arg.slice(eq + 1);
      i += 1;
      if (i >= argv.length) throw new Error(`${flag}: expected a value`);
      return argv[i];
    };
    switch (flag) {
      case "--count":
        options.count = Number(read());
        break;
      case "--seed": {
        const raw = read();
        options.seed = (raw.startsWith("0x") ? Number.parseInt(raw, 16) : Number(raw)) >>> 0;
        break;
      }
      case "--symbologies":
        options.symbologies = read()
          .split(",")
          .map((name) => {
            const found = BENCH_SYMBOLOGIES.find((s) => s === name);
            if (found === undefined) throw new Error(`--symbologies: unknown ${name}`);
            return found;
          });
        break;
      case "--tiers":
        options.tiers = read()
          .split(",")
          .map((name) => {
            const found = TIERS.find((t) => t === name);
            if (found === undefined) throw new Error(`--tiers: unknown ${name}`);
            return found;
          });
        break;
      case "--chromium":
        options.chromiumPath = read();
        break;
      case "--pages":
        options.pages = Number(read());
        break;
      default:
        throw new Error(`unknown flag ${JSON.stringify(arg)}`);
    }
  }
  return options;
}

async function decodeVariants(
  decoder: BrowserDecoder,
  variants: readonly Variant[],
): Promise<Array<{ text: string | null; ms: number; fault: string | null }>> {
  const outcomes = await decoder.decode(
    variants.map((v) => v.png),
    "canvas",
  );
  return outcomes.map((o) => ({ text: o.text, ms: o.ms, fault: o.fault }));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const corpus = (await buildCorpus(options.count)).filter((item: CorpusItem) =>
    options.symbologies.includes(item.symbology),
  );

  const decoder = await openBrowserDecoder({
    pages: options.pages,
    chromiumPath: options.chromiumPath,
  });

  const attempts: Attempt[] = [];
  try {
    for (const tier of options.tiers) {
      for (const item of corpus) {
        const seed = attemptSeed(options.seed, item.vin, item.symbology, tier);
        const degraded = await degrade(
          item.png,
          tier,
          seed,
          tier === "severe" ? severeExtrasFor(seed) : undefined,
        );
        const variants = await variantsFor(degraded);
        const outcomes = await decodeVariants(decoder, variants);
        for (let i = 0; i < variants.length; i += 1) {
          const variant = variants[i];
          const outcome = outcomes[i];
          const returned = outcome.text === null ? null : extractVin(outcome.text);
          attempts.push({
            vin: item.vin,
            symbology: item.symbology,
            tier,
            layout: variant.layout,
            seed,
            fill: variant.fill,
            hit: returned?.vin === item.vin,
            falseAccept: returned !== null && returned.vin !== item.vin,
            returned: returned?.vin ?? null,
            text: outcome.text,
            ms: outcome.ms,
            fault: outcome.fault,
          });
        }
      }
      process.stderr.write(`frame-probe: ${tier} done (${attempts.length} attempts)\n`);
    }
  } finally {
    await decoder.close();
  }

  const cells = summarise(attempts);

  process.stdout.write(`\n# frame-probe — the frame around the symbol (§13.4 ROI)\n\n`);
  process.stdout.write(`seed 0x${options.seed.toString(16)} · ${options.count} VINs · `);
  process.stdout.write(`frame ${FRAME_WIDTH}x${FRAME_HEIGHT} · decode path canvas\n\n`);
  for (const layout of LAYOUTS) {
    process.stdout.write(`- \`${layout}\` — ${LAYOUT_NOTES[layout]}\n`);
  }

  process.stdout.write(`\n## Decode rate\n\n`);
  process.stdout.write(`| symbology | tier | fill | ${LAYOUTS.join(" | ")} |\n`);
  process.stdout.write(`|---|---|---:|${LAYOUTS.map(() => "---:").join("|")}|\n`);
  for (const symbology of options.symbologies) {
    for (const tier of options.tiers) {
      const row = LAYOUTS.map((layout) => {
        const cell = cells.find(
          (c) => c.symbology === symbology && c.tier === tier && c.layout === layout,
        );
        return cell === undefined ? "-" : pct(cell.hits, cell.attempts);
      });
      const fillCell = cells.find((c) => c.symbology === symbology && c.tier === tier);
      const fill = fillCell === undefined ? "-" : `${(fillCell.meanFill * 100).toFixed(0)}%`;
      process.stdout.write(`| ${symbology} | ${tier} | ${fill} | ${row.join(" | ")} |\n`);
    }
  }

  process.stdout.write(`\n## Mean decode time (ms)\n\n`);
  process.stdout.write(`| symbology | tier | ${LAYOUTS.join(" | ")} |\n`);
  process.stdout.write(`|---|---|${LAYOUTS.map(() => "---:").join("|")}|\n`);
  for (const symbology of options.symbologies) {
    for (const tier of options.tiers) {
      const row = LAYOUTS.map((layout) => {
        const cell = cells.find(
          (c) => c.symbology === symbology && c.tier === tier && c.layout === layout,
        );
        return cell === undefined ? "-" : cell.meanMs.toFixed(1);
      });
      process.stdout.write(`| ${symbology} | ${tier} | ${row.join(" | ")} |\n`);
    }
  }

  process.stdout.write(`\n## Totals\n\n`);
  for (const layout of LAYOUTS) {
    const scoped = attempts.filter((a) => a.layout === layout);
    const hits = scoped.filter((a) => a.hit).length;
    const falseAccepts = scoped.filter((a) => a.falseAccept).length;
    const meanMs = scoped.reduce((sum, a) => sum + a.ms, 0) / Math.max(scoped.length, 1);
    process.stdout.write(
      `- ${layout}: ${hits}/${scoped.length} (${pct(hits, scoped.length)}), ` +
        `${falseAccepts} false accepts, mean ${meanMs.toFixed(1)} ms\n`,
    );
  }

  const falseAccepts = attempts.filter((a) => a.falseAccept);
  if (falseAccepts.length > 0) {
    process.stdout.write(`\n## FALSE ACCEPTS (§13.6 requires 0)\n\n`);
    process.stdout.write(`| expected | returned | symbology | tier | layout | text | seed |\n`);
    process.stdout.write(`|---|---|---|---|---|---|---|\n`);
    for (const attempt of falseAccepts) {
      process.stdout.write(
        `| \`${attempt.vin}\` | \`${attempt.returned ?? ""}\` | ${attempt.symbology} | ` +
          `${attempt.tier} | ${attempt.layout} | \`${attempt.text ?? ""}\` | ` +
          `0x${attempt.seed.toString(16)} |\n`,
      );
    }
  }

  const faults = attempts.filter((a) => a.fault !== null);
  if (faults.length > 0) {
    process.stdout.write(`\n${faults.length} decoder faults; first: ${faults[0].fault ?? ""}\n`);
  }
}

await main();
