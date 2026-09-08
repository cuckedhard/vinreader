import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  QR_CACHE_DIR,
  QR_CACHE_TTL_MS,
  QR_PARTIAL_GRACE_MS,
  pruneQrY4mCache,
  writeQrY4m,
  y4mByteLength,
} from "./e2e/qr-video";

/**
 * [ENV-1] The fake-camera videos must not fill the disk.
 *
 * `tests/e2e/qr-video.ts` wrote each video into a fresh `mkdtemp` directory that nothing ever
 * removed. One `bun run test:e2e` left 16 of them and 5.0 GB; runs accumulated until 108
 * directories took the volume to 100% and the §13.5 gate came back 17 failed / 6 did not run,
 * every failure an `ENOSPC` raised by this helper. That is the gate reporting red for reasons
 * unrelated to any code.
 *
 * The frame counts are load-bearing and none of them changed — FR-4's 450-frame label segment
 * is what keeps its assertions inside one pass of the video — so what is measured here is that
 * the same bytes are written once and then reused, published atomically so parallel workers
 * cannot read a half-written file or race each other, and that what a killed run leaves behind
 * is collected by the next one.
 *
 * A vitest file rather than a Playwright spec: the helper is pure node, and the e2e suite's
 * count is itself a gate number.
 */

/** Anything the leak was counted in: `ls -d /tmp/vinrelay-*`. */
function tmpEntries(): string[] {
  return readdirSync(tmpdir()).filter((n) => n.startsWith("vinrelay-"));
}

/** A scratch cache of this test's own, so nothing here touches a real entry. */
const SCRATCH = mkdtempSync(join(tmpdir(), "qr-video-test-"));

/** Unique per file so two of these tests never share a cache entry. */
const ONE = "ENV1-SEGMENT-ONE";
const TWO = "ENV1-SEGMENT-TWO";

/**
 * Re-derives the video's shape from its own header rather than from the module under test,
 * so a helper that agreed with itself about a wrong size could not pass this.
 */
function inspect(path: string): { width: number; height: number; frames: number } {
  const buf = readFileSync(path);
  const nl = buf.indexOf(0x0a);
  const header = /^YUV4MPEG2 W(\d+) H(\d+) /.exec(buf.subarray(0, nl).toString("ascii"));
  expect(header).not.toBeNull();
  const width = Number(header![1]);
  const height = Number(header![2]);
  // "FRAME\n" + a full luma plane + two half-size chroma planes.
  const frame = 6 + width * height + 2 * (width / 2) * (height / 2);
  const body = buf.length - (nl + 1);
  // A partially written file is not a whole number of frames. This is the completeness check.
  expect(body % frame).toBe(0);
  return { width, height, frames: body / frame };
}

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("[ENV-1] the fake-camera videos do not fill the disk", () => {
  it("resolves the same segments to one file, not a directory per call", () => {
    const segments = [[ONE, 1]] as const;
    const before = tmpEntries();

    const first = writeQrY4m("env1-reuse", segments, SCRATCH);
    const second = writeQrY4m("env1-reuse", segments, SCRATCH);

    expect(second).toBe(first);
    // The second call did not rewrite the bytes: same inode, so nothing was re-drawn.
    expect(statSync(second).ino).toBe(statSync(first).ino);
    expect(dirname(first)).toBe(SCRATCH);
    // No `mkdtemp` directory of its own — the whole shape of the leak.
    expect(tmpEntries()).toEqual(before);
    // And nothing unpublished is left lying about after a successful write.
    expect(readdirSync(SCRATCH).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("writes the frames it was asked for, and the file is a whole number of them", () => {
    const segments = [
      [ONE, 2],
      [TWO, 3],
    ] as const;

    const path = writeQrY4m("env1-frames", segments, SCRATCH);

    const { width, height, frames } = inspect(path);
    expect(width).toBe(1280);
    expect(height).toBe(720);
    // The video is not shortened: every frame every caller asked for is in the file.
    expect(frames).toBe(5);
    expect(statSync(path).size).toBe(y4mByteLength(segments));
  });

  it("gives different content a different file", () => {
    const short = writeQrY4m("env1-content", [[ONE, 1]], SCRATCH);
    const long = writeQrY4m("env1-content", [[ONE, 2]], SCRATCH);
    const other = writeQrY4m("env1-content", [[TWO, 1]], SCRATCH);

    expect(new Set([short, long, other]).size).toBe(3);
    expect(inspect(short).frames).toBe(1);
    expect(inspect(long).frames).toBe(2);
  });

  it("publishes nothing, and leaves nothing, when the write cannot finish", () => {
    const segments = [[ONE, 1]] as const;
    // The name the publish renames onto, learned from a write that did succeed.
    const target = basename(writeQrY4m("env1-blocked", segments, SCRATCH));
    const dir = mkdtempSync(join(tmpdir(), "qr-video-blocked-"));
    try {
      // A directory sitting on the destination fails the way a full disk fails: partway
      // through, with a temporary file already written.
      mkdirSync(join(dir, target));

      expect(() => writeQrY4m("env1-blocked", segments, dir)).toThrow();

      // The half-written video did not survive the failure, so nothing accumulates and no
      // spec is ever handed a truncated file.
      expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
      expect(readdirSync(dir)).toEqual([target]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prunes partials and cold videos, and keeps the ones a run is using", () => {
    const dir = mkdtempSync(join(tmpdir(), "qr-video-prune-"));
    try {
      const hot = writeQrY4m("env1-hot", [[ONE, 1]], dir);
      const cold = writeQrY4m("env1-cold", [[TWO, 1]], dir);
      // A partial whose writer cannot be named: only the age can condemn it.
      const partial = join(dir, ".env1-killed.tmp");
      writeFileSync(partial, "half a video");
      const stale = new Date(Date.now() - QR_CACHE_TTL_MS - 60_000);
      utimesSync(cold, stale, stale);
      const abandoned = new Date(Date.now() - QR_PARTIAL_GRACE_MS - 60_000);
      utimesSync(partial, abandoned, abandoned);
      const freed = statSync(cold).size + statSync(partial).size;

      const removed = pruneQrY4mCache(dir);

      expect(removed).toEqual({ files: 2, bytes: freed });
      expect(readdirSync(dir)).toEqual([basename(hot)]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes a killed run's partial at once, without waiting out the grace", () => {
    const dir = mkdtempSync(join(tmpdir(), "qr-video-killed-"));
    try {
      // A process that has certainly exited — the worker Playwright lost, or the run
      // somebody interrupted. The name carries its pid, which is how that is known.
      const dead = spawnSync(process.execPath, ["-e", ""]).pid;
      const partial = join(dir, `.env1-killed-${dead}-abcdef123456.tmp`);
      writeFileSync(partial, "half a video");

      // Seconds old, so the grace period has nothing to say about it.
      expect(pruneQrY4mCache(dir).files).toBe(1);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a partial a live worker is still writing alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "qr-video-live-"));
    try {
      // This process is the writer, and it is plainly still running.
      const inflight = join(dir, `.env1-inflight-${process.pid}-abcdef123456.tmp`);
      writeFileSync(inflight, "being written right now");

      expect(pruneQrY4mCache(dir).files).toBe(0);
      expect(readdirSync(dir)).toEqual([basename(inflight)]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a reused video hot, so a concurrent run's prune cannot take it", () => {
    const dir = mkdtempSync(join(tmpdir(), "qr-video-hot-"));
    try {
      const segments = [[ONE, 1]] as const;
      const path = writeQrY4m("env1-touch", segments, dir);
      const cold = new Date(Date.now() - QR_CACHE_TTL_MS - 60_000);
      utimesSync(path, cold, cold);

      // The second run claims the same video, which is what marks it in use.
      expect(writeQrY4m("env1-touch", segments, dir)).toBe(path);

      expect(pruneQrY4mCache(dir).files).toBe(0);
      expect(readdirSync(dir)).toEqual([basename(path)]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps every video of a suite in one directory under the temp root", () => {
    expect(dirname(QR_CACHE_DIR)).toBe(tmpdir());
    // `rm -rf /tmp/vinrelay-*` — the documented recovery — still finds it.
    expect(basename(QR_CACHE_DIR).startsWith("vinrelay-")).toBe(true);
  });
});
