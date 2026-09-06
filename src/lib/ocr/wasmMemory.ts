/**
 * The memory declaration of a WebAssembly module, read and rewritten in place.
 *
 * S5 addendum §4 makes two of these a hard constraint rather than a preference, and both
 * are properties of bytes rather than of runtime configuration, so both are settled here
 * at build time and asserted against the shipped file:
 *
 *  - **`MAXIMUM_MEMORY` capped at 256 MB.** WebKit reserves a declared maximum *up front*,
 *    which is the documented cause of an OOM at instantiation rather than at use.
 *    `tesseract.js-core` is built with emscripten's 2 GiB default, so on iOS the stock
 *    core can fail before it has read a pixel.
 *  - **Never `shared: true`.** GitHub Pages cannot set COOP/COEP and Safari has no
 *    `COEP: credentialless`, so a shared memory cannot be instantiated at all there.
 *
 * The maximum lives in the module's memory section as a LEB128 integer. The wasm spec
 * permits a non-minimal encoding of that integer, so a smaller value can be written over
 * a larger one without moving a byte — the section length, and every offset after it,
 * stay exactly where they were.
 *
 * Pure: bytes in, bytes out. No DOM, no I/O.
 */

/** One WebAssembly page. The unit both limits below are counted in. */
export const WASM_PAGE_BYTES = 65536;

/** Section id 5 (§5.5.13 of the core spec) is where a module declares its own memory. */
const MEMORY_SECTION_ID = 5;

/** Bit 0 of the limits flags: a maximum follows the minimum. */
const LIMITS_HAS_MAXIMUM = 0x01;

/** Bit 1: the memory is shared, and instantiating it needs cross-origin isolation. */
const LIMITS_SHARED = 0x02;

/** `\0asm` followed by version 1, little-endian. */
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/** The most bytes an unsigned 32-bit LEB128 may occupy (§5.2.2). */
const MAX_LEB128_BYTES = 5;

export interface WasmMemoryLimits {
  /** Pages the module asks for at instantiation. */
  initialPages: number;
  /** Pages it may grow to, or `null` when the module declares no ceiling. */
  maximumPages: number | null;
  /** True when the memory is declared `shared` — forbidden here (§4). */
  shared: boolean;
  /** Where the maximum's LEB128 starts, and how many bytes it occupies. */
  maximumOffset: number;
  maximumLength: number;
}

interface Leb128 {
  value: number;
  length: number;
}

function readLeb128(bytes: Uint8Array, offset: number): Leb128 {
  let value = 0;
  let shift = 0;
  let length = 0;
  for (;;) {
    if (offset + length >= bytes.length) throw new Error("wasm: LEB128 runs past the end");
    if (length >= MAX_LEB128_BYTES) throw new Error("wasm: LEB128 longer than 5 bytes");
    const byte = bytes[offset + length];
    value += (byte & 0x7f) * 2 ** shift;
    length += 1;
    if ((byte & 0x80) === 0) return { value, length };
    shift += 7;
  }
}

/**
 * LEB128 for `value`, padded with redundant continuation bytes to exactly `length` bytes.
 *
 * This is what lets the rewrite happen in place. The spec allows the padding; the bytes it
 * adds carry no value bits, so a decoder reads the same number either way.
 */
export function encodeLeb128Padded(value: number, length: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) throw new Error("wasm: LEB128 needs a u32");
  if (length < 1 || length > MAX_LEB128_BYTES) throw new Error("wasm: LEB128 length out of range");
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = 0; i < length; i += 1) {
    out[i] = (rest & 0x7f) | (i === length - 1 ? 0 : 0x80);
    rest >>>= 7;
  }
  if (rest !== 0) throw new Error(`wasm: ${value} does not fit in ${length} LEB128 bytes`);
  return out;
}

function assertMagic(bytes: Uint8Array): void {
  if (bytes.length < WASM_MAGIC.length) throw new Error("wasm: too short to be a module");
  for (let i = 0; i < WASM_MAGIC.length; i += 1) {
    if (bytes[i] !== WASM_MAGIC[i]) throw new Error("wasm: not a WebAssembly module");
  }
}

/**
 * The limits of the single memory a module defines.
 *
 * Throws when the module defines no memory, or more than one: both mean the file is not
 * the core this build pins, and a silent pass there would ship an uncapped memory.
 */
export function readWasmMemoryLimits(bytes: Uint8Array): WasmMemoryLimits {
  assertMagic(bytes);
  let cursor = WASM_MAGIC.length;
  while (cursor < bytes.length) {
    const id = bytes[cursor];
    const size = readLeb128(bytes, cursor + 1);
    const body = cursor + 1 + size.length;
    if (id === MEMORY_SECTION_ID) {
      const count = readLeb128(bytes, body);
      if (count.value !== 1) throw new Error(`wasm: expected one memory, found ${count.value}`);
      const flagsOffset = body + count.length;
      const flags = bytes[flagsOffset];
      const initial = readLeb128(bytes, flagsOffset + 1);
      const hasMaximum = (flags & LIMITS_HAS_MAXIMUM) !== 0;
      const maximumOffset = flagsOffset + 1 + initial.length;
      const maximum = hasMaximum ? readLeb128(bytes, maximumOffset) : null;
      return {
        initialPages: initial.value,
        maximumPages: maximum === null ? null : maximum.value,
        shared: (flags & LIMITS_SHARED) !== 0,
        maximumOffset,
        maximumLength: maximum === null ? 0 : maximum.length,
      };
    }
    cursor = body + size.value;
  }
  throw new Error("wasm: no memory section");
}

/**
 * A copy of `bytes` whose memory maximum is `pages`, and which is not shared.
 *
 * Refuses to raise a ceiling: this exists to bring 2 GiB down to 256 MB, and a call that
 * would enlarge the declared maximum is a mistake worth failing on (§4).
 */
export function capWasmMaximumMemory(bytes: Uint8Array, pages: number): Uint8Array {
  const limits = readWasmMemoryLimits(bytes);
  if (limits.shared) throw new Error("wasm: the core declares a shared memory (§4 forbids it)");
  if (limits.maximumPages === null) throw new Error("wasm: the core declares no maximum to cap");
  if (pages > limits.maximumPages) {
    throw new Error(`wasm: refusing to raise the maximum from ${limits.maximumPages} to ${pages}`);
  }
  if (pages < limits.initialPages) {
    throw new Error(`wasm: ${pages} pages is below the module's initial ${limits.initialPages}`);
  }
  const out = new Uint8Array(bytes);
  out.set(encodeLeb128Padded(pages, limits.maximumLength), limits.maximumOffset);
  return out;
}
