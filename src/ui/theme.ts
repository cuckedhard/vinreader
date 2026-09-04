/**
 * §6.1's theme, applied. The choice lives in the §5.6 settings row; this is the only
 * place that turns it into `data-theme` on the document element, so there is one
 * writer and the pure resolution stays testable without a DOM.
 */
import type { Theme } from "../lib/storage/settings";

export type ResolvedTheme = "dark" | "light";

/** The query "system" follows. */
const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Where the choice is mirrored for the pre-paint bootstrap in `index.html`, which needs an
 * answer synchronously and cannot have one from Dexie (§5.6 is IndexedDB; the read lands
 * 63–441 ms after the first frame). The key is duplicated in that inline script because it
 * runs before any module loads; `theme.test.ts` fails if the two drift apart.
 */
export const THEME_STORAGE_KEY = "vinrelay.theme";

/** "system" resolves against the OS preference; the other two are already resolved. */
export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  if (theme === "system") return prefersDark ? "dark" : "light";
  return theme;
}

/**
 * Mirrors the *choice*, not the resolution: a "system" user who changes their phone's
 * appearance while the app is closed must get the new answer on the next launch, and the
 * bootstrap can run `prefers-color-scheme` itself.
 *
 * Best-effort on purpose. Safari in private browsing throws on `localStorage`, and a theme
 * that cannot be pre-applied is one flash, not a failure — the settings row still drives the
 * palette a moment later, so nothing below this line may depend on the write landing.
 */
function mirrorChoice(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // No storage: the next cold start falls back to §6.1's dark default. Not worth a warning.
  }
}

/**
 * Paints one resolved palette: the attribute the stylesheet keys on, and the `theme-color`
 * the browser paints its own chrome from. Without the second, the light theme left Android
 * Chrome's toolbar dark and an installed PWA's status bar mismatched (§6.1).
 *
 * The colour is read back out of `--bg` rather than repeated here, so it is by construction
 * the one `tokens.css` just painted the page with and a palette edit cannot desync it.
 */
function paint(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta === null) return;
  const background = getComputedStyle(root).getPropertyValue("--bg").trim();
  if (background !== "") meta.setAttribute("content", background);
}

/**
 * Writes `theme` to the document element and, for "system", keeps following the OS
 * until the returned teardown runs. index.html ships `data-theme="dark"` and a bootstrap
 * that may already have replaced it from the mirror; this is the authoritative write, from
 * the §5.6 row, and it also refreshes the mirror the next cold start will read.
 *
 * The teardown is not optional: the effect re-runs on every theme change, and a
 * listener left behind would keep writing a choice the user has already replaced.
 */
export function applyTheme(theme: Theme): () => void {
  mirrorChoice(theme);
  if (theme !== "system") {
    paint(theme);
    return () => {};
  }
  const query = window.matchMedia(DARK_QUERY);
  const sync = () => {
    paint(resolveTheme("system", query.matches));
  };
  sync();
  query.addEventListener("change", sync);
  return () => query.removeEventListener("change", sync);
}
