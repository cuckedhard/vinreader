/**
 * §13.4 run (b), reduced to one question: **how much of the bench's remaining gap is the
 * camera?**
 *
 * `bun run bench` decodes a degraded PNG drawn onto a canvas. The app decodes a `<video>`
 * frame drawn onto a canvas, and that frame has been through YUV 4:2:0 on the way. This
 * probe closes the difference by measurement rather than by argument: it takes a subset of
 * the same corpus, at the same seeds, pads every frame onto one fixed 1920×1080 white
 * surround, writes them as a YUV4MPEG2 file, and hands that file to Chromium's fake camera —
 * then decodes each frame **twice**, once off the video element and once off the identical
 * padded PNG. Same pixels in, two capture histories, one difference.
 *
 * It is not part of `bun run bench`, and deliberately: one 1920×1080 I420 frame is 3.0 MB,
 * so the whole 4,200-frame corpus would be a 12.4 GB file and, at a frame rate slow enough
 * for every frame to be decoded before the camera moves on, about three hours of playback.
 * A subset is what this can afford — see the header it prints for exactly how much.
 *
 *   bun run bench/camera-probe.ts [--count N] [--fps N] [--symbologies a,b] [--tiers a,b]
 *
 * Determinism: the frames come from `corpus.ts` and `degrade.ts` at the same
 * `runSeed ^ fnv1a("vin|symbology|tier")` the runner uses, so a row here is the same image as
 * the row of the same name in `report.md`. What is *not* deterministic is which frames the
 * camera happens to show while a decode is running — the probe keeps the first read of each
 * frame index and loops until it has them all, so the set is complete, but the number of
 * passes it took is not a number to report.
 */

import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import sharp from "sharp";
import { extractVin } from "../src/lib/vin/extractVin";
import { openBrowserDecoder } from "./browser-decode";
import { BENCH_SYMBOLOGIES, buildCorpus } from "./corpus";
import type { BenchSymbology } from "./corpus";
import { TIERS, degrade, severeExtrasFor } from "./degrade";
import type { Tier } from "./degrade";

/** The same run seed `run.ts` defaults to, so a row here names the same image as one there. */
const RUN_SEED = 0x5eed_1a7c;

/**
 * The app's §6.3 `VIDEO_CONSTRAINTS` ask for an ideal 1920×1080. The file is written at that
 * size so Chromium delivers it unscaled: a rescale between the file and the video element
 * would be a degradation this corpus does not define, and the probe checks the track's
 * reported size to prove it did not happen.
 */
const WIDTH = 1920;
const HEIGHT = 1080;

/** Marker geometry: one sync cell then 12 index bits, LSB first, black for 1. */
const CELL = 24;
const BITS = 12;

/** White, because a label's surround is white and the binarizer must not be handed a dark frame. */
const PAPER = 0xff;

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function seedFor(vin: string, symbology: BenchSymbology, tier: Tier): number {
  return (RUN_SEED ^ fnv1a(`${vin}|${symbology}|${tier}`)) >>> 0;
}

/**
 * Centre a degraded frame on a 1920×1080 white field and stamp its index in the top-left.
 *
 * The padding is the one thing this probe adds to the corpus, and it is added to **both**
 * sides of the comparison, so it cannot bias the answer: the control decodes this exact
 * buffer as a PNG. It is also the least unrealistic thing here — a real photo of a door-jamb
 * label is mostly not the label.
 */
async function padded(png: Buffer, index: number): Promise<Buffer> {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  if (info.width > WIDTH || info.height > HEIGHT) {
    throw new Error(
      `camera-probe: frame ${info.width}×${info.height} does not fit ${WIDTH}×${HEIGHT}`,
    );
  }
  const luma = Buffer.alloc(WIDTH * HEIGHT, PAPER);
  const left = (WIDTH - info.width) >> 1;
  const top = (HEIGHT - info.height) >> 1;
  for (let y = 0; y < info.height; y += 1) {
    data.copy(luma, (top + y) * WIDTH + left, y * info.width, (y + 1) * info.width);
  }
  const cell = (n: number, dark: boolean): void => {
    if (!dark) return;
    for (let y = 0; y < CELL; y += 1) {
      luma.fill(0x00, y * WIDTH + n * CELL, y * WIDTH + (n + 1) * CELL);
    }
  };
  cell(0, true);
  for (let bit = 0; bit < BITS; bit += 1) cell(bit + 1, (index & (1 << bit)) !== 0);
  return luma;
}

/**
 * Raw luma to PNG, so the control decodes the *same* buffer the camera was fed rather than a
 * second rendering of it.
 */
function toPng(luma: Buffer): Promise<Buffer> {
  return sharp(luma, { raw: { width: WIDTH, height: HEIGHT, channels: 1 } })
    .png()
    .toBuffer();
}

/**
 * One YUV4MPEG2 file, `C420`, no `XCOLORRANGE` — byte-for-byte the shape
 * `bench/make-fake-camera.py` writes, so the probe measures the fixture format the e2e suite
 * already uses. Every frame is grey, so the two chroma planes are constant 0x80 and the whole
 * of the colour conversion lands on luma.
 */
function y4m(frames: readonly Buffer[], fps: number): Buffer {
  const chroma = Buffer.alloc((WIDTH / 2) * (HEIGHT / 2), 0x80);
  const parts: Buffer[] = [Buffer.from(`YUV4MPEG2 W${WIDTH} H${HEIGHT} F${fps}:1 Ip A1:1 C420\n`)];
  for (const frame of frames) {
    parts.push(Buffer.from("FRAME\n"), frame, chroma, chroma);
  }
  return Buffer.concat(parts);
}

interface Row {
  index: number;
  vin: string;
  symbology: BenchSymbology;
  tier: Tier;
  seed: number;
  cameraVin: string | null;
  canvasVin: string | null;
}

function parseList<T extends string>(raw: string, allowed: readonly T[]): T[] {
  const parts = raw.split(",").map((part) => part.trim());
  const chosen = allowed.filter((value) => parts.includes(value));
  if (chosen.length === 0) throw new Error(`expected some of ${allowed.join(",")}`);
  return chosen;
}

async function main(): Promise<number> {
  let count = 5;
  let fps = 4;
  let symbologies: BenchSymbology[] = [...BENCH_SYMBOLOGIES];
  let tiers: Tier[] = [...TIERS];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const value = (): string => argv[++i] ?? "";
    switch (argv[i]) {
      case "--count":
        count = Number(value());
        break;
      case "--fps":
        fps = Number(value());
        break;
      case "--symbologies":
        symbologies = parseList(value(), BENCH_SYMBOLOGIES);
        break;
      case "--tiers":
        tiers = parseList(value(), TIERS);
        break;
      default:
        process.stderr.write(`camera-probe: unknown flag ${argv[i]}\n`);
        return 2;
    }
  }

  const corpus = (await buildCorpus(count)).filter((item) => symbologies.includes(item.symbology));
  const rows: Row[] = [];
  const lumas: Buffer[] = [];
  for (const item of corpus) {
    for (const tier of tiers) {
      const seed = seedFor(item.vin, item.symbology, tier);
      const extras = tier === "severe" ? severeExtrasFor(seed) : undefined;
      const frame = await degrade(item.png, tier, seed, extras);
      const index = rows.length;
      if (index >= 1 << BITS)
        throw new Error("camera-probe: more frames than the marker can index");
      lumas.push(await padded(frame, index));
      rows.push({
        index,
        vin: item.vin,
        symbology: item.symbology,
        tier,
        seed,
        cameraVin: null,
        canvasVin: null,
      });
    }
  }

  const dir = await mkdtemp(join(tmpdir(), "vin-camera-"));
  const file = join(dir, "corpus.y4m");
  const bytes = y4m(lumas, fps);
  await writeFile(file, bytes);
  process.stderr.write(
    `camera-probe: ${rows.length} frames, ${WIDTH}×${HEIGHT}, ${fps} fps, ` +
      `${(bytes.length / 1e6).toFixed(0)} MB, ${(rows.length / fps).toFixed(0)} s per pass\n`,
  );

  const decoder = await openBrowserDecoder({
    pages: 1,
    chromiumPath: null,
    // `getUserMedia` needs a secure context, which `about:blank` is not.
    secureOrigin: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${file}`,
    ],
  });

  try {
    // The control first: the same padded buffers as PNGs, through the `canvas` path.
    const pngs = await Promise.all(lumas.map(toPng));
    const control = await decoder.decode(pngs, "canvas");
    for (let i = 0; i < rows.length; i += 1) {
      const text = control[i].text;
      rows[i].canvasVin = text === null ? null : (extractVin(text)?.vin ?? null);
    }

    const timeoutMs = Math.max(60_000, Math.ceil((rows.length / fps) * 4000));
    const camera = await decoder.camera({ count: rows.length, timeoutMs, cell: CELL, bits: BITS });
    const sizes = new Set(camera.map((result) => `${result.width}×${result.height}`));
    for (const result of camera) {
      const text = result.text;
      rows[result.index].cameraVin = text === null ? null : (extractVin(text)?.vin ?? null);
    }

    const seen = camera.length;
    const cameraHits = rows.filter((row) => row.cameraVin === row.vin).length;
    const canvasHits = rows.filter((row) => row.canvasVin === row.vin).length;
    const cameraFalse = rows.filter((row) => row.cameraVin !== null && row.cameraVin !== row.vin);
    const canvasFalse = rows.filter((row) => row.canvasVin !== null && row.canvasVin !== row.vin);
    const only = rows.filter((row) => (row.cameraVin === row.vin) !== (row.canvasVin === row.vin));

    const out: string[] = [];
    out.push("");
    out.push("§13.4 camera probe — the app's frame source vs the bench's");
    out.push(
      `  ${rows.length} frames · ${WIDTH}×${HEIGHT} · ${fps} fps · ` +
        `video track reported ${[...sizes].join(", ") || "nothing"} · ${seen} frames captured`,
    );
    out.push("");
    out.push(`  camera (fake device, <video> → canvas): ${cameraHits}/${rows.length} correct`);
    out.push(`  canvas (padded PNG → canvas):           ${canvasHits}/${rows.length} correct`);
    out.push(
      `  disagreements: ${only.length} · false accepts: camera ${cameraFalse.length}, ` +
        `canvas ${canvasFalse.length}`,
    );
    for (const row of only) {
      out.push(
        `    ${row.symbology}/${row.tier} ${row.vin} seed 0x${row.seed.toString(16)}: ` +
          `camera ${row.cameraVin ?? "-"} · canvas ${row.canvasVin ?? "-"}`,
      );
    }
    for (const row of [...cameraFalse, ...canvasFalse]) {
      out.push(
        `    FALSE ACCEPT ${row.symbology}/${row.tier} expected ${row.vin}: ` +
          `camera ${row.cameraVin ?? "-"} · canvas ${row.canvasVin ?? "-"}`,
      );
    }
    out.push("");
    process.stdout.write(`${out.join("\n")}\n`);
    for (const message of decoder.pageErrors()) process.stderr.write(`page error: ${message}\n`);
    return seen === rows.length ? 0 : 1;
  } finally {
    await decoder.close();
    await rm(dir, { recursive: true, force: true });
  }
}

process.exitCode = await main();
