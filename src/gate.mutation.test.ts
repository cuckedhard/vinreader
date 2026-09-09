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
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { commandSteps, invokes, positionals } from "./gate.scripts.testutil";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG = resolve(ROOT, "stryker.config.json");

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

/**
 * [GATE-1a] And `bun run mutate` reads the file every assertion above opened.
 *
 * The same hole GATE-1a found in `src/gate.typecheck.test.ts`, in the same shape: everything
 * above asserts what `stryker.config.json` *contains*, and nothing above asks whether the
 * command §13.5 names would open that file. `"mutate": "stryker run"` names no config, and
 * Stryker resolves an unnamed one by walking `SUPPORTED_CONFIG_FILE_NAMES` and taking the
 * first that exists on disk — `stryker.conf.json`, `.js`, `.mjs`, `.cjs`, and only then
 * `stryker.config.json`. Four names outrank the one this file reads, so adding any of them
 * would silently move the whole mutation half of the gate while every assertion above stayed
 * green. The config file is also a **positional** argument in Stryker 10 (`stryker run
 * [configFile]`, `stryker-cli.js`; `-c` is `--concurrency`), which is an easier thing to add
 * by accident than a flag.
 */
const scripts = (
  JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

/**
 * Stryker's own config-file family, from `config-file-formats.js`: prefix `''` or `'.'`, suffix
 * `.conf` or `.config`, extension `json`, `js`, `mjs` or `cjs`. Re-derived rather than imported
 * because `@stryker-mutator/core` does not export it — the deep path is not in its `exports`.
 */
const STRYKER_CONFIG_NAME = /^\.?stryker\.(conf|config)\.(json|js|mjs|cjs)$/;

/** The `stryker run` flags that consume the token after them (`stryker-cli.js`). */
const STRYKER_VALUE_FLAGS = [
  "-f",
  "--files",
  "-m",
  "--mutate",
  "-t",
  "--testFiles",
  "-b",
  "--buildCommand",
  "-c",
  "--concurrency",
  "--reporters",
  "--plugins",
  "--timeoutMS",
  "--maxTestRunnerReuse",
];

it("[GATE-1a] `bun run mutate` names no config other than the one asserted here", () => {
  const step = commandSteps(scripts.mutate ?? "").find((tokens) => invokes(tokens, "stryker"));
  expect(step, "`bun run mutate` invokes stryker at all").toBeDefined();

  const args = positionals(step ?? [], STRYKER_VALUE_FLAGS);
  expect(args[0], "the `run` subcommand").toBe("run");

  // `stryker run [configFile]`: no positional means the implicit walk below, one means that
  // file. Anything else is a value this guard did not know was a value, and saying so is
  // better than reading it as a config path.
  const named = args.slice(1);
  expect(named.length, `unexpected positional arguments: ${named.join(" ")}`).toBeLessThanOrEqual(
    1,
  );
  const read = named.length === 0 ? CONFIG : resolve(ROOT, named[0]);
  expect(read, "the config `bun run mutate` would read").toBe(CONFIG);
});

it("[GATE-1a] no config file outranks stryker.config.json on the implicit walk", () => {
  const present = readdirSync(ROOT)
    .filter((name) => STRYKER_CONFIG_NAME.test(name))
    .sort();

  // Cannot pass by finding nothing: the file every assertion above reads has to be one of them.
  expect(present, "the repo's Stryker config").toContain("stryker.config.json");
  expect(
    present,
    "a second Stryker config would win the walk and no assertion here reads it",
  ).toEqual(["stryker.config.json"]);
});
