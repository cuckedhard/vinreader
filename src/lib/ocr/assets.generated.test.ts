/**
 * The generated manifest against the files it describes.
 *
 * `assets.generated.ts` is what the runtime verifies a 4.5 MB download against, so it is
 * the one file in this slice where a stale number is silent: a manifest that disagreed
 * with `public/ocr/` would reject the correct asset forever, and one regenerated from the
 * wrong inputs would accept the wrong one. Nothing else in the gate reads these bytes.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { OCR_ASSETS, OCR_ASSET_LIST, OCR_TOTAL_BYTES } from "./assets.generated";

const DIR = fileURLToPath(new URL("../../../public/ocr/", import.meta.url));

function onDisk(file: string): Buffer {
  return readFileSync(`${DIR}${file}`);
}

it("describes every file in public/ocr, at the size and digest it has", () => {
  for (const spec of OCR_ASSET_LIST) {
    const bytes = onDisk(spec.file);
    expect(bytes.length, `${spec.file} size`).toBe(spec.bytes);
    expect(createHash("sha256").update(bytes).digest("hex"), `${spec.file} digest`).toBe(
      spec.sha256,
    );
  }
});

it("lists all four assets, and the model among them", () => {
  expect(OCR_ASSET_LIST).toEqual([
    OCR_ASSETS.runtime,
    OCR_ASSETS.worker,
    OCR_ASSETS.core,
    OCR_ASSETS.model,
  ]);
});

it("totals what the four cost, which is what a download can be shown as before it starts", () => {
  const measured = OCR_ASSET_LIST.reduce((sum, spec) => sum + onDisk(spec.file).length, 0);
  expect(OCR_TOTAL_BYTES).toBe(measured);
});

it("costs 4.48 MB, against an app that is 1.3 MB (§3)", () => {
  // Not a limit — a number that has to move visibly if anyone adds a language, a second
  // core, or the legacy engine.
  expect(OCR_TOTAL_BYTES).toBe(4_483_231);
});
