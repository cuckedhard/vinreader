/**
 * §6.6's breakpoint, as a value the screen can branch on and re-render with.
 *
 * A CSS media query cannot carry this one: the two layouts are different DOM — a list of
 * links, and a table whose rows drive a side pane — and rendering both and hiding one would
 * put two copy buttons, two checkboxes and two focus stops behind every record for
 * assistive tech and for the keyboard. So the branch is made in JS, once, here.
 *
 * The number itself is `src/app/viewport.ts`'s (§7 item 5). That module answers when asked
 * and never watches, because a resize must not re-route anybody; this hook is the other
 * half of the same question — the layout *does* have to follow a window being dragged
 * across 900 px — so it subscribes, and the two agree by construction because they read one
 * query string.
 */
import { useSyncExternalStore } from "react";
import { WIDE_QUERY, isWideViewport } from "../../app/viewport";

function mediaQuery(): MediaQueryList | null {
  // Not a browser, or one too old to answer: `isWideViewport` still has a width to fall
  // back on, but there is nothing here to subscribe to.
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(WIDE_QUERY);
}

function subscribe(onChange: () => void): () => void {
  const mql = mediaQuery();
  if (mql === null || typeof mql.addEventListener !== "function") return () => {};
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** True at ≥ 900 px, and it re-renders on a resize or a rotation across the line. */
export function useWide(): boolean {
  return useSyncExternalStore(subscribe, isWideViewport, () => false);
}
