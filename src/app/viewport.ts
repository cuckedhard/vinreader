/**
 * §6.6's one breakpoint, and the question the router asks it.
 *
 * 900 px is defined here and nowhere else (§7 item 5). The router needs it in TypeScript —
 * "History is the default route at this width" is a decision, not a layout — and History's
 * table needs the same number for its own layout, so it lives in a module both can import
 * without either importing the other (`router.tsx` imports the screens; a screen importing
 * `router.tsx` back would be a cycle).
 *
 * No DOM at module scope and no subscription: every function here answers when it is asked.
 * That is deliberate — see `defaultRoutePath`.
 */

/** §6.6: "Wide screens (≥ 900 px — laptops and desktops)". */
export const WIDE_MIN_PX = 900;

export const WIDE_QUERY = `(min-width: ${WIDE_MIN_PX}px)`;

/**
 * Is this viewport the wide one? Read at the moment of the call, never watched.
 *
 * `matchMedia` is the same question CSS is answering, so the layout and the routing agree
 * on where the line is even when a browser's CSS pixel and `innerWidth` disagree (a pinched
 * page, a zoomed desktop). `innerWidth` is the fallback for a runtime without it, and no
 * window at all — a test, or the PWA's build step — is not a wide screen.
 */
export function isWideViewport(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia === "function") return window.matchMedia(WIDE_QUERY).matches;
  return window.innerWidth >= WIDE_MIN_PX;
}

/**
 * §6.6: "History is the default route at this width (Scan still works with a webcam)."
 *
 * A *default* is a question asked once, when the user arrives at `/` with nothing to say
 * where they meant to go. It is emphatically not a rule the app keeps enforcing: a laptop
 * user who drags the window narrower while reading a sheet, or a tablet turned to portrait
 * mid-scan, must stay exactly where they are. So this is a pure function of a width that is
 * sampled once by the redirect and never subscribed to — resizing across 900 px navigates
 * nobody, in either direction, ever.
 */
export function defaultRoutePath(wide: boolean): string {
  return wide ? "/history" : "/scan";
}
