import type { ComponentType } from "react";
import SheetScreen from "../sheet/SheetScreen";
import { Button } from "../../ui/Button";
import { VinDisplay } from "../../ui/VinDisplay";

/**
 * §6.6 puts "the Sheet" in this pane, and the Sheet is another agent's file in this slice.
 *
 * The interface assumed — reported as an assumption — is that `SheetScreen` takes an
 * optional `vin` that overrides §6.2's `:vin` route param, which is the only way it can
 * render anywhere but at `/#/v/:vin`. The assignment is deliberately a plain one and not a
 * cast: a component declaring no props today satisfies it, so this file compiles either
 * way, and the day the prop is declared it starts arriving with no change here. What does
 * *not* compile is the prop being declared **required** — a signal, not a silent failure.
 *
 * The alternative that needed no assumption was React Router's `<Routes location>`, and it
 * cannot be used here: `useRoutes` asserts that an overridden location begins with the
 * pathname its parent route already matched, and `/v/<vin>` under `/history` does not.
 */
const Sheet: ComponentType<{ vin?: string }> = SheetScreen;

/**
 * Not in §6.4 — reported under §0 rule 4. It is the pane's resting state, which exists
 * only on the wide layout and so has no phone equivalent to borrow words from.
 */
const PANE_EMPTY = "Choose a row to see that vehicle here.";

const CLOSE = "Close";

export interface SheetPaneProps {
  /** The open vehicle, or `null` for the resting state. */
  vin: string | null;
  onClose: () => void;
  className?: string;
}

export function SheetPane({ vin, onClose, className }: SheetPaneProps) {
  const classes = [
    "flex min-h-0 flex-col rounded-[var(--radius)] border border-border bg-bg",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  if (vin === null) {
    return (
      <aside aria-label="Vehicle details" className={classes}>
        <p className="p-5 text-base leading-snug text-fg-muted">{PANE_EMPTY}</p>
      </aside>
    );
  }

  return (
    <aside aria-label="Vehicle details" className={classes}>
      {/*
       * The pane's own header, and not only for the Close button: it names the vehicle the
       * pane is showing at the top of a pane that scrolls, and it is the one line here that
       * does not depend on the assumption above — so a Sheet that ignores `vin` is visibly
       * wrong rather than quietly showing the wrong vehicle (N2).
       */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
        <VinDisplay vin={vin} size="md" className="break-all" />
        <Button variant="secondary" onClick={onClose} aria-label={`${CLOSE} vehicle details`}>
          {CLOSE}
        </Button>
      </div>
      {/* Keyed so a pane holding one vehicle's half-typed unit or open QR never hands that
          state to the next vehicle (§6.2, and the same reasoning as the Sheet's own keys). */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Sheet key={vin} vin={vin} />
      </div>
    </aside>
  );
}
