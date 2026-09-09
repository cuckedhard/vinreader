/**
 * [GATE-1] The typecheck half of the §13.5 gate reads the files it reports on.
 *
 * `bun run typecheck` is a bare `tsc --noEmit`, and `bun run build` — §7 item 1's other
 * half — is that same command followed by `vite build`. Both take their file set from one
 * place: `include` in `tsconfig.json`. Whatever that list does not match is never opened,
 * and a step that never opens a file still reports green over it.
 *
 * It did. `include` named `src`, `scripts`, `bench` and four vite/vitest configs, so the
 * 46 Playwright specs and helpers under `tests/` — 7.5k lines, including the ENV-1 cache
 * with its pid parsing, atomic renames and prune — were checked by ESLint
 * (`eslint.config.js` names the whole `tests` tree) and by nothing else. Types were the missing
 * half, and types are the half that catches a helper's signature drifting away from its
 * callers: `writeQrY4m(name, [[text, frames], ...])` called with the pair reversed
 * compiles to nothing at all under the old list and produces a garbage video at runtime.
 * `playwright.config.ts` and `vitest.stryker.config.ts` were outside it too, both of them
 * added to the repo long after the four names were written down.
 *
 * So the assertions below are about the *file set*, not the spelling of `include`. They
 * expand the config the way `tsc` does — `parseJsonConfigFileContent` applies the same
 * `include`/`exclude` semantics against the same disk — and then ask whether every file
 * that ought to be checked is in the answer. A pattern rewrite that still covers
 * everything passes; an `exclude` added later that quietly subtracts `tests/e2e` does not,
 * which is why there is no assertion here about `include` having any particular shape.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import { commandSteps, flagValue, invokes, positionals } from "./gate.scripts.testutil";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG = resolve(ROOT, "tsconfig.json");

/** The root file set `tsc --noEmit` starts from, as paths relative to the repo root. */
function program(): { files: Set<string>; options: ts.CompilerOptions } {
  const read = ts.readConfigFile(CONFIG, ts.sys.readFile);
  expect(read.error, "tsconfig.json parses").toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT, undefined, CONFIG);
  expect(
    parsed.errors.filter((error) => error.category === ts.DiagnosticCategory.Error),
    "tsconfig.json resolves without errors",
  ).toEqual([]);
  return {
    files: new Set(parsed.fileNames.map((file) => relative(ROOT, file))),
    options: parsed.options,
  };
}

/** Every `.ts`/`.tsx` file under `dir`, relative to the repo root. */
function sourcesUnder(dir: string): string[] {
  return readdirSync(resolve(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourcesUnder(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

it("[GATE-1] every Playwright spec and helper is in the typecheck's file set", () => {
  const specs = sourcesUnder("tests");

  // The guard fails if the tree is empty, so it cannot pass by finding nothing to check.
  expect(specs.length, "tests/ holds the e2e suite").toBeGreaterThan(40);
  expect(specs).toContain(join("tests", "e2e", "qr-video.ts"));

  const { files } = program();
  expect(specs.filter((spec) => !files.has(spec))).toEqual([]);
});

it("[GATE-1] every root config file is in the typecheck's file set", () => {
  const configs = readdirSync(ROOT)
    .filter((name) => name.endsWith(".config.ts"))
    .sort();

  // Named rather than only counted: these two are the ones the enumerated list had missed,
  // and an assertion that merely counted would pass while either was gone.
  expect(configs).toContain("playwright.config.ts");
  expect(configs).toContain("vitest.stryker.config.ts");

  const { files } = program();
  expect(configs.filter((config) => !files.has(config))).toEqual([]);
});

/**
 * And they are checked the way `src/` is checked. One program, one set of flags: bringing
 * the specs in under a relaxed copy of the options would report a different kind of green.
 */
it("[GATE-1] the specs are held to src's strictness, not a weaker one", () => {
  const { options } = program();
  expect({
    strict: options.strict,
    noUnusedLocals: options.noUnusedLocals,
    noUnusedParameters: options.noUnusedParameters,
    noFallthroughCasesInSwitch: options.noFallthroughCasesInSwitch,
    noImplicitOverride: options.noImplicitOverride,
  }).toEqual({
    strict: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    noFallthroughCasesInSwitch: true,
    noImplicitOverride: true,
  });
});

/**
 * [GATE-1a] And the commands run the config this file just checked.
 *
 * Everything above reads `tsconfig.json`. Nothing above reads `package.json`, and the gate is
 * not a config — it is `bun run typecheck`, `bun run build` and `bun run pages:build`. All
 * three invoke a bare `tsc --noEmit`, which takes the implicit `./tsconfig.json`; repoint any
 * one of them at another config and the program moves while every assertion above stays
 * green. The GATE-1 reviewer raised it and measured it: `"typecheck": "tsc --noEmit -p
 * tsconfig.app.json"` passed 3 of 3.
 *
 * So this walks the scripts instead of naming a file. Every step of every script that invokes
 * `tsc` has to resolve to the same config — explicitly (`-p` / `--project` / `--build`) or
 * implicitly — and the three known callers have to still be among them, so the assertion
 * cannot pass by finding nothing to check.
 */
const scripts = (
  JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

/** The flags that take a project path. `--build` mode reads them as positionals instead. */
const PROJECT_FLAGS = ["-p", "--project"];

/**
 * Every config a `tsc` step would read, absolute. `tsc` with no project flag takes the
 * `tsconfig.json` nearest its working directory, which for `bun run` is the repo root — so an
 * implicit invocation resolves to exactly the file the assertions above open. A directory
 * argument means the `tsconfig.json` inside it, the way `tsc` reads it.
 */
function configsRead(tokens: string[]): string[] {
  const inBuildMode = tokens.some((token) => token === "-b" || token === "--build");
  const project = flagValue(tokens, PROJECT_FLAGS);
  const named = [
    ...(project === null ? [] : [project]),
    ...(inBuildMode ? positionals(tokens, PROJECT_FLAGS) : []),
  ];
  if (named.length === 0) return [resolve(ROOT, "tsconfig.json")];
  return named.map((name) => {
    const path = resolve(ROOT, name);
    return path.endsWith(".json") ? path : resolve(path, "tsconfig.json");
  });
}

/** `script name → every config its `tsc` steps read`. Scripts that never run `tsc` are absent. */
function tscCallers(): Map<string, string[]> {
  const callers = new Map<string, string[]>();
  for (const [name, command] of Object.entries(scripts)) {
    const configs = commandSteps(command)
      .filter((tokens) => invokes(tokens, "tsc"))
      .flatMap(configsRead);
    if (configs.length > 0) callers.set(name, configs);
  }
  return callers;
}

it("[GATE-1a] every script that runs tsc runs the config these assertions read", () => {
  const callers = tscCallers();

  // Cannot pass by finding nothing: these are §13.5's typecheck step and §7 item 1's two
  // builds, and a guard over an empty set of callers is the defect this row is about.
  expect([...callers.keys()].sort(), "the three scripts that run tsc").toEqual(
    expect.arrayContaining(["build", "pages:build", "typecheck"]),
  );

  const elsewhere = [...callers].flatMap(([name, configs]) =>
    configs.filter((config) => config !== CONFIG).map((config) => `${name} → ${config}`),
  );
  expect(elsewhere, "a tsc step pointed at a config this file never opens").toEqual([]);
});
