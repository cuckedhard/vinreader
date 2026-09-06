import type { CSSProperties } from "react";
import { groupVin } from "../lib/vin/grammar";

export interface VinDisplayProps {
  vin: string;
  size?: "lg" | "md";
  className?: string;
  /**
   * For a surface that is not the app's own palette. The §9-S3 QR overlay paints itself on
   * white paper for the camera reading it, and its ink is a value rather than a token, so it
   * cannot arrive as a Tailwind class — which is why that screen used to render its own
   * `<p>` and drift from this component's §6.1 sizing (R3-F6).
   */
  style?: CSSProperties;
}

/** §6.1: ≥ 28 px on a phone, letter-spaced; it wraps at the §4.1 group breaks on narrow screens. */
const SIZES: Record<"lg" | "md", string> = {
  lg: "text-[28px] sm:text-[32px] tracking-[0.08em]",
  md: "text-[18px] tracking-[0.06em]",
};

export function VinDisplay({ vin, size = "lg", className, style }: VinDisplayProps) {
  const classes = [
    "font-vin font-semibold leading-tight text-fg select-text",
    SIZES[size],
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes} style={style}>
      {groupVin(vin)}
    </span>
  );
}
