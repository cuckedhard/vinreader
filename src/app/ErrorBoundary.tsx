import { Component, type ErrorInfo, type ReactNode } from "react";
import Dexie from "dexie";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";

/**
 * The floor under `createRoot`.
 *
 * Every screen that reads §5 storage reads it through `useLiveQuery`, and
 * `dexie-react-hooks` re-throws a rejected query **during render** — deliberately, "so that
 * an ErrorBoundrary can catch it". With no boundary anywhere, React's answer to that throw
 * is to unmount the whole root: a white page on a phone whose storage is blocked, which is
 * the one situation where the user most needs the keyboard path to still be there (N1/P1 —
 * a scan is never blocked by anything).
 *
 * Placed twice in `Shell` (§9-S0's layout route) and once above the router, so a failure
 * costs the smallest subtree that can contain it: the palette, then the screen, then — only
 * if the shell itself cannot render — the app.
 */
interface ErrorBoundaryProps {
  children: ReactNode;
  /** Rendered in place of `children` after a throw. Takes the thrown value, whatever it is. */
  fallback: (error: unknown) => ReactNode;
}

interface ErrorBoundaryState {
  /** Separate from `error` because the thrown value may legitimately be `null`. */
  caught: boolean;
  error: unknown;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { caught: false, error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { caught: true, error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // P7: quietly in the log. The user's half of it is `FailureNotice`.
    console.error("VIN Relay: a render failed", error, info.componentStack);
  }

  override render(): ReactNode {
    return this.state.caught ? this.props.fallback(this.state.error) : this.props.children;
  }
}

/**
 * Is this storage saying no, or is it a bug?
 *
 * Dexie wraps every IndexedDB failure it sees in a `DexieError` subclass, so the test is the
 * base class rather than a list of error names that would go stale. It matters because the
 * two get different sentences below: telling a user that storage is unavailable when the
 * real fault was a null dereference is a guess shown as a fact (N2).
 */
export function isStorageError(error: unknown): boolean {
  return error instanceof Dexie.DexieError;
}

/**
 * §6.4 is silent on this state — no round has needed it before, because until now the app
 * had no way to survive it. The two titles and their bodies are supplied under §0 rule 4 in
 * §6.4's own tone (say what went wrong, then what to do; no apology, no blame) and are
 * logged for sign-off in the round's report rather than written into §6.4 by an agent.
 */
const STORAGE_COPY = {
  title: "Storage isn't available",
  body:
    "This device won't let VIN Relay read its saved vehicles. Reload to try again — you can " +
    "still scan or type a VIN, but nothing can be saved until storage is back.",
} as const;

const RENDER_COPY = {
  title: "This screen didn't load",
  body: "Something on it failed while it was being drawn. Reload to try again.",
} as const;

/** The thrown value as one line the user can read out over a phone (P7). */
function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

interface FailureNoticeProps {
  error: unknown;
  /**
   * The caller already knows this came from storage, so nothing is inferred from it.
   *
   * The boundary has to infer, and `isStorageError` is deliberately narrow about it: it
   * catches whatever a render threw, and calling a `TypeError` "storage" would be a guess
   * shown as a fact (N2). A caller that awaited `db.open()` is in the other position — it
   * knows where the rejection came from, and `indexedDB.open` throwing a bare
   * `SecurityError` never passes through a Dexie error type at all, so inference would put
   * the wrong sentence on the one fault this flag exists for (F1-b).
   */
  fromStorage?: boolean;
}

export function FailureNotice({ error, fromStorage = false }: FailureNoticeProps) {
  const copy = fromStorage || isStorageError(error) ? STORAGE_COPY : RENDER_COPY;
  return (
    <div className="p-4">
      <Banner
        tone="danger"
        title={copy.title}
        actions={
          /* §6.1's ≥ 56 px list names Scan, Use as-is, Share, Copy and Sign in, and not
             Reload — but this is the notice's only action, and §6.4 reads §6.1 the same way
             when it gives "the primary weight, because it is the only route left (§6.1)" to
             an action that list does not name either. So it is primary, and primary is 56 —
             measured in tests/e2e/storage-unavailable.spec.ts, not read off this class list.
             It used to need an `h-14` pin on top of that, because the Banner action row
             lowered it to 48 (F4); the row now reads the target the Button declares. */
          <Button variant="primary" onClick={() => window.location.reload()}>
            Reload
          </Button>
        }
      >
        <p>{copy.body}</p>
        {/* The same shape the write path's "Couldn't save this VIN" already uses. */}
        <p className="mt-2 font-vin text-sm break-words text-fg-muted">{describe(error)}</p>
      </Banner>
    </div>
  );
}
