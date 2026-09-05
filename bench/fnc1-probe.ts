/**
 * §13.4 scan-robustness probe — **what a leading FNC1 costs**, and what §4.6's AIM strip
 * buys. `bun run bench/fnc1-probe.ts`.
 *
 * §13.7's R5 list holds three questions only a photographed label can answer. This probe
 * answers the *cost* half of question (b) — "whether any Code 128 label sets a **leading**
 * FNC1, which `]C1` makes §4.2 refuse" — by rendering the shape and measuring it.
 *
 * The tracked corpus cannot: `bench/report.md`'s header has read **"reads carrying the §4.6
 * AIM identifier: 0"** since the strip shipped, because no row in `BENCH_SYMBOLOGIES` opens
 * with FNC1. `stripAimIdentifier` is on the app's scan path (`readScanResult`) and on the
 * bench's decode path, and until this probe existed nothing in the §13.5 gate had ever put
 * a byte through it from a real decode.
 *
 * Four rows, same VINs, same tiers, same seeds as `bench/run.ts`:
 *
 * - `code_128`            — the plain VIN label. The control.
 * - `code_128_fnc1`       — VIN, FNC1, a `1P` part number. A *separating* FNC1 only.
 * - `code_128_fnc1_lead`  — FNC1, VIN. The R5 regression shape.
 * - `code_128_fnc1_lead2` — FNC1, VIN, FNC1, a `1P` part number. A GS1-128 with two fields.
 *
 * Each decode is scored twice off the same bytes:
 *
 * - `shipped`    — `extractVin` over the text the app sees, `]C1` already removed (§4.6).
 * - `unstripped` — `extractVin` over the text with `]C1` put back, i.e. what §4.2 saw before
 *                  `stripAimIdentifier` existed. The delta is the value of the strip, in
 *                  reads, on frames that are not otherwise contrived.
 *
 * Determinism: `run.ts`'s seed derivation, no clock read that reaches a decode. Writes
 * nothing — it prints, so it can never overwrite the tracked §13.6 evidence.
 *
 * Synthetic is not real (§13.4, §13.7). How many labels carry this shape stays §7 item 4.
 */

import type { Buffer } from "node:buffer";
import process from "node:process";
import { extractVin } from "../src/lib/vin/extractVin";
import { CODE_128_GS1_IDENTIFIER } from "../src/lib/vin/symbologies";
import { corpusVins, renderBarcode } from "./corpus";
import type { BenchSymbology } from "./corpus";
import { openBrowserDecoder } from "./browser-decode";
import { TIERS, degrade, severeExtrasFor } from "./degrade";
import type { Tier } from "./degrade";

/** The control, the shipped variant row, and the two leading-FNC1 shapes. */
const ROWS: readonly BenchSymbology[] = [
  "code_128",
  "code_128_fnc1",
  "code_128_fnc1_lead",
  "code_128_fnc1_lead2",
];

/** Same default as `run.ts`, so a probe row and a bench row are the same pixels. */
const DEFAULT_SEED = 0x5eed_1a7c;

const DEFAULT_COUNT = 60;

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

interface Attempt {
  vin: string;
  symbology: BenchSymbology;
  tier: Tier;
  seed: number;
  /** Did anything decode at all — before §4.2 had an opinion. */
  decoded: boolean;
  aimStripped: boolean;
  /** The VIN §4.2 named from the bytes the app sees. */
  shipped: string | null;
  /** The VIN §4.2 would have named with `]C1` still on the front. */
  unstripped: string | null;
  text: string | null;
}

interface Options {
  count: number;
  seed: number;
  tiers: Tier[];
  chromiumPath: string | null;
  pages: number;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    count: DEFAULT_COUNT,
    seed: DEFAULT_SEED,
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

function rate(hits: number, attempts: number): string {
  return attempts === 0 ? "-" : `${((hits / attempts) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const vins = corpusVins(options.count);

  process.stderr.write(`fnc1-probe: rendering ${vins.length * ROWS.length} symbols\n`);
  const rendered = new Map<string, Buffer>();
  for (const symbology of ROWS) {
    for (const vin of vins) {
      rendered.set(`${vin}|${symbology}`, await renderBarcode(vin, symbology));
    }
  }

  const decoder = await openBrowserDecoder({
    pages: options.pages,
    chromiumPath: options.chromiumPath,
  });

  const attempts: Attempt[] = [];
  try {
    for (const tier of options.tiers) {
      for (const symbology of ROWS) {
        const frames: Buffer[] = [];
        const keys: Array<{ vin: string; seed: number }> = [];
        for (const vin of vins) {
          const seed = attemptSeed(options.seed, vin, symbology, tier);
          const png = rendered.get(`${vin}|${symbology}`);
          if (png === undefined) throw new Error(`fnc1-probe: no render for ${vin} ${symbology}`);
          frames.push(
            await degrade(png, tier, seed, tier === "severe" ? severeExtrasFor(seed) : undefined),
          );
          keys.push({ vin, seed });
        }
        const outcomes = await decoder.decode(frames, "canvas");
        for (let i = 0; i < outcomes.length; i += 1) {
          const outcome = outcomes[i];
          const { vin, seed } = keys[i];
          const shipped = outcome.text === null ? null : extractVin(outcome.text);
          const withIdentifier =
            outcome.text === null
              ? null
              : outcome.aimStripped
                ? `${CODE_128_GS1_IDENTIFIER}${outcome.text}`
                : outcome.text;
          const unstripped = withIdentifier === null ? null : extractVin(withIdentifier);
          attempts.push({
            vin,
            symbology,
            tier,
            seed,
            decoded: outcome.text !== null,
            aimStripped: outcome.aimStripped,
            shipped: shipped?.vin ?? null,
            unstripped: unstripped?.vin ?? null,
            text: outcome.text,
          });
        }
        process.stderr.write(`fnc1-probe: ${symbology} ${tier} done\n`);
      }
    }
  } finally {
    await decoder.close();
  }

  process.stdout.write(`\n# fnc1-probe — the leading FNC1 and §4.6's AIM strip\n\n`);
  process.stdout.write(
    `seed 0x${options.seed.toString(16)} · ${vins.length} VINs · decode path canvas · ` +
      `hints §4.6 (TRY_HARDER, ASSUME_GS1)\n\n`,
  );

  process.stdout.write(`## Correct VIN, end to end\n\n`);
  process.stdout.write(`| row | tier | decoded | \`]C1\` seen | shipped (§4.6 strip) | `);
  process.stdout.write(`unstripped (no strip) | Δ |\n`);
  process.stdout.write(`|---|---|---:|---:|---:|---:|---:|\n`);
  for (const symbology of ROWS) {
    for (const tier of options.tiers) {
      const scoped = attempts.filter((a) => a.symbology === symbology && a.tier === tier);
      if (scoped.length === 0) continue;
      const decoded = scoped.filter((a) => a.decoded).length;
      const aim = scoped.filter((a) => a.aimStripped).length;
      const shipped = scoped.filter((a) => a.shipped === a.vin).length;
      const unstripped = scoped.filter((a) => a.unstripped === a.vin).length;
      process.stdout.write(
        `| ${symbology} | ${tier} | ${rate(decoded, scoped.length)} | ${aim} | ` +
          `${rate(shipped, scoped.length)} | ${rate(unstripped, scoped.length)} | ` +
          `${shipped - unstripped >= 0 ? "+" : ""}${shipped - unstripped} |\n`,
      );
    }
  }

  process.stdout.write(`\n## Totals\n\n`);
  for (const symbology of ROWS) {
    const scoped = attempts.filter((a) => a.symbology === symbology);
    const shipped = scoped.filter((a) => a.shipped === a.vin).length;
    const unstripped = scoped.filter((a) => a.unstripped === a.vin).length;
    const aim = scoped.filter((a) => a.aimStripped).length;
    process.stdout.write(
      `- ${symbology}: shipped ${shipped}/${scoped.length} (${rate(shipped, scoped.length)}), ` +
        `unstripped ${unstripped}/${scoped.length} (${rate(unstripped, scoped.length)}), ` +
        `\`]C1\` on ${aim} reads\n`,
    );
  }

  const falseAccepts = attempts.filter((a) => a.shipped !== null && a.shipped !== a.vin);
  process.stdout.write(`\n## False accepts (§13.6 requires 0): ${falseAccepts.length}\n`);
  if (falseAccepts.length > 0) {
    process.stdout.write(`\n| expected | returned | row | tier | text | seed |\n`);
    process.stdout.write(`|---|---|---|---|---|---|\n`);
    for (const a of falseAccepts) {
      process.stdout.write(
        `| \`${a.vin}\` | \`${a.shipped ?? ""}\` | ${a.symbology} | ${a.tier} | ` +
          `\`${a.text ?? ""}\` | 0x${a.seed.toString(16)} |\n`,
      );
    }
  }

  const unstrippedFalse = attempts.filter((a) => a.unstripped !== null && a.unstripped !== a.vin);
  process.stdout.write(
    `\nFalse accepts §4.2 would have made without the strip: ${unstrippedFalse.length}\n`,
  );

  const firstLead = attempts.find((a) => a.symbology === "code_128_fnc1_lead" && a.decoded);
  if (firstLead !== undefined) {
    process.stdout.write(
      `\nSample leading-FNC1 read: \`${firstLead.text ?? ""}\` ` +
        `(\`]C1\` ${firstLead.aimStripped ? "was" : "was NOT"} present)\n`,
    );
  }
}

await main();
