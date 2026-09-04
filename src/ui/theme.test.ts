import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY, applyTheme, resolveTheme } from "./theme";
import type { Theme } from "../lib/storage/settings";

describe("resolveTheme", () => {
  it("leaves an explicit choice alone whatever the OS prefers", () => {
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
  });

  // The boolean is `matchMedia("(prefers-color-scheme: dark)").matches`, which is false
  // both when the OS asks for light and when it expresses no preference — §6.1's
  // default is dark, but "no preference" is the OS saying light, so light it is.
  it("resolves system against the OS preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

/** The `--bg` of each palette, as `tokens.css` defines them. Asserted against the file below. */
const PALETTE: Record<string, string> = { dark: "#0b0f14", light: "#ffffff" };

/** `matchMedia`'s half of the contract, with a way to fire a change and count listeners. */
class FakeQuery {
  matches: boolean;
  readonly listeners = new Set<() => void>();
  readonly added: string[] = [];
  readonly removed: string[] = [];

  constructor(matches: boolean) {
    this.matches = matches;
  }

  addEventListener(type: string, listener: () => void): void {
    this.added.push(type);
    this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.removed.push(type);
    this.listeners.delete(listener);
  }

  /** What the OS switching appearance looks like from in here. */
  emit(matches: boolean): void {
    this.matches = matches;
    for (const listener of [...this.listeners]) listener();
  }
}

interface Harness {
  root: { dataset: { theme?: string } };
  meta: { content: string | null };
  query: FakeQuery;
  stored: Map<string, string>;
}

/**
 * Just enough document for `applyTheme`: vitest runs in `node` (no DOM), and the parts that
 * matter here are which attribute is written, what `theme-color` ends up saying, and whether
 * the media listener is torn down. `getComputedStyle` answers from `data-theme`, exactly as a
 * browser would once `tokens.css` has switched blocks — so a test that reads the wrong colour
 * back is reporting a real ordering bug, not a fake one.
 */
function harness(
  options: { prefersDark?: boolean; metaPresent?: boolean; storage?: boolean } = {},
) {
  const { prefersDark = false, metaPresent = true, storage = true } = options;
  const root = { dataset: {} as { theme?: string } };
  const meta = {
    content: null as string | null,
    setAttribute(name: string, value: string) {
      if (name === "content") this.content = value;
    },
  };
  const query = new FakeQuery(prefersDark);
  const stored = new Map<string, string>();

  vi.stubGlobal("document", {
    documentElement: root,
    querySelector: (selector: string) =>
      metaPresent && selector === 'meta[name="theme-color"]' ? meta : null,
  });
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: (name: string) =>
      name === "--bg" ? (PALETTE[root.dataset.theme ?? "dark"] ?? "") : "",
  }));
  vi.stubGlobal("window", { matchMedia: () => query });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      // Safari in private browsing, and any browser with site data blocked.
      if (!storage) throw new DOMException("QuotaExceededError");
      stored.set(key, value);
    },
  });

  return { root, meta, query, stored } satisfies Harness;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("applyTheme", () => {
  /**
   * §6.1: the browser paints its own chrome — Android Chrome's toolbar, the task switcher —
   * from `theme-color`, and a single hardcoded value there left the light theme with a dark
   * toolbar above a white page. The attribute and the meta have to move together or the app
   * is only half themed.
   */
  it.each(["dark", "light"] as const)("paints %s into the attribute and the chrome", (theme) => {
    const { root, meta } = harness();
    applyTheme(theme);
    expect(root.dataset.theme).toBe(theme);
    expect(meta.content).toBe(PALETTE[theme]);
  });

  /**
   * The mirror carries the *choice*, not the resolution: a "system" user who changes their
   * phone's appearance while the app is closed must get the new answer on the next launch,
   * which the bootstrap can only work out if it is told "system" rather than last time's colour.
   */
  it.each(["dark", "light", "system"] as const)(
    "mirrors the choice %s, not its result",
    (theme) => {
      const { stored, root } = harness({ prefersDark: false });
      applyTheme(theme);
      expect(stored.get(THEME_STORAGE_KEY)).toBe(theme);
      expect(root.dataset.theme).toBe(theme === "system" ? "light" : theme);
    },
  );

  /**
   * The mirror is an optimisation, so nothing may depend on the write landing. Safari in
   * private browsing throws here, and a thrown mirror must cost one flash on the *next* cold
   * start, not the palette on this one.
   */
  it("still paints when storage refuses the write", () => {
    const { root, meta } = harness({ storage: false });
    expect(() => applyTheme("light")).not.toThrow();
    expect(root.dataset.theme).toBe("light");
    expect(meta.content).toBe(PALETTE.light);
  });

  it("leaves the chrome alone rather than throwing when there is no theme-color tag", () => {
    const { root } = harness({ metaPresent: false });
    expect(() => applyTheme("light")).not.toThrow();
    expect(root.dataset.theme).toBe("light");
  });

  /**
   * The teardown is the whole reason `applyTheme` returns anything: the effect re-runs on
   * every theme change, and a listener left behind would keep writing a choice the user has
   * already replaced.
   */
  it("follows the OS while system is chosen and stops when torn down", () => {
    const { root, meta, query } = harness({ prefersDark: true });
    const stop = applyTheme("system");
    expect(root.dataset.theme).toBe("dark");
    expect(meta.content).toBe(PALETTE.dark);
    expect(query.added).toEqual(["change"]);

    query.emit(false);
    expect(root.dataset.theme).toBe("light");
    expect(meta.content).toBe(PALETTE.light);

    stop();
    expect(query.removed).toEqual(["change"]);
    expect(query.listeners.size).toBe(0);
    query.emit(true);
    expect(root.dataset.theme).toBe("light");
  });

  it("subscribes to nothing for an explicit choice", () => {
    const { query } = harness();
    applyTheme("dark")();
    expect(query.added).toEqual([]);
  });
});

/**
 * The pre-paint bootstrap in `index.html` is the one piece of this that cannot import anything:
 * it runs before the first module and before `tokens.css` is parsed, so it repeats the storage
 * key and both background colours as literals. Repetition is the price of fixing the flash
 * (§6.1 — the choice lives in Dexie, which cannot answer before the first frame); silent drift
 * is not, and nothing else in the gate reads `index.html` at all.
 */
describe("the index.html theme bootstrap", () => {
  const html = readFileSync(fileURLToPath(new URL("../../index.html", import.meta.url)), "utf8");
  const css = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8");

  /** `--bg` out of the block whose selector list contains `selector`, comments stripped. */
  function background(selector: string): string {
    for (const block of css.replaceAll(/\/\*[\s\S]*?\*\//g, "").split("}")) {
      const [head, body] = block.split("{");
      if (body === undefined || !head.includes(selector)) continue;
      const found = /(?:^|[\s;])--bg:\s*([^;]+);/.exec(body);
      if (found !== null) return found[1].trim().toLowerCase();
    }
    throw new Error(`tokens.css has no --bg for ${selector}`);
  }

  it("reads the same storage key applyTheme writes", () => {
    expect(html).toContain(`localStorage.getItem("${THEME_STORAGE_KEY}")`);
  });

  it("carries the same two backgrounds as tokens.css", () => {
    expect(background('[data-theme="dark"]')).toBe(PALETTE.dark);
    expect(background('[data-theme="light"]')).toBe(PALETTE.light);
    // The static default on <html>, the meta the bootstrap starts from, and the value it
    // swaps in are all spelled out in the file; each has to be one of these two.
    expect(html).toContain(`<meta name="theme-color" content="${PALETTE.dark}" />`);
    expect(html).toContain(`"${PALETTE.light}" : "${PALETTE.dark}"`);
    expect(html).toContain(`<html lang="en" data-theme="dark">`);
  });

  /**
   * §6.1's default is dark for everyone who never opens the setting, and the fix for one
   * user's flash must not become a flash for the rest: only "light" and "system" may move the
   * attribute off the value `<html>` already carries.
   */
  it("only ever moves off dark for a recognised choice", () => {
    expect(html).toContain(`if (choice !== "dark" && choice !== "light") return;`);
  });
});

/** Guards the signature the Shell depends on: a teardown, always, for every choice. */
describe("applyTheme's contract", () => {
  it.each(["dark", "light", "system"] as Theme[])("returns a teardown for %s", (theme) => {
    harness();
    expect(typeof applyTheme(theme)).toBe("function");
  });
});
