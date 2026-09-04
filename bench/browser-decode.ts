/**
 * §13.4 scan-robustness bench — the node side of the browser decode paths (finding B2).
 *
 * Launches one Chromium, opens a small pool of pages, and injects `browser-entry.ts` into
 * each. Frames go over CDP as base64 PNGs in batches; every page decodes its slice with
 * `BrowserMultiFormatReader.decodeFromCanvas` and hands back one outcome per frame.
 *
 * **Why a pool and not a page per frame.** The corpus is 4,200 frames per path. A page load
 * costs tens of milliseconds and a browser launch costs hundreds; either per frame turns a
 * three-minute run into hours. One page, many frames, is the whole trick — and the pages are
 * only there because ZXing decodes synchronously on the page's single thread, so the second
 * page is the only way to use the second core.
 *
 * **Determinism.** Nothing here reads a clock or a random number that reaches a decode. The
 * frames arrive already degraded from the run seed; the split across pages is by contiguous
 * slice of a fixed-length array, and results are reassembled at their original index, so the
 * decode a frame gets does not depend on which page took it or on when it finished. Timing
 * is the only output that moves between runs, exactly as before.
 *
 * **The bundle.** Built by `bun build` on every run, from the working tree, so the page can
 * never be decoding with a stale copy of `src/lib/vin/symbologies.ts` (§7 item 5). It lands
 * in a temp dir and is deleted on close; nothing is committed.
 */

import type { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import type { BrowserDecodePath, CameraDecodeResult, CameraProbeRequest } from "./browser-entry";
import type { DecodeOutcome } from "./decode";

const run = promisify(execFile);

const ENTRY = fileURLToPath(new URL("browser-entry.ts", import.meta.url));

/**
 * `bun build`, from whichever bun is running this file. Falls back to the name on `PATH` if
 * the bench was somehow started under another runtime, so the failure is "bun not found"
 * rather than "node: unknown command build".
 */
function bunExecutable(): string {
  return basename(process.execPath).startsWith("bun") ? process.execPath : "bun";
}

export interface BrowserDecoder {
  /** How many pages are decoding in parallel. Reported, because it bounds the wall clock. */
  readonly pages: number;
  /** The binary that actually decoded, named in the report so the run is attributable. */
  readonly executable: string;
  /** Decode a batch, in order. One outcome per frame, faults reported rather than thrown. */
  decode(frames: readonly Buffer[], path: BrowserDecodePath): Promise<DecodeOutcome[]>;
  /**
   * Read frames off Chromium's fake camera on the first page — only meaningful when the
   * decoder was opened with the `--use-file-for-fake-video-capture` args. See
   * `camera-probe.ts`.
   */
  camera(request: CameraProbeRequest): Promise<CameraDecodeResult[]>;
  /** Uncaught page errors seen so far. A non-empty list is a finding, not a footnote. */
  pageErrors(): readonly string[];
  close(): Promise<void>;
}

export interface BrowserDecoderOptions {
  /** Pages in the pool. */
  pages: number;
  /** Chromium binary. `null` lets Playwright resolve its own (`PLAYWRIGHT_BROWSERS_PATH`). */
  chromiumPath: string | null;
  /** Extra launch arguments — the fake-camera flags, and nothing else so far. */
  args?: readonly string[];
  /**
   * Serve the blank page from `http://127.0.0.1` instead of `about:blank`.
   *
   * `about:blank` is enough for `decodeFromCanvas` and costs nothing, but it is an opaque
   * origin, and Chromium exposes `navigator.mediaDevices` only in a secure context — so the
   * camera probe cannot run there. A loopback origin *is* potentially trustworthy, which is
   * the whole reason this exists. The port is ephemeral (`listen(0)`), so the bench can
   * never collide with a dev server, a preview server or another agent's Playwright run.
   */
  secureOrigin?: boolean;
}

/**
 * Which Chromium to drive, in the order a person would try them:
 *
 * 1. `--chromium`, when the run said so;
 * 2. `CHROMIUM_PATH`, the variable `playwright.config.ts` already honours, so the bench and
 *    the e2e suite point at the same binary without a second convention;
 * 3. Playwright's own download, when it is actually on disk;
 * 4. any `chromium-<rev>` under `PLAYWRIGHT_BROWSERS_PATH`, highest revision first.
 *
 * Step 4 exists because a machine can carry a Chromium that this `@playwright/test` did not
 * download — this one does — and `bun run bench` is a §13.5 gate command: it has to run
 * without an environment variable a reader of the gate list would never guess. A wrong
 * Chromium cannot make a decode wrong, only different, and the report names the binary.
 */
export function resolveChromium(explicit: string | null): string | undefined {
  if (explicit !== null && explicit !== "") return explicit;
  const fromEnv = process.env.CHROMIUM_PATH;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const own = chromium.executablePath();
  if (own !== "" && existsSync(own)) return undefined;

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root === undefined || root === "" || !existsSync(root)) return undefined;
  const revisions = readdirSync(root)
    .filter((name) => /^chromium-\d+$/.test(name))
    .map((name) => Number(name.slice("chromium-".length)))
    .sort((a, b) => b - a);
  for (const revision of revisions) {
    const candidate = join(root, `chromium-${revision}`, "chrome-linux", "chrome");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Split `length` items across `parts` contiguous slices, largest first, so the split is a
 * pure function of the two numbers and never of arrival order.
 */
function slices(length: number, parts: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i < parts; i += 1) {
    const size = Math.ceil((length - start) / (parts - i));
    out.push([start, start + size]);
    start += size;
  }
  return out;
}

export async function openBrowserDecoder(options: BrowserDecoderOptions): Promise<BrowserDecoder> {
  const dir = await mkdtemp(join(tmpdir(), "vin-bench-"));
  const bundlePath = join(dir, "browser-entry.js");
  try {
    await run(bunExecutable(), ["build", ENTRY, "--target", "browser", "--outfile", bundlePath]);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`bench: could not bundle ${ENTRY} for the browser`, { cause: error });
  }
  const bundle = await readFile(bundlePath, "utf8");

  const executablePath = resolveChromium(options.chromiumPath);
  let browser: Browser;
  try {
    browser = await chromium.launch({
      ...(executablePath === undefined ? {} : { executablePath }),
      ...(options.args === undefined ? {} : { args: [...options.args] }),
    });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }

  // A blank document is all the reader needs: it takes a canvas, not a DOM. Loading the app
  // itself would drag in the router, Dexie and the service worker, none of which touches
  // `decodeFromCanvas`, and would make the bench depend on a dev server.
  const BLANK = "<!doctype html><html><head><title>vin bench</title></head><body></body></html>";
  const server =
    options.secureOrigin === true
      ? createServer((_request, response) => {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(BLANK);
        })
      : null;
  if (server !== null) {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  }
  const origin =
    server === null ? null : `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  const errors: string[] = [];
  const pages: Page[] = [];
  const count = Math.max(1, options.pages);
  for (let i = 0; i < count; i += 1) {
    const page = await browser.newPage();
    page.on("pageerror", (error) => errors.push(`page ${i}: ${error.message}`));
    if (origin === null) await page.setContent(BLANK);
    else await page.goto(origin);
    await page.addScriptTag({ content: bundle });
    const ready = await page.evaluate(() => window.__vinBench !== undefined);
    if (!ready) throw new Error("bench: the browser bundle did not install its bridge");
    pages.push(page);
  }

  return {
    pages: pages.length,
    executable: executablePath ?? chromium.executablePath(),

    async decode(frames: readonly Buffer[], path: BrowserDecodePath): Promise<DecodeOutcome[]> {
      if (frames.length === 0) return [];
      const encoded = frames.map((frame) => frame.toString("base64"));
      const split = slices(encoded.length, Math.min(pages.length, encoded.length));
      const batches = await Promise.all(
        split.map(([from, to], index) =>
          pages[index].evaluate(
            (input) => {
              const bridge = window.__vinBench;
              if (bridge === undefined) throw new Error("bench: bridge missing");
              return bridge.decode(input.frames, input.path);
            },
            { frames: encoded.slice(from, to), path },
          ),
        ),
      );
      // Reassembled at the original index: which page decoded a frame is scheduling, and
      // scheduling must not reach the report.
      const out: DecodeOutcome[] = [];
      for (const batch of batches) {
        for (const result of batch) {
          out.push({
            text: result.text,
            aimStripped: result.aimStripped,
            format: result.format,
            ms: result.ms,
            fault: result.fault,
          });
        }
      }
      return out;
    },

    camera(request: CameraProbeRequest): Promise<CameraDecodeResult[]> {
      return pages[0].evaluate((input) => {
        const bridge = window.__vinBench;
        if (bridge === undefined) throw new Error("bench: bridge missing");
        return bridge.camera(input);
      }, request);
    },

    pageErrors(): readonly string[] {
      return errors;
    },

    async close(): Promise<void> {
      await browser.close();
      if (server !== null) await new Promise<void>((done) => server.close(() => done()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
