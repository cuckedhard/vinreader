/**
 * §6.1's theme, applied. The choice lives in the §5.6 settings row; this is the only
 * place that turns it into `data-theme` on the document element, so there is one
 * writer and the pure resolution stays testable without a DOM.
 */
import type { Theme } from "../lib/storage/settings";

export type ResolvedTheme = "dark" | "light";

/** The query "system" follows. */
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** "system" resolves against the OS preference; the other two are already resolved. */
export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  if (theme === "system") return prefersDark ? "dark" : "light";
  return theme;
}

/**
 * Writes `theme` to the document element and, for "system", keeps following the OS
 * until the returned teardown runs. index.html ships `data-theme="dark"` so the first
 * paint is dark whatever is stored (§6.1's default); this corrects it after hydration.
 *
 * The teardown is not optional: the effect re-runs on every theme change, and a
 * listener left behind would keep writing a choice the user has already replaced.
 */
export function applyTheme(theme: Theme): () => void {
  const root = document.documentElement;
  if (theme !== "system") {
    root.dataset.theme = theme;
    return () => {};
  }
  const query = window.matchMedia(DARK_QUERY);
  const sync = () => {
    root.dataset.theme = resolveTheme("system", query.matches);
  };
  sync();
  query.addEventListener("change", sync);
  return () => query.removeEventListener("change", sync);
}
