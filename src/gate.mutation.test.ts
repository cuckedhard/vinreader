/**
 * [TA6 / SB-9] The mutation half of the §13.5 gate measures the suite the other half runs.
 *
 * Stryker's `ignorePatterns` decides what is copied into the sandbox, so a test file listed
 * there is not run — while the source it covers is still mutated and still scored. The
 * survivors that produces are not gaps in the suite; they are the exclusion, reported as if
 * it were evidence. `src/lib/storage/db.test.ts` sat there for exactly that reason (it moved
 * the clock through `process.env.TZ`, inert under the `threads` pool Stryker's vitest runner
 * pins), so §5.1's UTC-offset arithmetic in `nowIso` was mutation-scored with its own test
 * switched off. A23-a removed the pool dependence — `bunx vitest run
 * src/lib/storage/db.test.ts --pool=threads` passes — and the entry went with it.
 *
 * `ignorePatterns` is for build output and large fixtures. Nothing under `src/` belongs in
 * it, and this is the assertion that says so before the next round has to re-derive it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const CONFIG = fileURLToPath(new URL("../stryker.config.json", import.meta.url));

const config = JSON.parse(readFileSync(CONFIG, "utf8")) as {
  ignorePatterns: string[];
  mutate: string[];
  disableTypeChecks: string;
};

/** A negation in `mutate` narrows what is *mutated*; `ignorePatterns` narrows what *runs*. */
const excludedPaths = config.ignorePatterns.map((pattern) => pattern.replace(/^!/, ""));

it("[TA6] no source or test file under src/ is kept out of the mutation sandbox", () => {
  expect(excludedPaths.filter((path) => path.startsWith("src/"))).toEqual([]);
});

it("[SB-9] §5.1's nowIso is scored with db.test.ts running, not against it", () => {
  expect(excludedPaths).not.toContain("src/lib/storage/db.test.ts");
});

/**
 * [S5-M] And Stryker rewrites what it copies. `disableTypeChecks` defaults to `true`, which
 * prepends `// @ts-nocheck` to every JavaScript-and-friends file in the sandbox — vendored
 * ones included. `public/ocr/` holds four files of self-hosted OCR engine that
 * `assets.generated.ts` describes by size and digest, and sixteen extra bytes at the top of
 * one of them is a dry-run failure, which is not a low mutation score but no score at all.
 * Measured before it was scoped: `tesseract.esm.min.js: expected 63220 bytes, got 63236`.
 */
it("[S5-M] the vendored OCR engine is not rewritten on its way into the sandbox", () => {
  expect(config.disableTypeChecks, "a boolean here covers every file, vendored or not").toEqual(
    expect.any(String),
  );
  const covered = config.disableTypeChecks.split("{")[1]?.split("}")[0]?.split(",") ?? [];
  expect(covered).not.toContain("public");
  expect(covered.length, "the pattern names the directories it applies to").toBeGreaterThan(0);
});
