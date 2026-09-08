import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import QRCode from "qrcode";

/**
 * A fake-camera video of QR codes, for the specs that drive §9-S3's phone-to-phone path.
 *
 * The same y4m shape `bench/make-qr-camera.mjs` writes, built at run time so nothing under
 * `bench/` is clobbered. Segments run in order and Chromium loops the file, which is how one
 * video can hold a code the app refuses followed by one it reads (§7 item 5: one definition,
 * imported by both carrier specs).
 *
 * **ENV-1.** These files are enormous — 1,382,400 bytes a frame, and the frame counts are
 * load-bearing (a shorter video loops back and lets an assertion pass for the wrong reason),
 * so 645 frames is 891 MB and one suite is ~2.5 GB of distinct video. This used to be written
 * into a fresh `mkdtemp` directory on every call, which nothing ever removed: Playwright loads
 * a spec's module once to collect its tests and again in the worker that runs it, so a single
 * `bun run test:e2e` wrote every video twice and left 16 directories and 5.0 GB behind. Runs
 * accumulated — 108 directories took the volume to 100% and the gate came back 17 failed / 6
 * did not run, every failure an `ENOSPC` from this file, for reasons unrelated to any code.
 *
 * The videos are a pure function of their segments: the same arguments regenerate identical
 * bytes every run. So the file is content-addressed — `<name>-<key>.y4m` in one shared cache
 * directory, where the key is a hash of everything that determines a pixel. A call whose file
 * is already there returns it without drawing or writing anything, which collapses the
 * collect-and-run pair, every repeat invocation and every re-run onto one copy, and bounds
 * the whole suite at the ~2.5 GB it actually needs rather than 5 GB a run forever.
 *
 * Cache entries are published by `rename`, which is atomic: a parallel worker reading the
 * path either does not see the file or sees all of it, never the half a concurrent writer
 * has flushed so far. Reuse touches the mtime, so an entry another run is using now is never
 * old enough for `pruneQrY4mCache` to take. That function runs from `global-setup.ts` — once,
 * before any worker starts — and is what covers the paths that actually leaked: an interrupt,
 * a killed worker or an `ENOSPC` mid-write leaves at most a partial `.tmp`, and the next run
 * removes it along with anything unused for a day.
 */
const W = 1280;
const H = 720;
const QUIET = 4;
/** §4.9 carriers are long; `M` is what `bench/make-qr-camera.mjs` uses. */
const EC = "M" as const;

/**
 * Part of the cache key. Bump it when `lumaOf` changes what it draws, so a cached video
 * cannot outlive the code that produced it.
 */
const RECIPE = 1;

const HEADER = `YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420\n`;
const FRAME_TAG = "FRAME\n";
/** One YUV420 frame on the wire: the tag, a full luma plane, and two half-size chroma planes. */
const FRAME_BYTES = FRAME_TAG.length + W * H + 2 * (W / 2) * (H / 2);

/** One directory for every video, keyed by content — not one directory per call. */
export const QR_CACHE_DIR = join(tmpdir(), "vinrelay-qr-y4m");

/** How long a cached video survives without being used. */
export const QR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The backstop for an unpublished `.tmp` whose writer cannot be identified — a pid the name
 * does not carry, or one that has since been recycled onto a live process. Writing the
 * largest video takes seconds, so this is three orders of magnitude of headroom and a
 * concurrent run's prune cannot take a partial out from under the worker still writing it.
 */
export const QR_PARTIAL_GRACE_MS = 10 * 60 * 1000;

/** `.<name>-<pid>-<nonce>.tmp` — the pid is what says whether anyone is still writing it. */
const PARTIAL = /^\..*-(\d+)-[0-9a-f]+\.tmp$/;

type Segments = readonly (readonly [string, number])[];

/** One QR, drawn as a full luma plane. */
function lumaOf(text: string): Buffer {
  const qr = QRCode.create(text, { errorCorrectionLevel: EC });
  const size = qr.modules.size;
  const data = qr.modules.data;
  const scale = Math.floor(Math.min(W, H) / (size + QUIET * 2));
  const side = (size + QUIET * 2) * scale;
  const x0 = Math.floor((W - side) / 2);
  const y0 = Math.floor((H - side) / 2);
  const luma = Buffer.alloc(W * H, 0xff);
  for (let my = 0; my < size; my += 1) {
    for (let mx = 0; mx < size; mx += 1) {
      if (!data[my * size + mx]) continue;
      const px = x0 + (mx + QUIET) * scale;
      const py = y0 + (my + QUIET) * scale;
      for (let y = py; y < py + scale; y += 1) luma.fill(0x00, y * W + px, y * W + px + scale);
    }
  }
  return luma;
}

/** Everything that decides a byte of the file, and nothing that does not. */
function keyOf(segments: Segments): string {
  return createHash("sha256")
    .update(JSON.stringify([RECIPE, W, H, QUIET, EC, segments]))
    .digest("hex")
    .slice(0, 16);
}

/** The exact size the finished file has, which is how a truncated one is spotted. */
export function y4mByteLength(segments: Segments): number {
  let frames = 0;
  for (const [, count] of segments) frames += count;
  return Buffer.byteLength(HEADER) + frames * FRAME_BYTES;
}

/** `writeSync` may write short; the caller wants all of it or an error. */
function writeAll(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}

/**
 * Stream the frames out rather than concatenating 891 MB in memory first. Every frame in a
 * segment is the same bytes, so the luma plane is drawn once and written `frames` times.
 */
function build(path: string, segments: Segments): void {
  const chroma = Buffer.alloc((W / 2) * (H / 2), 0x80);
  const tag = Buffer.from(FRAME_TAG);
  const fd = openSync(path, "wx");
  try {
    writeAll(fd, Buffer.from(HEADER));
    for (const [text, frames] of segments) {
      const luma = lumaOf(text);
      for (let i = 0; i < frames; i += 1) {
        writeAll(fd, tag);
        writeAll(fd, luma);
        writeAll(fd, chroma);
        writeAll(fd, chroma);
      }
    }
  } finally {
    closeSync(fd);
  }
}

/** A published entry is complete by construction; the size check catches an older one. */
function isComplete(path: string, size: number): boolean {
  const st = statSync(path, { throwIfNoEntry: false });
  return st !== undefined && st.isFile() && st.size === size;
}

export function writeQrY4m(name: string, segments: Segments, dir: string = QR_CACHE_DIR): string {
  const out = join(dir, `${name}-${keyOf(segments)}.y4m`);
  mkdirSync(dir, { recursive: true });
  if (isComplete(out, y4mByteLength(segments))) {
    // Reuse, and mark it in use so no concurrent run's prune considers it cold.
    const now = new Date();
    utimesSync(out, now, now);
    return out;
  }
  // Written under a name no other writer can pick and published atomically, so a reader
  // never sees a half-written video and two workers racing on the same content cannot
  // collide. A write that dies partway leaves this, never `out`.
  const tmp = join(dir, `.${name}-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    build(tmp, segments);
    renameSync(tmp, out);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return out;
}

/** Whether anyone is still holding a partial open. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH is the answer to the question. Any other code means the process is there and
    // simply not ours to signal, which still counts as running.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** A partial is garbage the moment its writer is gone; the age is only a backstop. */
function abandoned(entry: string, age: number): boolean {
  const pid = PARTIAL.exec(entry);
  if (pid !== null && !isRunning(Number(pid[1]))) return true;
  return age >= QR_PARTIAL_GRACE_MS;
}

/**
 * Drop partials left by a killed or out-of-space run, and videos nothing has used for a day
 * (a spec whose frame counts changed orphans its old one). Called from `global-setup.ts`,
 * which runs once before any worker, so nothing here can race a video being read.
 */
export function pruneQrY4mCache(dir: string = QR_CACHE_DIR): { files: number; bytes: number } {
  const removed = { files: 0, bytes: 0 };
  if (!existsSync(dir)) return removed;
  const now = Date.now();
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const st = statSync(path, { throwIfNoEntry: false });
    if (st === undefined || !st.isFile()) continue;
    const age = now - st.mtimeMs;
    const drop = entry.endsWith(".tmp") ? abandoned(entry, age) : age >= QR_CACHE_TTL_MS;
    if (!drop) continue;
    rmSync(path, { force: true });
    removed.files += 1;
    removed.bytes += st.size;
  }
  return removed;
}
