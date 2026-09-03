import type { ComponentPropsWithRef } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: ButtonVariant;
  /** Stretch to the container width. */
  full?: boolean;
}

const BASE =
  "inline-flex select-none items-center justify-center gap-2 rounded-[var(--radius)] px-6 " +
  "font-bold leading-tight border transition-colors active:opacity-80 " +
  "focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-accent " +
  "disabled:cursor-not-allowed disabled:opacity-40 disabled:active:opacity-40";

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
