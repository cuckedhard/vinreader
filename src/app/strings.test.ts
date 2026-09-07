import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PAINT_LABEL, SAVE_FAILED_TITLE, STARTING_CAMERA } from "./strings";

/**
 * §7 item 5, for the strings: **one sentence, one place it is written.**
 *
 * Nothing else in the gate can see this. Typecheck, lint and every unit test are equally
 * happy with the same sentence typed into three files, and the browser renders all three —
 * so the app says one thing on one screen and something slightly different on another,
 * and the first anyone hears of it is a reader wondering which is right. It has already
 * happened twice here: SH-5 took ".json" out of three strings on the Import screen and
 * left a fourth saying it, and "Could not save" shipped as an inline literal on the Sheet
 * and again on the capture screen.
 *
 * The table below is not "every string in the app". It is the set with a known second
 * site — the ones the string audit found, plus the §6.4 lines another screen was caught
 * borrowing for a different fact. Adding a row is cheap; the rule for adding one is that
 * two files wanted the same words.
 *
 * Comments are stripped before the search, on purpose: a docblock that quotes the sentence
 * it is explaining is not a second definition, and both `CameraView` and
 * `PaintCaptureScreen` have one.
 */

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Every file that ships, as a path relative to `src/`. Tests and their helpers are not source. */
function sources(dir = ""): string[] {
  return readdirSync(`${SRC}${dir}`, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) return sources(`${path}/`);
    if (!/\.tsx?$/.test(entry.name)) return [];
    if (/\.(test|testutil)\.tsx?$/.test(entry.name)) return [];
    return [path];
  });
}

/**
 * The file with its comments removed.
 *
 * The line-comment rule keeps the character before `//`, so a `https://…` inside a string
 * survives — the only shape in this repo where the two are confusable.
 */
function code(path: string): string {
  return readFileSync(`${SRC}${path}`, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

interface OnePlace {
  text: string;
  /** Where the sentence is allowed to be written, relative to `src/`. */
  owner: string;
}

const ONE_PLACE: readonly OnePlace[] = [
  // Sheet field, Import preview row and chooser name, capture screen heading.
  { text: PAINT_LABEL, owner: "app/strings.ts" },
  // §6.4's Sheet banner, and the capture screen's save fails the same way.
  { text: SAVE_FAILED_TITLE, owner: "app/strings.ts" },
  // §6.4's Scan `requesting`, and the capture screen waits for the same camera.
  { text: STARTING_CAMERA, owner: "app/strings.ts" },
  /*
   * Not shared — spent. §6.4 gives this to the Scan `candidate` state, where it means a
   * first VIN has been seen and a second read is wanted, and the capture screen borrowed
   * it for frames going into a vote. Two facts, one sentence. It is typed out here rather
   * than imported because it lives inside `statusFor`, and a `.tsx` cannot be imported
   * under `environment: "node"`; if `CameraView` rewords it, this row goes red and is
   * meant to.
   */
  { text: "Reading… hold steady", owner: "features/scan/CameraView.tsx" },
];

describe("§7 item 5: a sentence the app says is defined once", () => {
  for (const { text, owner } of ONE_PLACE) {
    it(`"${text}" is written only in ${owner}`, () => {
      const found = sources().filter((path) => code(path).includes(text));
      expect(found).toEqual([owner]);
    });
  }
});
