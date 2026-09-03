import type { ReactNode } from "react";

export type ChipTone = "neutral" | "ok" | "warn" | "danger" | "accent";

export interface ChipProps {
  tone?: ChipTone;
  children: ReactNode;
  className?: string;
}

const TONES: Record<ChipTone, string> = {
  neutral: "border-border text-fg-muted",
  ok: "border-ok text-ok",
  warn: "border-warn text-warn",
  danger: "border-danger text-danger",
  accent: "border-accent text-accent",
};

/** Status pill: read at arm's length in glare, so bold text plus a matching border (§6.1). */
export function Chip({ tone = "neutral", children, className }: ChipProps) {
  const classes = [
    "inline-flex items-center whitespace-nowrap rounded-full border bg-bg-elev px-3 py-1",
    "text-sm font-bold",
    TONES[tone],
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <span className={classes}>{children}</span>;
}
