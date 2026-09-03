import { groupVin } from "../lib/vin/grammar";

export interface VinDisplayProps {
  vin: string;
  size?: "lg" | "md";
  className?: string;
}

/** §6.1: ≥ 28 px on a phone, letter-spaced; it wraps at the §4.1 group breaks on narrow screens. */
const SIZES: Record<"lg" | "md", string> = {
  lg: "text-[28px] sm:text-[32px] tracking-[0.08em]",
  md: "text-[18px] tracking-[0.06em]",
};

export function VinDisplay({ vin, size = "lg", className }: VinDisplayProps) {
  const classes = [
    "font-vin font-semibold leading-tight text-fg select-text",
    SIZES[size],
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <span className={classes}>{groupVin(vin)}</span>;
}
