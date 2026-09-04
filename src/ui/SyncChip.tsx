/**
 * §6.4's sync chip, and the store behind it.
 *
 * It lives in `src/ui/` because History and the Sheet both show it (§6.2) and neither owns
 * it. It reads the sync engine and nothing else: no props, no context, no state of its own.
 *
 * **Six statuses, four strings.** §4.10's `SyncStatus` has six members and §6.4 gives four
 * words for them. The two extra members are mapped, not given new copy:
 *
 * - `signed_out` renders **nothing at all**. Every §6.4 string is a claim about an account,
 *   and a device that is signed out — or a build with no Supabase, which reaches this the
 *   same way — has none to describe. "Synced" would be false, "3 pending" would name an
 *   account the user has never had, and a fifth string is exactly what this file is not
 *   allowed to invent. Absence is the honest rendering (N2), and it keeps signed-out History
 *   and Sheet looking precisely as they did before S4.
 * - `syncing` renders the state it is moving *out of*: the queue's count while rows are
 *   still queued, "Synced" when none are. Both remain true for the whole request — the chip
 *   is a status, not a spinner — and §5.7's count is the thing the user acts on.
 *
 * There is deliberately no motion or fade for `syncing`. §6.1 sets a 7:1 floor for body
 * text with no exemption, and every animation that reads as "working" (pulse, fade) spends
 * contrast to say it; `Button.tsx` has the long version of that argument.
 */
import { useSyncExternalStore } from "react";
import { Link } from "react-router";
import { getSyncEngine } from "../lib/sync/engine";
import { IDLE_SNAPSHOT } from "../lib/sync/status";
import type { SyncSnapshot } from "../lib/sync/status";
import { Chip } from "./Chip";
import type { ChipTone } from "./Chip";

/** §6.4, verbatim. The count string is a format, and 3 is §6.4's example of it. */
export const SYNC_SYNCED = "Synced";
export const SYNC_OFFLINE = "Offline — will sync";
export const SYNC_ERROR = "Sync error — tap for details";

export function syncPendingLabel(pending: number): string {
  return `${pending} pending`;
}

export interface SyncChipView {
  label: string;
  tone: ChipTone;
  /** §6.4's "tap for details" — the chip becomes a link to the Account screen. */
  details: boolean;
}

/**
 * The whole mapping, as a pure function, so §6.4's four strings are pinned by a test that
 * needs no DOM (`SyncChip.test.ts`).
 *
 * Tones carry the same meaning as everywhere else in the app: `ok` for a settled state,
 * `accent` for work the app is going to do on its own, `danger` for something that needs a
 * person, and `neutral` for offline — being offline is this app's normal condition (N1), not
 * a warning, and the copy already says it will sort itself out.
 */
export function syncChipView(snapshot: SyncSnapshot): SyncChipView | null {
  const { status, pending } = snapshot;
  if (status === "signed_out") return null;
  if (status === "error") return { label: SYNC_ERROR, tone: "danger", details: true };
  if (status === "offline") return { label: SYNC_OFFLINE, tone: "neutral", details: false };
  if (status === "pending" || (status === "syncing" && pending > 0)) {
    return { label: syncPendingLabel(pending), tone: "accent", details: false };
  }
  if (status === "syncing" || status === "synced") {
    return { label: SYNC_SYNCED, tone: "ok", details: false };
  }
  // P7: a status outside §4.10 — corrupt state, or a future member — shows no chip rather
  // than taking History and the Sheet down with it.
  return null;
}

/** How often to look for an engine that has not started yet, and for how long. */
const ENGINE_POLL_MS = 250;
const ENGINE_POLL_TRIES = 40;

/**
 * `useSyncExternalStore`'s subscribe, with one wrinkle: `main.tsx` starts the engine after
 * the first paint, so on a cold start at ≥ 900 px — where History *is* the first screen
 * (§6.6) — this chip can mount before there is anything to subscribe to.
 *
 * React calls `subscribe` once and never again for a stable function, so the wait has to
 * happen inside this closure: poll until the engine appears, then hand the listener over to
 * it for good. The poll is bounded (10 s) because an engine that has not arrived by then is
 * not coming — the dynamic import failed — and a chip that renders nothing is the correct
 * picture of that. Nothing here reaches the network; it is one module read per tick.
 */
function subscribe(onChange: () => void): () => void {
  let detach: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const engine = getSyncEngine();
  if (engine !== null) {
    detach = engine.subscribe(onChange);
  } else {
    let tries = 0;
    timer = setInterval(() => {
      tries += 1;
      const started = getSyncEngine();
      if (started === null) {
        if (tries < ENGINE_POLL_TRIES) return;
        clearInterval(timer!);
        timer = null;
        return;
      }
      clearInterval(timer!);
      timer = null;
      detach = started.subscribe(onChange);
      // The engine has had a cycle by now; re-read rather than wait for its next change.
      onChange();
    }, ENGINE_POLL_MS);
  }

  return () => {
    if (timer !== null) clearInterval(timer);
    detach?.();
  };
}

/**
 * No engine is the same picture as signed out, and `IDLE_SNAPSHOT` is a module constant, so
 * the identity React compares stays stable across every render until the engine publishes.
 */
function getSnapshot(): SyncSnapshot {
  return getSyncEngine()?.getSnapshot() ?? IDLE_SNAPSHOT;
}

/**
 * The engine's snapshot, for a screen that needs more of it than the chip shows (the
 * Account screen's status line). One store, one subscription shape, one set of rules.
 */
export function useSyncSnapshot(): SyncSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export interface SyncChipProps {
  className?: string;
}

export function SyncChip({ className }: SyncChipProps) {
  const view = syncChipView(useSyncSnapshot());
  if (view === null) return null;
  if (!view.details) {
    return (
      <Chip tone={view.tone} className={className}>
        {view.label}
      </Chip>
    );
  }
  // §6.4's "tap for details": the details are §5.8's `lastError`, and the Account screen is
  // where it is written out. The link carries the 48 px target (N5) and the focus ring; the
  // chip inside it keeps the styling in one place.
  return (
    <Link
      to="/account"
      className={[
        "inline-flex min-h-[var(--tap)] items-center rounded-[var(--radius)] px-1",
        "focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-accent",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Chip tone={view.tone}>{view.label}</Chip>
    </Link>
  );
}
