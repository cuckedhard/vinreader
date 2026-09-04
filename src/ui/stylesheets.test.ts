import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Why this file exists, in one sentence: **a rule written outside every cascade layer beats
 * every Tailwind utility in the app, and nothing else in the gate can see it.**
 *
 * `@import "tailwindcss"` puts everything Tailwind generates inside `@layer theme, base,
 * components, utilities`. The cascade sorts unlayered author declarations *after* every
 * layered one, and consults specificity only within a bucket — so a bare `:focus-visible`
 * in `src/index.css` outranks `.focus-visible\:outline-offset-\[-3px\]:focus-visible` and
 * anything else a utility class can produce, everywhere, forever. tsc does not read CSS;
 * vitest runs in `node` with no DOM and no stylesheets; the browser applies the winning
 * declaration and reports no error. There is no other instrument in this repo.
 *
 * It has already happened once (R3-U-b). `src/index.css` ended with an unlayered
 * `:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px }` from the day
 * Tailwind v4 landed, which made every `focus-visible:outline-*` class in the repo inert.
 * It hid for two years' worth of commits because `Button`'s ring happens to ask for exactly
 * those values; the one control that asked for something else — the scan preview's tap
 * target, `outline-offset: -3px` so its `overflow-hidden` parent could not clip the ring —
 * was silently given `+2px`, drawn outside the clip, and showed no focus indicator at all
 * (§6.6 "visible focus ring", WCAG 2.4.7).
 *
 * So these tests read the stylesheets as text and assert the *property* rather than the
 * shape of the fix: not "`@layer base` appears in the file" (a second unlayered rule added
 * further down would still pass that), but "no `:focus` rule anywhere in `src/**` sits
 * outside a layer, and the app-wide ring sits in a layer that a utility can outrank".
 *
 * If one of these fails, the fix is to move the offending rule into a layer — `@layer base`
 * for a default that components may override, `@layer components` for a primitive's own
 * styling — or, if it genuinely must sit outside every layer, to add it to `UNLAYERED_RULES`
 * below with the reason it cannot collide with a utility. Deleting the assertion puts the
 * repo back where it was: a whole family of classes quietly doing nothing.
 */

const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Every stylesheet the app ships, as paths relative to `src/`. */
const STYLESHEETS = readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
  .map((name) => name.replaceAll("\\", "/"))
  .filter((name) => name.endsWith(".css"))
  .sort();

/** A style rule (not an at-rule) found in a stylesheet, with the at-rules enclosing it. */
interface StyleRule {
  /** Path relative to `src/`. */
  file: string;
  /** Whitespace-collapsed selector list, e.g. `html, body, #root`. */
  selector: string;
  /** Enclosing at-rule preludes, outermost first, e.g. `["@layer base"]`. */
  enclosing: readonly string[];
  /** Everything between the braces, nested blocks included. */
  body: string;
  /** 1-based line the selector starts on, so a failure names the rule to go and look at. */
  line: number;
}

function countNewlines(text: string): number {
  return text.split("\n").length - 1;
}

/**
 * A deliberately small CSS reader: it tracks comments, quoted strings and brace depth,
 * which is all that is needed to answer "is this rule inside an at-rule, and which one".
 * It is not a CSS parser and does not need to be — nothing below reads a declaration's
 * value, only whether a property name is present.
 */
function styleRules(file: string, css: string): StyleRule[] {
  const found: StyleRule[] = [];
  const open: { prelude: string; bodyStart: number; line: number }[] = [];
  let prelude = "";
  let preludeLine = 1;
  let line = 1;

  for (let i = 0; i < css.length; i += 1) {
    const char = css[i];

    if (char === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      const stop = end === -1 ? css.length : end + 2;
      line += countNewlines(css.slice(i, stop));
      i = stop - 1;
      prelude += " ";
      continue;
    }

    if (char === '"' || char === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== char) j += css[j] === "\\" ? 2 : 1;
      prelude += css.slice(i, j + 1);
      i = j;
      continue;
    }

    if (char === "\n") {
      line += 1;
      prelude += " ";
      continue;
    }

    if (char === "{") {
      open.push({
        prelude: prelude.trim().replaceAll(/\s+/g, " "),
        bodyStart: i + 1,
        line: preludeLine,
      });
      prelude = "";
      preludeLine = line;
      continue;
    }

    if (char === "}") {
      const block = open.pop();
      // An at-rule (`@layer base`, `@media …`, `@theme inline`) is context, not a rule.
      if (block !== undefined && !block.prelude.startsWith("@")) {
        found.push({
          file,
          selector: block.prelude,
          enclosing: open.map((entry) => entry.prelude),
          body: css.slice(block.bodyStart, i),
          line: block.line,
        });
      }
      prelude = "";
      preludeLine = line;
      continue;
    }

    // A declaration or a statement at-rule (`@import "tailwindcss";`) — never a rule.
    if (char === ";") {
      prelude = "";
      preludeLine = line;
      continue;
    }

    if (prelude.trim() === "") preludeLine = line;
    prelude += char;
  }

  return found;
}

const ALL_RULES = STYLESHEETS.flatMap((file) =>
  styleRules(file, readFileSync(new URL(`../${file}`, import.meta.url), "utf8")),
);

/**
 * The name of the innermost cascade layer a rule sits in, `""` for an anonymous `@layer {}`,
 * or `null` for "outside every layer" — which is the dangerous one.
 */
function layerOf(rule: StyleRule): string | null {
  for (let i = rule.enclosing.length - 1; i >= 0; i -= 1) {
    const at = rule.enclosing[i];
    if (!/^@layer\b/.test(at)) continue;
    return /^@layer\s+([\w-]+)/.exec(at)?.[1] ?? "";
  }
  return null;
}

/** `index.css:61 — :focus-visible` — enough to go and look at it. */
function where(rule: StyleRule): string {
  return `${rule.file}:${rule.line} — ${rule.selector}`;
}

/**
 * Tailwind declares its layer order as `@layer theme, base, components, utilities`, so a
 * rule in any of the first three loses to a utility that sets the same property — which is
 * what makes an app-wide default a *default*. A rule in `utilities`, in a layer declared
 * after Tailwind's, or in an anonymous layer would beat the utilities instead, quietly
 * reproducing R3-U-b one layer up.
 */
const BEATABLE_BY_A_UTILITY = ["theme", "base", "components"];

/**
 * Every rule allowed to sit outside all layers, with the reason it cannot collide with a
 * utility. The bar for a new entry: no Tailwind utility can ever set one of the properties
 * it declares on one of the elements it selects — which in practice means the element never
 * carries a class at all. A second rule with a selector already listed here also fails,
 * deliberately: two unlayered rules for the same selector is exactly how R3-U-b would come
 * back after this file was written.
 */
const UNLAYERED_RULES: Record<string, string> = {
  "html, body, #root":
    "Sets height on three elements that carry no class. `#root` is written in index.html " +
    "and React renders inside it; the shell's own `h-full` is on a child div.",
  body:
    "The page ground and default font. `<body>` carries no class — every screen is inside " +
    "`#root` — so no utility can be competing for these properties.",
  'button, a[role="button"]':
    "N5's `-webkit-touch-callout: none`. Tailwind has no utility for that property in any " +
    "version, so there is nothing for it to outrank.",
  ':root, [data-theme="dark"]':
    "§6.1 palette. Custom properties only, and none of these names (`--bg`, `--fg`, " +
    "`--tap`, `--vin-font`, …) is one Tailwind emits; `@theme inline` in index.css maps " +
    "the Tailwind-facing names onto them rather than the other way round.",
  '[data-theme="light"]':
    "The light palette, overriding the block above by document order at equal specificity " +
    "— which is only true while both stay unlayered together. Same custom-property-only " +
    "reasoning.",
};

describe("app stylesheets and the cascade layers they live in", () => {
  it("is reading the stylesheets it thinks it is", () => {
    // A glob that quietly matched nothing would make every assertion below vacuous.
    expect(STYLESHEETS).toContain("index.css");
    expect(STYLESHEETS).toContain("ui/tokens.css");
    expect(ALL_RULES.length).toBeGreaterThan(0);
  });

  it("keeps every focus rule inside a cascade layer, where a component can still override it", () => {
    const focusRules = ALL_RULES.filter((rule) => rule.selector.includes(":focus"));
    expect(focusRules.length).toBeGreaterThan(0);

    // Not "the file mentions @layer" — every single focus rule, wherever it was added.
    const unlayered = focusRules.filter((rule) => layerOf(rule) === null).map(where);
    expect(unlayered).toEqual([]);
  });

  it("still ships the §6.6 default focus ring, in a layer a utility can outrank", () => {
    // The other half of the property: the guard above is also satisfied by deleting the
    // ring, which would leave §6.6 with no visible indicator on anything that states none.
    const ring = ALL_RULES.filter(
      (rule) =>
        rule.selector.includes(":focus-visible") && /(?:^|[\s;])outline\s*:/.test(rule.body),
    );
    expect(ring.length).toBeGreaterThan(0);

    const wrongLayer = ring
      .filter((rule) => !BEATABLE_BY_A_UTILITY.includes(layerOf(rule) ?? " "))
      .map((rule) => `${where(rule)} (layer: ${layerOf(rule) ?? "none"})`);
    expect(wrongLayer).toEqual([]);
  });

  it("adds nothing outside the layers beyond the documented resets", () => {
    // The general form of R3-U-b: any unlayered rule outranks every utility for the
    // properties it sets. Read `UNLAYERED_RULES` above before adding to it.
    const unlayered = ALL_RULES.filter((rule) => layerOf(rule) === null)
      .map((rule) => rule.selector)
      .sort();
    expect(unlayered).toEqual(Object.keys(UNLAYERED_RULES).sort());
  });
});
