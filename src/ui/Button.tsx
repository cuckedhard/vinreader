import type { ComponentPropsWithRef } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: ButtonVariant;
  /** Stretch to the container width. */
  full?: boolean;
}

/**
 * The disabled state, and why it is four utilities rather than one opacity.
 *
 * WCAG exempts disabled controls from its contrast minimums precisely so that "disabled"
 * can *look* disabled. §6.1 states no such exemption — "Contrast ≥ 7:1 for body text",
 * full stop — and it is right to for this app: gloves, snow glare, night shift. A label
 * nobody can read is not a kinder way to say "unavailable", it is a control the user
 * cannot identify before deciding whether it matters that it is off.
 *
 * `disabled:opacity-40` failed both halves at once. Opacity fades the element's fill and
 * its label *together* toward whatever is behind them, so the label's contrast against
 * its own ground collapses while the pair stays legible enough to look merely dim:
 * measured 2.26–3.59:1 in dark and 1.97–2.62:1 in light, across the four variants over
 * both grounds. There is no opacity that fixes that — the two colours move in lockstep.
 *
 * So the state is now painted, not faded. Four channels change at once, and each is a
 * signal a user can read at arm's length:
 *   fill    → --disabled-bg, a colourless recess, whatever the variant was
 *   label   → --disabled-fg, still ≥ 7:1 on that recess (8.09–9.79:1; see tokens.css)
 *   border  → --disabled-border, and 2 px so the dashes read at a glance
 *   pattern → solid becomes dashed — the one cue that survives greyscale and glare
 * Two of them (pattern, and chroma falling from 117–168 to at most 28 as the accent and
 * danger fills go grey) are not contrast at all, which is what lets the label keep its 7:1
 * without the state reading as available. `disabled` on the element carries the state to
 * assistive tech and `cursor-not-allowed` carries it to pointers; neither of those reaches
 * a gloved thumb in daylight, which is why the pixels have to say it too.
 *
 * What this deliberately does not claim: that the fill alone separates the states. A 7:1
 * label forces its own ground to an extreme (mid-greys cannot hold 7:1 against anything),
 * so --disabled-bg has to live near the page. It is a 1.17:1 recess under a panel — the
 * same order as the 1.13:1 step the app already uses to lift every panel off the page.
 * `src/ui/Button.contrast.test.ts` measures all of it and fails on any of it.
 */
const BASE =
  "inline-flex select-none items-center justify-center gap-2 rounded-[var(--radius)] px-6 " +
  "font-bold leading-tight border transition-colors active:opacity-80 " +
  "focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-accent " +
  "disabled:cursor-not-allowed disabled:border-2 disabled:border-dashed " +
  "disabled:border-[var(--disabled-border)] disabled:bg-[var(--disabled-bg)] " +
  // A disabled button is not activatable, so `:active` should never match it — but Safari
  // has matched it on `<button disabled>` before, and the press fade would then read as a
  // tap that worked. Pinned to no change rather than left to the browser.
  "disabled:text-[var(--disabled-fg)] disabled:active:opacity-100";

/** §6.1: primary is the screen's main action, so it gets the 56 px target; the rest get 48 px. */
const VARIANTS: Record<ButtonVariant, string> = {
  primary: "min-h-[var(--tap-lg)] border-accent bg-accent text-bg text-lg",
  secondary: "min-h-[var(--tap)] border-border bg-bg-elev text-fg text-base",
  danger: "min-h-[var(--tap)] border-danger bg-danger text-bg text-base",
  ghost: "min-h-[var(--tap)] border-transparent bg-transparent text-accent text-base",
};

export function Button({
  variant = "primary",
  full = false,
  type = "button",
  className,
  ...rest
}: ButtonProps) {
  const classes = [BASE, VARIANTS[variant], full ? "w-full" : "", className]
    .filter(Boolean)
    .join(" ");
  return <button type={type} className={classes} {...rest} />;
}
