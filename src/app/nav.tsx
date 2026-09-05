import { NavLink } from "react-router";

/**
 * §6.1 sizes targets by what the control *does*, not by where it sits: "≥ 48 px everything;
 * ≥ 56 px for Scan, Use as-is, Share, Copy, Sign in". This tab is the app's Scan, so it
 * carries `--tap-lg` and the other two carry the floor (R6-SA-3).
 */
const TABS = [
  { to: "/scan", label: "Scan", tap: "min-h-[var(--tap-lg)]" },
  { to: "/history", label: "History", tap: "min-h-[var(--tap)]" },
  { to: "/settings", label: "Settings", tap: "min-h-[var(--tap)]" },
] as const;

/** Bottom nav. Every target clears 48 px (N5), and Scan clears 56 (§6.1). */
export function BottomNav() {
  return (
    <nav
      className="flex shrink-0 border-t border-border bg-bg-elev"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="Main"
    >
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          className={({ isActive }) =>
            [
              "flex flex-1 items-center justify-center text-base font-medium",
              `${tab.tap} px-3 py-3`,
              isActive ? "text-accent" : "text-fg-muted",
            ].join(" ")
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
