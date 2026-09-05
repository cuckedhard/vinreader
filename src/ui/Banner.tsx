import type { ReactNode } from "react";

export type BannerTone = "warn" | "danger" | "ok" | "info";

export interface BannerProps {
  tone: BannerTone;
  title: string;
  children?: ReactNode;
  /**
   * Rendered below the text; each action keeps its own target, and never less than §6.1's
   * 48 px floor. The row asks the child for the target it declares (`--tap-target`, which
   * every `Button` variant sets) and supplies 48 px only where the child declares none — a
   * plain `<a>`, say. A flat `min-h-[var(--tap)]` on the children instead is what F4 was:
   * it landed on a primary `Button` at the same specificity as the button's own 56 px and
   * won on source order, so the row silently *lowered* an action's target.
   */
  actions?: ReactNode;
  className?: string;
}

const TONES: Record<BannerTone, { edge: string; title: string }> = {
  warn: { edge: "border-l-warn", title: "text-warn" },
  danger: { edge: "border-l-danger", title: "text-danger" },
  ok: { edge: "border-l-ok", title: "text-ok" },
  info: { edge: "border-l-accent", title: "text-accent" },
};

export function Banner({ tone, title, children, actions, className }: BannerProps) {
  const { edge, title: titleTone } = TONES[tone];
  const urgent = tone === "warn" || tone === "danger";
  const classes = [
    "w-full rounded-[var(--radius)] border border-border border-l-4 bg-bg-elev p-4",
    edge,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} role={urgent ? "alert" : "status"}>
      <p className={`text-lg leading-tight font-bold ${titleTone}`}>{title}</p>
      {children ? <div className="mt-2 text-base leading-snug text-fg">{children}</div> : null}
      {actions ? (
        <div className="mt-4 flex flex-wrap gap-3 [&>*]:min-h-[var(--tap-target,var(--tap))]">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
