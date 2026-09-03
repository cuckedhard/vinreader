import { NavLink } from "react-router";

const TABS = [
  { to: "/scan", label: "Scan" },
  { to: "/history", label: "History" },
  { to: "/settings", label: "Settings" },
] as const;

/** Bottom nav. Every target clears 48 px (N5). */
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
              "min-h-[var(--tap)] px-3 py-3",
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
