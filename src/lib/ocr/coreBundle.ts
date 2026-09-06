/**
 * The single-file tesseract core, rewritten to the limits S5 addendum §4 pins.
 *
 * `tesseract-core-simd-lstm.wasm.js` is emscripten's single-file output: the whole
 * WebAssembly module base64'd into one string literal, wrapped in the JS glue that
 * instantiates it. That shape is deliberate here — the two-file variant makes the core's
 * `.wasm` sibling resolve against whatever URL the worker happens to have been created
 * from, which is a blob URL in tesseract.js's default configuration, and there is no
 * offline story for a path that cannot be predicted at build time.
 *
 * `-sMAXIMUM_MEMORY` writes its value into two places: the wasm memory section, which is
 * what WebKit reserves up front, and a JS literal in `emscripten_resize_heap` that refuses
 * a growth request beyond it. Both are rewritten here, so the shipped file says 256 MB
 * wherever it says anything at all.
 *
 * Pure: a string in, a string out. No DOM, no I/O.
 */
import { capWasmMaximumMemory, readWasmMemoryLimits, WASM_PAGE_BYTES } from "./wasmMemory";

/** Base64 of `\0asm\1\0\0\0` — the first six characters of any embedded module. */
const EMBEDDED_WASM_PREFIX = '"AGFzbQ';

/** emscripten's default `MAXIMUM_MEMORY`, 2 GiB, as it appears in the glue. */
const DEFAULT_MAXIMUM_MEMORY = "2147483648";

/** How many times the glue names that ceiling: the guard, and the clamp beside it. */
const MAXIMUM_MEMORY_MENTIONS = 2;

export interface EmbeddedWasm {
  /** Index of the first base64 character. */
  start: number;
  /** Index one past the last base64 character. */
  end: number;
  bytes: Uint8Array;
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  // A chunk at a time: spreading a 2.8 MB array into `String.fromCharCode` overflows the
  // argument list on every engine this runs on.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** The embedded module, located by its own magic number rather than by line or offset. */
export function findEmbeddedWasm(source: string): EmbeddedWasm {
  const first = source.indexOf(EMBEDDED_WASM_PREFIX);
  if (first < 0) throw new Error("core: no embedded WebAssembly module");
  if (source.indexOf(EMBEDDED_WASM_PREFIX, first + 1) >= 0) {
    throw new Error("core: more than one embedded WebAssembly module");
  }
  const start = first + 1;
  const end = source.indexOf('"', start);
  if (end < 0) throw new Error("core: the embedded module is not terminated");
  return { start, end, bytes: decodeBase64(source.slice(start, end)) };
}

/**
 * `source` with its memory maximum — in the module and in the glue — set to `pages`.
 *
 * Every step is checked and nothing is skipped on a miss: a core that quietly failed to
 * be capped is exactly the file that OOMs at instantiation on a phone nobody here has.
 */
export function capCoreMaximumMemory(source: string, pages: number): string {
  const embedded = findEmbeddedWasm(source);
  const capped = capWasmMaximumMemory(embedded.bytes, pages);
  const glueBefore = source.slice(0, embedded.start);
  const glueAfter = source.slice(embedded.end);

  const mentions =
    glueBefore.split(DEFAULT_MAXIMUM_MEMORY).length -
    1 +
    (glueAfter.split(DEFAULT_MAXIMUM_MEMORY).length - 1);
  if (mentions !== MAXIMUM_MEMORY_MENTIONS) {
    throw new Error(`core: expected ${MAXIMUM_MEMORY_MENTIONS} memory ceilings, found ${mentions}`);
  }
  const ceiling = String(pages * WASM_PAGE_BYTES);

  return (
    glueBefore.split(DEFAULT_MAXIMUM_MEMORY).join(ceiling) +
    encodeBase64(capped) +
    glueAfter.split(DEFAULT_MAXIMUM_MEMORY).join(ceiling)
  );
}

/** The limits the shipped core declares. What a test asserts against, and what §4 pins. */
export function readCoreMemoryLimits(source: string): ReturnType<typeof readWasmMemoryLimits> {
  return readWasmMemoryLimits(findEmbeddedWasm(source).bytes);
}

/** How many times the glue still names emscripten's 2 GiB default. Shipping any is a bug. */
export function countDefaultMemoryCeilings(source: string): number {
  const embedded = findEmbeddedWasm(source);
  const glue = source.slice(0, embedded.start) + source.slice(embedded.end);
  return glue.split(DEFAULT_MAXIMUM_MEMORY).length - 1;
}
