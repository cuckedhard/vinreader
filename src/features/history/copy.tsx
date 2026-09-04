import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";

/** §6.4 microcopy, verbatim. */
const COPIED = "Copied ✓";

/** §6.5: the confirmation shows for about 1.5 s. */
const COPIED_MS = 1500;

/**
 * §6.5's fallback when the Clipboard API is missing. Not in §6.4 — reported under §0 rule
 * 4 — and deliberately the same sentence `src/features/sheet/Actions.tsx` shows for the
 * same situation: the two screens must not describe one browser limitation two ways. It
 * is stated twice because this slice's file boundaries put the two screens in different
 * agents' hands; hoisting both to one shared module is a merge item in the session report.
 */
const MANUAL_COPY_PROMPT =
  "Copying isn't available here. The text below is selected — copy it with your keyboard or " +
  "your phone's own copy menu.";

const PANEL = "rounded-[var(--radius)] border border-border bg-bg-elev";

export interface CopyApi {
  /** True for `COPIED_MS` after a write the browser accepted. */
  readonly copied: boolean;
  /** The text the browser would not take, for the §6.5 textarea fallback. */
  readonly manual: string | null;
  /** Writes `text` to the clipboard. Must be called from inside a tap handler. */
  readonly copy: (text: string) => void;
  readonly dismissManual: () => void;
}

/**
 * §6.5 and §11, and the one thing on this screen that cannot be caught by any test that
 * runs here.
 *
 * `copy` is synchronous, and it is passed a string the caller **already holds**. It must
 * stay that way: no `async`, no `await` before `writeText` — not a Dexie read, not a
 * settings lookup, not a dynamic import. iOS Safari treats the user gesture as over the
 * moment the handler yields, and the copy then fails silently, on that browser only, while
 * passing every test in this repo. History's records come from its live query and are in
 * memory before any button exists to tap; the TSV and CSV are built from them by pure
 * synchronous functions (`./rows`) inside the handler, which never yields.
 */
export function useCopy(): CopyApi {
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback((text: string) => {
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined || typeof clipboard.writeText !== "function") {
      setCopied(false);
      setManual(text);
      return;
    }
    clipboard.writeText(text).then(
      () => {
        setManual(null);
        setCopied(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
      },
      () => {
        setCopied(false);
        setManual(text);
      },
    );
  }, []);

  const dismissManual = useCallback(() => setManual(null), []);

  return { copied, manual, copy, dismissManual };
}

/**
 * One confirmation for the whole screen. It is fixed rather than inline because the copy
 * buttons are in three places at once on the wide layout — the selection bar, the VIN
 * cell, and every row's Copy button — and a confirmation that appears somewhere off-screen
 * is a copy the user cannot tell happened. `pointer-events-none` keeps it from ever
 * standing between a thumb and the button underneath it.
 *
 * The live region is always mounted: a `role="status"` that appears at the same moment as
 * its text is not reliably announced.
 */
export function CopyToast({ copied }: { copied: boolean }) {
  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-40 flex justify-center px-4"
      style={{ bottom: "calc(env(safe-area-inset-bottom) + 72px)" }}
      aria-live="polite"
    >
      {copied ? (
        <Chip tone="ok" className="shadow-lg">
          {COPIED}
        </Chip>
      ) : null}
    </div>
  );
}

/** §6.5: "a pre-selected read-only textarea with a prompt to copy". */
export function ManualCopy({ text, onDone }: { text: string; onDone: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    node.focus();
    node.select();
  }, [text]);

  return (
    <div className={`flex flex-col gap-3 p-4 ${PANEL}`}>
      <p className="text-base leading-snug text-fg">{MANUAL_COPY_PROMPT}</p>
      <textarea
        ref={ref}
        readOnly
        value={text}
        rows={6}
        aria-label="Text to copy"
        className={`${PANEL} w-full resize-y p-3 font-vin text-base leading-snug text-fg`}
      />
      <Button variant="secondary" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
