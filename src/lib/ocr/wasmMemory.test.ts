/**
 * The two limits S5 addendum §4 pins, read off the bytes rather than off a build flag
 * nobody can check afterwards.
 *
 * The shipped-core assertions at the bottom are the ones that matter: `capCoreMaximumMemory`
 * runs once, at asset-build time, and its output is committed. Without a test that reads
 * `public/ocr/`, a regression in the build script is invisible until an iPhone OOMs at
 * instantiation — which is a device nobody in this loop has.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OCR_MAX_MEMORY_BYTES, OCR_MAX_MEMORY_PAGES } from "./constants";
import { findEmbeddedWasm, readCoreMemoryLimits } from "./coreBundle";
import { OCR_ASSETS } from "./assets.generated";
import {
  capWasmMaximumMemory,
  encodeLeb128Padded,
  readWasmMemoryLimits,
  WASM_PAGE_BYTES,
} from "./wasmMemory";

const CORE = fileURLToPath(new URL(`../../../public/ocr/${OCR_ASSETS.core.file}`, import.meta.url));

const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/** A module carrying nothing but one memory declaration. */
function memoryModule(options: {
  initial: number[];
  maximum?: number[];
  shared?: boolean;
  count?: number;
}): Uint8Array {
  const flags = (options.maximum === undefined ? 0 : 1) | (options.shared === true ? 2 : 0);
  const body = [options.count ?? 1, flags, ...options.initial, ...(options.maximum ?? [])];
  return new Uint8Array([...MAGIC, 5, body.length, ...body]);
}

describe("encodeLeb128Padded", () => {
  it("writes 4096 into the three bytes 32768 occupied", () => {
    expect([...encodeLeb128Padded(4096, 3)]).toEqual([0x80, 0xa0, 0x00]);
  });

  it("round-trips through the reader at every padded width", () => {
    for (let length = 3; length <= 5; length += 1) {
      const module = memoryModule({ initial: [1], maximum: [...encodeLeb128Padded(4096, length)] });
      expect(readWasmMemoryLimits(module).maximumPages).toBe(4096);
    }
  });

  it("refuses a value that does not fit the width it was given", () => {
    expect(() => encodeLeb128Padded(4096, 1)).toThrow(/does not fit/);
  });

  it("refuses a width outside the 1–5 bytes a u32 may occupy", () => {
    expect(() => encodeLeb128Padded(1, 6)).toThrow(/length out of range/);
    expect(() => encodeLeb128Padded(1, 0)).toThrow(/length out of range/);
  });

  it("refuses a value that is not a whole non-negative number", () => {
    expect(() => encodeLeb128Padded(-1, 3)).toThrow(/u32/);
    expect(() => encodeLeb128Padded(1.5, 3)).toThrow(/u32/);
  });
});

describe("readWasmMemoryLimits", () => {
  it("reads the minimum, the maximum and the shared bit", () => {
    const limits = readWasmMemoryLimits(
      memoryModule({ initial: [0x88, 0x02], maximum: [0x80, 0x80, 0x02] }),
    );
    expect(limits).toMatchObject({ initialPages: 264, maximumPages: 32768, shared: false });
  });

  it("reports a memory with no declared maximum as null rather than as zero", () => {
    expect(readWasmMemoryLimits(memoryModule({ initial: [1] })).maximumPages).toBeNull();
  });

  it("reports a shared memory as shared", () => {
    const module = memoryModule({ initial: [1], maximum: [2], shared: true });
    expect(readWasmMemoryLimits(module).shared).toBe(true);
  });

  it("refuses anything that is not a module, or that declares no single memory", () => {
    expect(() => readWasmMemoryLimits(new Uint8Array([1, 2, 3]))).toThrow(/too short/);
    expect(() => readWasmMemoryLimits(new Uint8Array([...MAGIC].fill(0)))).toThrow(/not a Web/);
    expect(() => readWasmMemoryLimits(new Uint8Array(MAGIC))).toThrow(/no memory section/);
    expect(() => readWasmMemoryLimits(memoryModule({ initial: [1], count: 2 }))).toThrow(
      /expected one memory/,
    );
  });

  it("walks past other sections to reach the memory one", () => {
    const module = memoryModule({ initial: [1], maximum: [2] });
    // A type section of three bytes, spliced in ahead of the memory section.
    const withType = new Uint8Array([...MAGIC, 1, 3, 9, 9, 9, ...module.subarray(MAGIC.length)]);
    expect(readWasmMemoryLimits(withType).maximumPages).toBe(2);
  });

  it("refuses a LEB128 that never terminates", () => {
    const runaway = new Uint8Array([...MAGIC, 5, 8, 1, 1, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80]);
    expect(() => readWasmMemoryLimits(runaway)).toThrow(/LEB128/);
  });
});

describe("capWasmMaximumMemory", () => {
  const module = memoryModule({ initial: [0x88, 0x02], maximum: [0x80, 0x80, 0x02] });

  it("lowers the ceiling without moving a byte", () => {
    const capped = capWasmMaximumMemory(module, 4096);
    expect(capped.length).toBe(module.length);
    expect(readWasmMemoryLimits(capped).maximumPages).toBe(4096);
    expect(readWasmMemoryLimits(capped).initialPages).toBe(264);
  });

  it("refuses to raise a ceiling, to cap below the minimum, or to touch a shared memory", () => {
    expect(() => capWasmMaximumMemory(module, 65536)).toThrow(/refusing to raise/);
    expect(() => capWasmMaximumMemory(module, 1)).toThrow(/below the module's initial/);
    expect(() =>
      capWasmMaximumMemory(memoryModule({ initial: [1], maximum: [2], shared: true }), 2),
    ).toThrow(/shared memory/);
    expect(() => capWasmMaximumMemory(memoryModule({ initial: [1] }), 1)).toThrow(/no maximum/);
  });
});

describe("the core this build ships", () => {
  const source = readFileSync(CORE, "utf8");

  it("declares a 256 MB maximum, which is what WebKit reserves up front (§4)", () => {
    const limits = readCoreMemoryLimits(source);
    expect(limits.maximumPages).toBe(OCR_MAX_MEMORY_PAGES);
    expect(limits.maximumPages! * WASM_PAGE_BYTES).toBe(OCR_MAX_MEMORY_BYTES);
  });

  it("declares an unshared memory: there is no COOP/COEP on GitHub Pages (§4)", () => {
    expect(readCoreMemoryLimits(source).shared).toBe(false);
  });

  it("is still a module a WebAssembly engine will accept after the rewrite", () => {
    expect(WebAssembly.validate(Uint8Array.from(findEmbeddedWasm(source).bytes))).toBe(true);
  });
});
