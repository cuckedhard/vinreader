/**
 * The single-file core, and the two places emscripten writes `MAXIMUM_MEMORY` into it.
 *
 * Patching only the wasm would leave the glue refusing growth against a 2 GiB number, and
 * patching only the glue would leave WebKit reserving 2 GiB at instantiation — which is
 * the failure §4 names. Both, or the build fails.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OCR_ASSETS } from "./assets.generated";
import { OCR_MAX_MEMORY_BYTES, OCR_MAX_MEMORY_PAGES } from "./constants";
import {
  capCoreMaximumMemory,
  countDefaultMemoryCeilings,
  findEmbeddedWasm,
  readCoreMemoryLimits,
} from "./coreBundle";

const CORE = fileURLToPath(new URL(`../../../public/ocr/${OCR_ASSETS.core.file}`, import.meta.url));

const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/** A module with one memory: initial 264 pages, maximum 32768 — emscripten's defaults. */
const MODULE = new Uint8Array([...MAGIC, 5, 7, 1, 1, 0x88, 0x02, 0x80, 0x80, 0x02]);

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** The shape of the real file: glue, one base64 string literal, more glue. */
function coreSource(module = MODULE): string {
  return (
    `var TesseractCore=(()=>{var wa=Ga("${base64(module)}");` +
    `return{u:a=>{if(2147483648<a)return!1;` +
    `var d=Math.min(2147483648,65536*a);return d}}})();`
  );
}

describe("findEmbeddedWasm", () => {
  it("finds the module by its own magic number", () => {
    expect([...findEmbeddedWasm(coreSource()).bytes]).toEqual([...MODULE]);
  });

  it("refuses a file with no module, two modules, or an unterminated one", () => {
    expect(() => findEmbeddedWasm("var x=1;")).toThrow(/no embedded/);
    expect(() => findEmbeddedWasm(coreSource() + coreSource())).toThrow(/more than one/);
    expect(() => findEmbeddedWasm(`Ga("${base64(MODULE)}`)).toThrow(/not terminated/);
  });
});

describe("capCoreMaximumMemory", () => {
  it("rewrites the module's maximum and both ceilings in the glue", () => {
    const capped = capCoreMaximumMemory(coreSource(), OCR_MAX_MEMORY_PAGES);
    expect(readCoreMemoryLimits(capped).maximumPages).toBe(OCR_MAX_MEMORY_PAGES);
    expect(countDefaultMemoryCeilings(capped)).toBe(0);
    expect(capped).toContain(`if(${OCR_MAX_MEMORY_BYTES}<a)`);
    expect(capped).toContain(`Math.min(${OCR_MAX_MEMORY_BYTES},`);
  });

  it("changes the glue only where the ceiling is written", () => {
    const source = coreSource();
    const capped = capCoreMaximumMemory(source, OCR_MAX_MEMORY_PAGES);
    const glue = (text: string): string => {
      const found = findEmbeddedWasm(text);
      return text.slice(0, found.start) + text.slice(found.end);
    };
    expect(glue(capped).split(String(OCR_MAX_MEMORY_BYTES)).join("2147483648")).toBe(glue(source));
  });

  it("refuses a glue that does not name the ceiling exactly twice", () => {
    const once = `Ga("${base64(MODULE)}");if(2147483648<a)return!1;`;
    expect(() => capCoreMaximumMemory(once, OCR_MAX_MEMORY_PAGES)).toThrow(/found 1/);
    expect(() => capCoreMaximumMemory(`${once}2147483648;2147483648;`, 4096)).toThrow(/found 3/);
  });

  it("counts ceilings in the glue and not in the base64 that surrounds nothing", () => {
    // "2147483648" is a legal base64 substring. A count taken over the whole file would
    // see three here and refuse a file that names the ceiling exactly twice.
    const padded = new Uint8Array([...MODULE, 0x00]);
    const digits = Uint8Array.from(atob("2147483648AA"), (c) => c.charCodeAt(0));
    const literal = base64(new Uint8Array([...padded, ...digits]));
    expect(literal).toContain("2147483648");

    const source = `Ga("${literal}");if(2147483648<a);Math.min(2147483648,1);`;
    expect(countDefaultMemoryCeilings(source)).toBe(2);
    expect(() => capCoreMaximumMemory(source, OCR_MAX_MEMORY_PAGES)).not.toThrow();
    expect(capCoreMaximumMemory(source, OCR_MAX_MEMORY_PAGES)).toContain("2147483648");
  });
});

describe("the core this build ships", () => {
  const source = readFileSync(CORE, "utf8");

  it("names 2 GiB nowhere: emscripten's default is gone from the glue as well", () => {
    expect(countDefaultMemoryCeilings(source)).toBe(0);
  });

  it("refuses growth past 256 MB in the glue, matching what the module declares", () => {
    expect(source).toContain(`if(${OCR_MAX_MEMORY_BYTES}<a)`);
    expect(source).toContain(`Math.min(${OCR_MAX_MEMORY_BYTES},`);
  });

  it("is the SIMD, LSTM-only build and not one of the other three", () => {
    // The four cores differ only in name once they are base64; the file name is the
    // record of which one was pinned, and §4 pins this one.
    expect(OCR_ASSETS.core.file).toBe("tesseract-core-simd-lstm.wasm.js");
  });
});
