/**
 * [F3] The stylesheet is a function of the source tree, and of nothing else on the disk.
 *
 * Tailwind v4 finds its sources by scanning the filesystem rather than by being told what
 * the app is. A build directory is therefore a source: the emitted HTML and the minified JS
 * inside it are mined for class names and fed back into the next stylesheet. It had already
 * happened — two utilities nothing under `src/` asks for were in the shipped CSS, extracted
 * out of `docs/assets/*.js`, where React's error overlay sets a font style inline. Their
 * names are assembled below rather than written, and so is the probe: this file is scanned
 * too, and spelling a class name here is exactly how that class comes back.
 *
 * `docs/` is the one that reaches the stylesheet, because it is the GitHub Pages build and
 * Pages serves it from the branch, so it cannot be git-ignored — and git-ignoring is the
 * only reason the other three never appeared. That is the dependency worth removing: an
 * ignore file for an unrelated tool should not decide what ships in the CSS.
 *
 * This runs the real pipeline rather than reading `index.css` for the words that fix it.
 * `@tailwindcss/node`'s `compile()` resolves the `@source` directives exactly as the Vite
 * plugin does, `@tailwindcss/oxide`'s `Scanner` walks the tree with what it computed, and
 * the CSS below is the CSS the app ships. A probe is planted in each build directory so the
 * assertion cannot pass by a directory merely being absent, and one real utility is asserted
 * present so it cannot pass by the scan having found nothing at all.
 *
 * Measured on this tree: with the directives, 26,581 bytes and neither stray rule; with them
 * deleted, 27,052 bytes, both rules, and 12 files scanned out of `docs/`.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { afterAll, beforeAll, expect, it } from "vitest";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(SRC, "..");
const ENTRY = resolve(SRC, "index.css");

/** Every directory a build in this repo writes into (§2's three Vite configs, and the PWA's). */
const BUILD_DIRS = ["dist", "docs", "dist-demo", "dev-dist"];

/** A class no source file uses and no dependency could plausibly contain. */
const PROBE_CLASS = ["mx-", "[1357px]"].join("");
const PROBE_FILE = "tailwind-source-probe.html";

/** The two rules the leak actually shipped, one a font style and one a filter. */
const STRAYS = [
  ["ital", "ic"],
  ["inv", "ert"],
].map((parts) => parts.join(""));

const created: string[] = [];

beforeAll(() => {
  for (const dir of BUILD_DIRS) {
    const path = resolve(ROOT, dir);
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
      created.push(path);
    }
    writeFileSync(resolve(path, PROBE_FILE), `<div class="${PROBE_CLASS}">probe</div>\n`);
  }
});

afterAll(() => {
  for (const dir of BUILD_DIRS) rmSync(resolve(ROOT, dir, PROBE_FILE), { force: true });
  for (const path of created) rmSync(path, { recursive: true, force: true });
});

/** The Vite plugin's own composition of the auto-detected root with the `@source` directives. */
async function buildStylesheet(): Promise<{ css: string; scanned: string[] }> {
  const compiler = await compile(readFileSync(ENTRY, "utf8"), {
    base: dirname(ENTRY),
    onDependency() {},
  });
  const sources = (
    compiler.root === "none"
      ? []
      : compiler.root === null
        ? [{ base: ROOT, pattern: "**/*", negated: false }]
        : [{ ...compiler.root, negated: false }]
  ).concat(compiler.sources);
  const scanner = new Scanner({ sources });
  return { css: compiler.build(scanner.scan()), scanned: scanner.files };
}

it("builds the stylesheet from the source tree and not from its own output", async () => {
  const { css, scanned } = await buildStylesheet();

  // The scan reached the app: without this the assertions below pass on an empty result.
  expect(css, "no utility was emitted at all — the scan found nothing").toMatch(/\.flex\s*\{/);

  const fromBuildOutput = scanned.filter((file) =>
    BUILD_DIRS.some((dir) => file.startsWith(`${resolve(ROOT, dir)}/`)),
  );
  expect(fromBuildOutput, "a build directory was scanned as a source").toEqual([]);

  // The probes, and the two rules that were shipping before the directives existed.
  expect(css).not.toContain("1357px");
  for (const stray of STRAYS) {
    expect(css, `.${stray} is in the stylesheet and no source file asks for it`).not.toMatch(
      new RegExp(`\\.${stray}\\s*\\{`),
    );
  }
});
