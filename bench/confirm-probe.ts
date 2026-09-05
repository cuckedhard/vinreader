/**
 * §13.4 run (b) — **mean time-to-confirm**, measured against the real §6.3 state machine.
 * `bun run bench/confirm-probe.ts`.
 *
 * §13.4 asks the bench to report three things: decode rate per symbology × tier, false
 * accepts, and **mean time-to-confirm**. `bench/run.ts` measures the first two and says so
 * plainly — it decodes one frame at a time, and confirmation is not a property of one frame.
 * §6.3 confirms on *two agreeing reads inside a 1.5 s window*, so the number §13.4 wants is a
 * property of a stream: how long a person has to hold the phone still before the app agrees
 * with itself. This is the run that measures it.
 *
 * How. A y4m is built from the §13.4 corpus — the same VIN, the same symbology, the same
 * degradation tier, at `FRAMES` distinct seeds so the loop presents distinct poses rather
 * than one image repeated (a repeated image confirms on the second frame by construction and
 * measures nothing). Each frame is centred on a 1920×1080 white field, which is what §6.3's
 * `VIDEO_CONSTRAINTS` ask the camera for. Chromium is launched with
 * `--use-fake-device-for-media-stream --use-file-for-fake-video-capture=<that file>`, the
 * built app is served from loopback (a secure context, so `getUserMedia` and
 * `crypto.randomUUID` both work), and the clock runs from the first frame the `<video>`
 * element can supply to the hash change that only §6.3's `confirmed` transition performs.
 *
 * Each repeat gets a **fresh browser context**: §6.3's 10 s cooldown is keyed by VIN and
 * outlives the component, so a second scan of the same label in the same profile would be
 * suppressed and would measure the cooldown instead of the confirmation.
 *
 * What it is not. A y4m loop is not a hand: the frame rate is fixed, the poses repeat in the
 * same order, and no one is moving the phone toward the label. Synthetic is not real (§13.4,
 * §13.7) — this bounds the confirmation logic and does not close §7 item 4.
 *
 * **Retries** (SB-5). A Chromium launch is harness, not measurement: one flaked at
 * Playwright's default launch timeout during the first run of this probe, and a launch that
 * never happened is not a scan that never confirmed. Launches are therefore retried, with an
 * explicit timeout, and so is a repeat whose `<video>` never reaches `HAVE_CURRENT_DATA` —
 * the fake capture device failing to start. A `waitForURL` that times out is **never**
 * retried: that one is the measurement, and retrying it would quietly delete the slowest
 * cases from the mean. Faults and non-confirmations are reported as different things for the
 * same reason.
 *
 * Writes its own artifact — `bench/confirm.json`, the recorded run §13.4's report quotes for
 * mean time-to-confirm — and its temporary y4m, which it deletes. It never writes
 * `bench/report.md` or `bench/report.json`, so it cannot touch the §13.6 evidence.
 */

import { Buffer } from "node:buffer";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cpus, loadavg, tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { chromium } from "@playwright/test";
import type { Browser } from "@playwright/test";
import { renderBarcode } from "./corpus";
import type { BenchSymbology } from "./corpus";
import { resolveChromium } from "./browser-decode";
import { CONFIRM_RECORD_PATH } from "./confirm-record";
import type { ConfirmCell, ConfirmRecord, Measurement, Outcome } from "./confirm-record";
import { gitProvenance } from "./provenance";
import { TIERS, degrade, severeExtrasFor } from "./degrade";
import type { Tier } from "./degrade";

/** §6.3's `VIDEO_CONSTRAINTS` ideal, so Chromium delivers the file unscaled. */
const WIDTH = 1920;
const HEIGHT = 1080;

/** White: a label's surround is white, and the binarizer must not be handed a dark field. */
const PAPER = 0xff;

/** `run.ts`'s default, so a frame here is a frame there. */
const RUN_SEED = 0x5eed_1a7c;

/**
 * Distinct degraded poses in the loop. Chromium loops the file, so this is the period of the
 * scene. Twelve at 10 fps is 1.2 s of distinct footage — under §6.3's 1.5 s window, so a
 * confirmation cannot come from the loop wrapping onto the identical frame within one window
 * unless the reads genuinely agree.
 */
const FRAMES = 12;

/** Frame rate of the fake capture. Low, because each frame is 3.1 MB of I420. */
const FPS = 10;

/** Give up on a case rather than hanging: §6.3 has no deadline, but this probe must. */
const TIMEOUT_MS = 25_000;

/**
 * Launching Chromium is not part of what this probe measures, so it gets an explicit budget
 * and retries (SB-5). Playwright's own default is a test-runner default and this is not a
 * test; a launch that fails here used to be indistinguishable from a scan that never
 * confirmed.
 */
const LAUNCH_TIMEOUT_MS = 120_000;
const LAUNCH_ATTEMPTS = 3;

/**
 * A repeat whose `<video>` never reaches `HAVE_CURRENT_DATA` never got a frame, so it
 * measured nothing. That is retried. A repeat that got frames and did not confirm is a
 * result and is not.
 */
const VIDEO_ATTEMPTS = 3;

/** The §4.11 fixture the e2e fake-camera fixture already uses, so the two are comparable. */
const DEFAULT_VIN = "1HGCM82633A004352";

/** Door-jamb reality: the ANSI `I`-prefixed Code 39 label, and the Code 128 one. */
const DEFAULT_SYMBOLOGIES: readonly BenchSymbology[] = ["code_39_i", "code_128"];

const DEFAULT_REPEATS = 5;

/**
 * The build under test. Overridable with `--dist` so the probe can be pointed at a build
 * made from a clean checkout of a commit rather than at whatever the working tree happens to
 * contain: a time-to-confirm number is a number about a *program*, and a program that exists
 * in no commit cannot be quoted later (SB-5, SB-11).
 */
const DIST = fileURLToPath(new URL("../dist", import.meta.url));

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function fnv1a(text: string): number {
  let hash = 0x811c_9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x0100_0193);
  }
  return hash >>> 0;
}

/**
 * `run.ts`'s seed, with the frame index folded in so the loop carries distinct poses of the
 * same label rather than one image repeated. Frame 0 is exactly the bench's frame.
 */
function seedFor(vin: string, symbology: BenchSymbology, tier: Tier, frame: number): number {
  const base = (RUN_SEED ^ fnv1a(`${vin}|${symbology}|${tier}`)) >>> 0;
  return frame === 0 ? base : (base ^ fnv1a(`frame|${frame}`)) >>> 0;
}

/** Centre a degraded frame, unscaled, on a white 1920×1080 luma plane. */
async function padded(png: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  if (info.width > WIDTH || info.height > HEIGHT) {
    throw new Error(
      `confirm-probe: frame ${info.width}x${info.height} does not fit ${WIDTH}x${HEIGHT}`,
    );
  }
  const luma = Buffer.alloc(WIDTH * HEIGHT, PAPER);
  const left = (WIDTH - info.width) >> 1;
  const top = (HEIGHT - info.height) >> 1;
  for (let y = 0; y < info.height; y += 1) {
    data.copy(luma, (top + y) * WIDTH + left, y * info.width, (y + 1) * info.width);
  }
  return luma;
}

/** `C420` YUV4MPEG2, the shape `make-fake-camera.py` and `camera-probe.ts` both write. */
function y4m(frames: readonly Buffer[]): Buffer {
  const chroma = Buffer.alloc((WIDTH / 2) * (HEIGHT / 2), 0x80);
  const parts: Buffer[] = [Buffer.from(`YUV4MPEG2 W${WIDTH} H${HEIGHT} F${FPS}:1 Ip A1:1 C420\n`)];
  for (const frame of frames) parts.push(Buffer.from("FRAME\n"), frame, chroma, chroma);
  return Buffer.concat(parts);
}

interface Server {
  origin: string;
  close: () => Promise<void>;
}

/**
 * Serve the built app from loopback. `http://127.0.0.1` is a *potentially trustworthy*
 * origin, so `isSecureContext` is true and both `getUserMedia` and `crypto.randomUUID`
 * behave as they do on the phone (R3-L is about the non-loopback case, which this is not).
 * The port is ephemeral, so the probe can never collide with a dev or preview server.
 */
async function serve(root: string): Promise<Server> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = resolve(join(root, rel));
    if (!file.startsWith(root) || !existsSync(file) || rel === "/") file = join(root, "index.html");
    response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((done, fail) =>
        server.close((error) => (error === undefined ? done() : fail(error))),
      ),
  };
}

interface Options {
  vin: string;
  symbologies: BenchSymbology[];
  tiers: Tier[];
  repeats: number;
  chromiumPath: string | null;
  /** The `dist/` served to Chromium, and the tree whose provenance is recorded. */
  dist: string;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    vin: DEFAULT_VIN,
    symbologies: [...DEFAULT_SYMBOLOGIES],
    tiers: [...TIERS],
    repeats: DEFAULT_REPEATS,
    chromiumPath: null,
    dist: DIST,
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
      case "--vin":
        options.vin = read();
        break;
      case "--repeats":
        options.repeats = Number(read());
        break;
      case "--symbologies":
        options.symbologies = read().split(",") as BenchSymbology[];
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
      case "--dist":
        options.dist = resolve(read());
        break;
      case "--chromium":
        options.chromiumPath = read();
        break;
      default:
        throw new Error(`unknown flag ${JSON.stringify(arg)}`);
    }
  }
  return options;
}

/**
 * One repeat, once. Separates the two failures the caller must not confuse: `fault` means no
 * scene came up and nothing was measured; `not_confirmed` means the app had frames for
 * `TIMEOUT_MS` and never agreed with itself, which is a result (SB-5).
 */
async function attempt(
  browser: Browser,
  origin: string,
  vin: string,
): Promise<{ outcome: Outcome; ms: number | null; fault: string | null }> {
  // A fresh context per repeat: §6.3's cooldown is keyed by VIN and outlives the mount,
  // so re-scanning the same label in the same profile would time the cooldown instead.
  const context = await browser.newContext({ permissions: ["camera"] });
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/#/scan`);
    // HAVE_CURRENT_DATA: the element can hand `drawImage` a frame, which is the first
    // moment ZXing's loop can possibly read anything.
    try {
      await page.waitForFunction(
        () => (document.querySelector("video")?.readyState ?? 0) >= 2,
        undefined,
        { timeout: TIMEOUT_MS },
      );
    } catch (error) {
      // No frames ever arrived: the fake capture device, not the scanner.
      return {
        outcome: "fault",
        ms: null,
        fault: `no video: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      };
    }
    const started = Date.now();
    try {
      await page.waitForURL((url) => url.hash.startsWith(`#/v/${vin}`), { timeout: TIMEOUT_MS });
    } catch {
      return { outcome: "not_confirmed", ms: null, fault: null };
    }
    return { outcome: "confirmed", ms: Date.now() - started, fault: null };
  } finally {
    await context.close();
  }
}

/** One case: launch on this y4m, then run `repeats` fresh contexts against the built app. */
async function measure(
  browser: Browser,
  origin: string,
  vin: string,
  symbology: BenchSymbology,
  tier: Tier,
  repeats: number,
): Promise<Measurement[]> {
  const out: Measurement[] = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    let result = await attempt(browser, origin, vin);
    let attempts = 1;
    // Retry the harness, never the measurement (SB-5): a repeat that got frames and did not
    // confirm stays exactly as measured, however slow.
    while (result.outcome === "fault" && attempts < VIDEO_ATTEMPTS) {
      attempts += 1;
      process.stderr.write(
        `confirm-probe: ${symbology} ${tier} #${repeat} harness fault, attempt ${attempts}\n`,
      );
      result = await attempt(browser, origin, vin);
    }
    out.push({
      symbology,
      tier,
      repeat,
      outcome: result.outcome,
      ms: result.ms,
      fault: result.fault,
      attempts,
    });
    process.stderr.write(
      `confirm-probe: ${symbology} ${tier} #${repeat} ` +
        `${result.outcome === "confirmed" ? `${result.ms ?? 0} ms` : result.outcome === "not_confirmed" ? `NOT CONFIRMED in ${TIMEOUT_MS} ms` : `FAULT ${result.fault ?? ""}`}\n`,
    );
  }
  return out;
}

/**
 * Launch Chromium, retrying the launch itself (SB-5). Nothing here can change what the app
 * decodes — the y4m is already written — so a retry re-measures rather than re-rolls.
 */
async function launch(file: string, executablePath: string | undefined): Promise<Browser> {
  let lastError: unknown = null;
  for (let i = 1; i <= LAUNCH_ATTEMPTS; i += 1) {
    try {
      return await chromium.launch({
        ...(executablePath === undefined ? {} : { executablePath }),
        timeout: LAUNCH_TIMEOUT_MS,
        args: [
          "--use-fake-device-for-media-stream",
          "--use-fake-ui-for-media-stream",
          `--use-file-for-fake-video-capture=${file}`,
        ],
      });
    } catch (error) {
      lastError = error;
      process.stderr.write(
        `confirm-probe: Chromium launch ${i}/${LAUNCH_ATTEMPTS} failed: ` +
          `${error instanceof Error ? error.message.split("\n")[0] : String(error)}\n`,
      );
    }
  }
  throw new Error(
    `confirm-probe: Chromium would not launch in ${LAUNCH_ATTEMPTS} attempts: ` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function cell(
  scoped: readonly Measurement[],
  symbology: BenchSymbology | "all" = "all",
  tier: Tier | "all" = "all",
): ConfirmCell {
  const times = scoped
    .filter((m) => m.outcome === "confirmed")
    .map((m) => m.ms)
    .filter((v): v is number => v !== null);
  const faults = scoped.filter((m) => m.outcome === "fault").length;
  return {
    symbology,
    tier,
    measured: scoped.length - faults,
    confirmed: times.length,
    notConfirmed: scoped.filter((m) => m.outcome === "not_confirmed").length,
    faults,
    meanMs: times.length === 0 ? null : times.reduce((a, b) => a + b, 0) / times.length,
    minMs: times.length === 0 ? null : Math.min(...times),
    maxMs: times.length === 0 ? null : Math.max(...times),
  };
}

function summarise(measurements: readonly Measurement[], options: Options): ConfirmCell[] {
  const out: ConfirmCell[] = [];
  for (const symbology of options.symbologies) {
    for (const tier of options.tiers) {
      const scoped = measurements.filter((m) => m.symbology === symbology && m.tier === tier);
      if (scoped.length > 0) out.push(cell(scoped, symbology, tier));
    }
  }
  return out;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(join(options.dist, "index.html"))) {
    throw new Error(`confirm-probe: no build at ${options.dist} — run \`bun run build\` first`);
  }

  const dir = await mkdtemp(join(tmpdir(), "vin-confirm-"));
  const server = await serve(options.dist);
  const executablePath = resolveChromium(options.chromiumPath);
  const measurements: Measurement[] = [];

  try {
    for (const symbology of options.symbologies) {
      const png = await renderBarcode(options.vin, symbology);
      for (const tier of options.tiers) {
        const lumas: Buffer[] = [];
        for (let frame = 0; frame < FRAMES; frame += 1) {
          const seed = seedFor(options.vin, symbology, tier, frame);
          const degraded = await degrade(
            png,
            tier,
            seed,
            tier === "severe" ? severeExtrasFor(seed) : undefined,
          );
          lumas.push(await padded(degraded));
        }
        const file = join(dir, `${symbology}-${tier}.y4m`);
        await writeFile(file, y4m(lumas));

        const browser = await launch(file, executablePath);
        try {
          measurements.push(
            ...(await measure(
              browser,
              server.origin,
              options.vin,
              symbology,
              tier,
              options.repeats,
            )),
          );
        } finally {
          await browser.close();
        }
        await rm(file, { force: true });
      }
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }

  const cells = summarise(measurements, options);
  const overall = cell(measurements);

  process.stdout.write(`\n# confirm-probe — §13.4 mean time-to-confirm (run b)\n\n`);
  process.stdout.write(
    `VIN \`${options.vin}\` · ${FRAMES} distinct poses at ${FPS} fps · ` +
      `${WIDTH}x${HEIGHT} fake capture · ${options.repeats} fresh contexts per cell · ` +
      `timeout ${TIMEOUT_MS} ms\n\n`,
  );
  process.stdout.write(`| symbology | tier | confirmed | mean ms | min ms | max ms | faults |\n`);
  process.stdout.write(`|---|---|---:|---:|---:|---:|---:|\n`);
  for (const c of cells) {
    process.stdout.write(
      `| ${c.symbology} | ${c.tier} | ${c.confirmed}/${c.measured} | ` +
        `${c.meanMs === null ? "-" : c.meanMs.toFixed(0)} | ${c.minMs ?? "-"} | ` +
        `${c.maxMs ?? "-"} | ${c.faults} |\n`,
    );
  }

  process.stdout.write(
    `\nOverall: ${overall.confirmed}/${overall.measured} confirmed, mean ` +
      `${overall.meanMs === null ? "-" : overall.meanMs.toFixed(0)} ms` +
      `${overall.faults === 0 ? "" : `, ${overall.faults} harness faults excluded`}\n`,
  );
  process.stdout.write(
    `\nA y4m loop is not a hand (§13.7): fixed frame rate, repeating poses, no approach.\n`,
  );

  // The artifact bench/report.md quotes (SB-5). Written last, so a crashed probe leaves the
  // previous recording in place rather than a half-run one.
  const record: ConfirmRecord = {
    probe: "bench/confirm-probe.ts",
    command:
      `bun run bench/confirm-probe.ts --repeats ${options.repeats}` +
      ` --symbologies ${options.symbologies.join(",")} --tiers ${options.tiers.join(",")}`,
    // The tree the *build* came from, not the one the probe is running in.
    provenance: gitProvenance(resolve(options.dist, "..")),
    dist: options.dist,
    machine: { cpus: cpus().length, loadavg: loadavg() },
    config: {
      vin: options.vin,
      runSeed: RUN_SEED,
      frames: FRAMES,
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      repeats: options.repeats,
      timeoutMs: TIMEOUT_MS,
      symbologies: options.symbologies,
      tiers: options.tiers,
      chromium: executablePath ?? null,
    },
    overall,
    cells,
    measurements,
  };
  await writeFile(CONFIRM_RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  process.stdout.write(
    `\nRecorded to ${CONFIRM_RECORD_PATH} — bench/report.md quotes it (SB-5).\n`,
  );
}

await main();
