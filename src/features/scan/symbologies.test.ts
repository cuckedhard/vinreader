/**
 * §4.6, pinned. N6 says the §4 constants are authoritative and that tests pin them; the
 * four symbologies, their priority order and `TRY_HARDER` were the one §4 constant in the
 * S1 scope with no test at all.
 *
 * It is pinned by reading the source rather than by calling the code, because both places
 * that hold the list are unreachable from a unit test: `buildHints` is module-private inside
 * a React hook that wants a `<video>`, and `bench/decode.ts` pulls in `sharp`. `decode.ts`
 * says of its own copy that "the two lists are asserted to agree" — this is that assertion.
 * Exporting the hint builder would let this become a behavioural test, which is better; a
 * text pin that catches the drift is still worth more than the nothing that was here.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** §4.6, verbatim: "CODE_39, CODE_128, DATA_MATRIX, QR_CODE", in that priority order. */
const SPEC_FORMATS = ["CODE_39", "CODE_128", "DATA_MATRIX", "QR_CODE"];

/** §4.10 `Symbology`, the camera members, in the same order. */
const SPEC_SYMBOLOGIES = ["code_39", "code_128", "data_matrix", "qr_code"];

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

/** The `BarcodeFormat.X` names inside the array literal assigned after `marker`. */
function formatsAfter(source: string, marker: string): string[] {
  const from = source.indexOf(marker);
  expect(from, `${marker} is gone`).toBeGreaterThan(-1);
  // The first multi-line array literal after the marker. Matching a bare `[` would find
  // the type annotation in `readonly BarcodeFormat[]` first.
  const open = from + source.slice(from).search(/\[\s*\n/);
  const close = source.indexOf("]", open);
  expect(close, `no array literal assigned after ${marker}`).toBeGreaterThan(open);
  return [...source.slice(open, close).matchAll(/BarcodeFormat\.([A-Z_0-9]+)/g)].map(
    (match) => match[1] ?? "",
  );
}

describe("§4.6 symbologies", () => {
  const scanner = read("./useScanner.ts");

  it("enables exactly the four §4.6 formats, in §4.6 order", () => {
    expect(formatsAfter(scanner, "POSSIBLE_FORMATS")).toEqual(SPEC_FORMATS);
  });

  it("sets TRY_HARDER", () => {
    expect(scanner).toMatch(/DecodeHintType\.TRY_HARDER\s*,\s*true/);
  });

  it("maps every enabled format to its §4.10 symbology and nothing else", () => {
    // `toSymbology` returns null for anything else, which drops the read — so a format
    // enabled in the hints but missing here would decode and then silently vanish.
    const cases = [...scanner.matchAll(/case BarcodeFormat\.([A-Z_0-9]+):\s*\n\s*return "([a-z_0-9]+)"/g)];
    expect(cases.map((match) => match[1])).toEqual(SPEC_FORMATS);
    expect(cases.map((match) => match[2])).toEqual(SPEC_SYMBOLOGIES);
  });

  it("decodes the bench corpus with the same four formats the app enables", () => {
    // §13.4: the bench measures "the pipeline the product ships". Its hint list is a copy,
    // and nothing until now compared the copy with the original.
    expect(formatsAfter(read("../../../bench/decode.ts"), "BENCH_FORMATS")).toEqual(SPEC_FORMATS);
    expect(read("../../../bench/decode.ts")).toMatch(/DecodeHintType\.TRY_HARDER\s*,\s*true/);
  });
});
