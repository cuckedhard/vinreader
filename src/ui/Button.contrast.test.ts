import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Why this file exists: **§6.1's 7:1 floor has no exemption for disabled controls, and
 * nothing else in the gate can see a colour.**
 *
 * WCAG does exempt them, on purpose — a disabled control that reads exactly like an
 * enabled one is its own failure. §6.1 grants no such exemption, and for this app that is
 * the right call: gloves, snow glare, night shift, one hand free. Both things have to be
 * true at once, so the disabled state has to say "unavailable" with something other than
 * contrast, and then keep its label above 7:1 anyway.
 *
 * `disabled:opacity-40` did the opposite of that. Element opacity composites the fill and
 * the label together over whatever is behind them, so the label's contrast against its own
 * ground collapses — measured 2.26–3.59:1 in dark and 1.97–2.62:1 in light, across four
 * variants over both grounds — while the pair still looks merely dim. No opacity value
 * fixes it; the two colours move in lockstep by construction.
 *
 * So the numbers here are the specification, not decoration. tsc does not read CSS, vitest
 * runs in `node` with no DOM and no stylesheets, and a colour regression shows up as a
 * screenshot nobody took. This file reads `tokens.css` and `Button.tsx` as text, resolves
 * the class list the way the cascade would, composites what the user actually sees, and
 * computes real WCAG 2.x ratios from it. It fails on a ratio, and it also fails if the
 * *other* half goes — if disabled stops looking disabled — because a fix in one direction
 * is exactly how the other one gets broken.
 */

const HERE = new URL(".", import.meta.url);
const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, HERE)), "utf8");

/** Comments carry `--token` names and stray punctuation; nothing below wants to see them. */
const strip = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, " ").replaceAll(/^\s*\/\/.*$/gm, " ");

const TOKENS_CSS = strip(read("tokens.css"));
const BUTTON_TSX = strip(read("Button.tsx"));

/* ------------------------------------------------------------------ colour maths (WCAG 2.x) */

type Rgb = readonly [number, number, number];

function channel(value: number): number {
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(color: Rgb): number {
  return (
    0.2126 * channel(color[0] / 255) +
    0.7152 * channel(color[1] / 255) +
    0.0722 * channel(color[2] / 255)
  );
}

function contrast(a: Rgb, b: Rgb): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/** Distance from grey in 8-bit channels: 0 is neutral, ~168 is `--accent`. */
function chroma(color: Rgb): number {
  return Math.max(...color) - Math.min(...color);
}

/** Source-order compositing of an element's pixels over its backdrop at `alpha`. */
function mix(color: Rgb, ground: Rgb, alpha: number): Rgb {
  return [
    Math.round(alpha * color[0] + (1 - alpha) * ground[0]),
    Math.round(alpha * color[1] + (1 - alpha) * ground[1]),
    Math.round(alpha * color[2] + (1 - alpha) * ground[2]),
  ];
}

function parseHex(value: string): Rgb {
  const match = /^#([\da-f]{6})$/i.exec(value.trim());
  if (match === null) throw new Error(`tokens.css: not a 6-digit hex colour: ${value}`);
  const packed = Number.parseInt(match[1], 16);
  return [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff];
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
const show = (color: Rgb): string =>
  `#${color.map((c) => c.toString(16).padStart(2, "0")).join("")}`;

/* ------------------------------------------------------------------------------ the palette */

interface CssBlock {
  selector: string;
  declarations: Map<string, string>;
}

const CSS_BLOCKS: CssBlock[] = [...TOKENS_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((block) => ({
  selector: block[1].replaceAll(/\s+/g, " ").trim(),
  declarations: new Map(
    [...block[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((d) => [d[1], d[2].trim()]),
  ),
}));

/**
 * `:root, [data-theme="dark"]` matches `:root` under every theme; `[data-theme="light"]` has
 * equal specificity and comes later, so on a light document it wins and on a dark one it does
 * not match at all. That is the ordering `src/ui/stylesheets.test.ts` pins by keeping both
 * blocks unlayered together — so this walks the blocks in document order, same as the cascade.
 */
function paletteFor(theme: "dark" | "light"): Map<string, Rgb> {
  const resolved = new Map<string, Rgb>();
  for (const block of CSS_BLOCKS) {
    const applies =
      block.selector.includes(":root") || block.selector.includes(`[data-theme="${theme}"]`);
    if (!applies) continue;
    for (const [name, value] of block.declarations) {
      if (value.startsWith("#")) resolved.set(name, parseHex(value));
    }
  }
  return resolved;
}

const PALETTES = { dark: paletteFor("dark"), light: paletteFor("light") } as const;
type Theme = keyof typeof PALETTES;
const THEMES: readonly Theme[] = ["dark", "light"];

function token(theme: Theme, name: string): Rgb {
  const value = PALETTES[theme].get(name);
  if (value === undefined) throw new Error(`tokens.css: ${theme} has no ${name}`);
  return value;
}

/* ------------------------------------------------------------------------------ Button.tsx */

const quoted = (source: string): string[] =>
  [...source.matchAll(/"([^"]*)"/g)].map((match) => match[1]);

function section(pattern: RegExp, what: string): string {
  const match = pattern.exec(BUTTON_TSX);
  if (match === null) throw new Error(`Button.tsx: could not find ${what}`);
  return match[1];
}

const DECLARED_VARIANTS = quoted(section(/export type ButtonVariant =([^;]+);/, "ButtonVariant"));
const BASE = quoted(section(/const BASE =([\s\S]*?);\n/, "BASE")).join(" ");
const VARIANT_CLASSES = new Map(
  [
    ...section(/const VARIANTS[^=]*=\s*\{([\s\S]*?)\n\};/, "VARIANTS").matchAll(
      /(\w+):\s*"([^"]*)"/g,
    ),
  ].map((entry) => [entry[1], entry[2]]),
);

/** Utilities under a colour-bearing prefix that do not set a colour. */
const NOT_A_COLOR = new Set([
  "xs",
  "sm",
  "base",
  "lg",
  "xl",
  "2xl",
  "left",
  "center",
  "right",
  "0",
  "2",
  "4",
  "8",
  "solid",
  "dashed",
  "dotted",
  "none",
]);

/** Every class the resolver met under `bg-`/`text-`/`border-` and could not account for. */
const UNACCOUNTED: string[] = [];

interface Paint {
  /** `null` is transparent: whatever is behind the button shows through. */
  fill: Rgb | null;
  label: Rgb | null;
  border: Rgb | null;
  opacity: number;
  borderStyle: string;
  borderWidth: number;
}

function colorOf(theme: Theme, value: string): Rgb | null | undefined {
  if (value === "transparent") return null;
  const wrapped = /^\[var\((--[\w-]+)\)\]$/.exec(value);
  if (wrapped !== null) return token(theme, wrapped[1]);
  if (PALETTES[theme].has(`--${value}`)) return token(theme, `--${value}`);
  return undefined;
}

/** Applies one pass of utilities, keeping only those whose variant list is `disabled` or not. */
function apply(paint: Paint, classes: string, theme: Theme, wantDisabled: boolean): Paint {
  for (const cls of classes.split(/\s+/).filter(Boolean)) {
    const parts = cls.split(":");
    const utility = parts.pop() ?? "";
    // Focus and press are transient states; §6.1's floor is about the resting control.
    if (parts.includes("focus-visible") || parts.includes("active")) continue;
    if (parts.includes("disabled") !== wantDisabled) continue;

    const property = /^(bg|text|border)-(.+)$/.exec(utility);
    if (property !== null) {
      const color = colorOf(theme, property[2]);
      if (color === undefined) {
        if (!NOT_A_COLOR.has(property[2])) UNACCOUNTED.push(cls);
        if (property[1] === "border") {
          if (["solid", "dashed", "dotted"].includes(property[2])) paint.borderStyle = property[2];
          if (/^\d+$/.test(property[2])) paint.borderWidth = Number(property[2]);
        }
        continue;
      }
      if (property[1] === "bg") paint.fill = color;
      if (property[1] === "text") paint.label = color;
      if (property[1] === "border") paint.border = color;
      continue;
    }

    const opacity = /^opacity-(\d+)$/.exec(utility);
    if (opacity !== null) paint.opacity = Number(opacity[1]) / 100;
  }
  return paint;
}

/**
 * `:disabled` adds a pseudo-class, so every `disabled:` utility outranks the plain one it
 * competes with whatever their source order — two passes, not one.
 */
function paintFor(variant: string, theme: Theme, state: "enabled" | "disabled"): Paint {
  const classes = `${BASE} ${VARIANT_CLASSES.get(variant) ?? ""}`;
  const base: Paint = {
    fill: null,
    label: null,
    border: null,
    opacity: 1,
    // Tailwind's `border` utility is 1 px solid; `disabled:border-2` and
    // `disabled:border-dashed` are the only overrides in this file.
    borderStyle: "solid",
    borderWidth: 1,
  };
  const enabled = apply(base, classes, theme, false);
  return state === "enabled" ? enabled : apply(enabled, classes, theme, true);
}

/* -------------------------------------------------------------------------- what is painted */

/** The two grounds a Button is ever placed on: the page, and any panel, chip or banner. */
const GROUNDS = ["--bg", "--bg-elev"] as const;

interface Row {
  theme: Theme;
  variant: string;
  state: "enabled" | "disabled";
  ground: string;
  fill: Rgb;
  label: Rgb;
  border: Rgb | null;
  ratio: number;
  borderVsGround: number | null;
}

function rowsFor(state: "enabled" | "disabled"): Row[] {
  const rows: Row[] = [];
  for (const theme of THEMES) {
    for (const variant of VARIANT_CLASSES.keys()) {
      const paint = paintFor(variant, theme, state);
      if (paint.label === null) throw new Error(`Button.tsx: ${variant} sets no text colour`);
      for (const groundName of GROUNDS) {
        const ground = token(theme, groundName);
        // Opacity fades the element's own fill and its label together over the backdrop.
        const fill = mix(paint.fill ?? ground, ground, paint.opacity);
        const label = mix(paint.label, ground, paint.opacity);
        const border = paint.border === null ? null : mix(paint.border, ground, paint.opacity);
        rows.push({
          theme,
          variant,
          state,
          ground: groundName,
          fill,
          label,
          border,
          ratio: contrast(label, fill),
          borderVsGround: border === null ? null : contrast(border, ground),
        });
      }
    }
  }
  return rows;
}

const DISABLED = rowsFor("disabled");
const ENABLED = rowsFor("enabled");

const at = (row: Row): string => `${row.theme} ${row.variant} on ${row.ground}`;
const withRatio = (row: Row): string =>
  `${at(row)}: ${show(row.label)} on ${show(row.fill)} = ${round2(row.ratio)}:1`;

/* --------------------------------------------------------------------------------- the gate */

describe("Button colour, measured", () => {
  it("is reading the files it thinks it is", () => {
    // Every assertion below is vacuous if a regex quietly matched nothing.
    expect([...VARIANT_CLASSES.keys()].sort()).toEqual([...DECLARED_VARIANTS].sort());
    expect(DECLARED_VARIANTS.length).toBeGreaterThan(0);
    expect(BASE).toContain("disabled:");
    expect(DISABLED).toHaveLength(DECLARED_VARIANTS.length * THEMES.length * GROUNDS.length);
    // A colour utility this file cannot resolve would silently drop out of the maths.
    expect(UNACCOUNTED).toEqual([]);
  });

  it("computes the same ratios tokens.css publishes for the enabled palette", () => {
    // Z4 derived these to 7:1 and wrote them into the file's own comments. If the formula
    // here disagreed with the one that produced them, every number below would be fiction.
    const on = (name: string, ground: string): number =>
      round2(contrast(token("light", name), token("light", ground)));
    expect([on("--fg", "--bg"), on("--fg", "--bg-elev")]).toEqual([19.22, 17.41]);
    expect([on("--fg-muted", "--bg"), on("--fg-muted", "--bg-elev")]).toEqual([7.98, 7.23]);
    expect([on("--accent", "--bg"), on("--accent", "--bg-elev")]).toEqual([7.96, 7.21]);
    expect([on("--danger", "--bg"), on("--danger", "--bg-elev")]).toEqual([7.94, 7.19]);
    const darkDanger = (ground: string): number =>
      round2(contrast(token("dark", "--danger"), token("dark", ground)));
    expect([darkDanger("--bg"), darkDanger("--bg-elev")]).toEqual([8.47, 7.48]);
  });

  it("holds every disabled label at §6.1's 7:1 floor, on the fill it is painted on", () => {
    // The finding: 2.26–3.59:1 dark, 1.97–2.62:1 light, every row, under `disabled:opacity-40`.
    const under = DISABLED.filter((row) => row.ratio < 7).map(withRatio);
    expect(under).toEqual([]);
  });

  it("holds the enabled labels there too — Z4's palette must not move", () => {
    const under = ENABLED.filter((row) => row.ratio < 7).map(withRatio);
    expect(under).toEqual([]);
  });

  it("never fades a disabled button as a whole", () => {
    // The mechanism, not the symptom: an element opacity drags the label and its ground
    // toward the page at the same rate, so the label's own contrast cannot be tuned at all.
    const faded = THEMES.flatMap((theme) =>
      [...VARIANT_CLASSES.keys()]
        .filter((variant) => paintFor(variant, theme, "disabled").opacity !== 1)
        .map((variant) => `${theme} ${variant}`),
    );
    expect(faded).toEqual([]);
  });

  it("gives every variant the same 'off' appearance", () => {
    // One look to learn, and one look to recognise in a hurry — a disabled danger button
    // must not still read as the destructive one.
    for (const theme of THEMES) {
      const painted = [...VARIANT_CLASSES.keys()].map((variant) =>
        paintFor(variant, theme, "disabled"),
      );
      for (const paint of painted) expect(paint).toEqual(painted[0]);
    }
  });

  it("separates disabled from enabled in four channels at once, not by contrast", () => {
    // How "still reads as unavailable" is verified rather than believed. Contrast is the
    // one signal that cannot carry it — the label has to stay at 7:1 — so each variant is
    // required to change fill, label, border colour *and* border pattern between states.
    const thin: string[] = [];
    for (const theme of THEMES) {
      for (const variant of VARIANT_CLASSES.keys()) {
        const on = paintFor(variant, theme, "enabled");
        const off = paintFor(variant, theme, "disabled");
        const changed = {
          fill: show(off.fill ?? token(theme, "--bg")) !== show(on.fill ?? token(theme, "--bg")),
          label: show(off.label ?? [0, 0, 0]) !== show(on.label ?? [0, 0, 0]),
          border: show(off.border ?? [0, 0, 0]) !== show(on.border ?? [0, 0, 0]),
          pattern: off.borderStyle !== on.borderStyle && off.borderWidth > on.borderWidth,
        };
        const missing = Object.entries(changed)
          .filter(([, didChange]) => !didChange)
          .map(([name]) => name);
        if (missing.length > 0) thin.push(`${theme} ${variant}: unchanged ${missing.join(", ")}`);
      }
    }
    expect(thin).toEqual([]);
  });

  it("drains the colour out of the disabled state", () => {
    // The second signal that survives greyscale, glare and colour-blindness: a disabled
    // primary is not a dim accent and a disabled danger is not a dim red, they are grey.
    const chromatic = DISABLED.filter(
      (row) => Math.max(chroma(row.fill), chroma(row.label), chroma(row.border ?? [0, 0, 0])) > 32,
    ).map(at);
    expect(chromatic).toEqual([]);

    // And the drain is a real change, because the fills it replaces are strongly chromatic.
    for (const theme of THEMES) {
      for (const variant of ["primary", "danger"]) {
        const fill = paintFor(variant, theme, "enabled").fill;
        expect(chroma(fill ?? [0, 0, 0])).toBeGreaterThan(100);
      }
    }
  });

  it("leaves the disabled control findable on both grounds", () => {
    // A 7:1 label forces its own ground to an extreme, so --disabled-bg cannot also stand
    // clear of the page — on --bg in dark it is a 1.03:1 recess. The dashed edge is what
    // draws the button's outline there, so it is the thing that has to stay visible.
    const faint = DISABLED.filter(
      (row) => row.borderVsGround === null || row.borderVsGround < 1.9,
    ).map((row) => `${at(row)}: border ${row.borderVsGround?.toFixed(2) ?? "none"}:1`);
    expect(faint).toEqual([]);
  });
});
