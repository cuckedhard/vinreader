import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { appBaseUrl } from "../../app/appBase";
import { errorLine } from "../../app/errorLine";
import { db } from "../../lib/storage/db";
import type { VehicleRecord } from "../../lib/vin/types";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { QrView } from "../../ui/QrView";
import { buildCopyTexts } from "./copyTexts";
import { downloadFile, shareData, sharedFile } from "./shareFile";
import { shareOutcome } from "./shareOutcome";

const LABEL = "text-sm font-bold tracking-wide text-fg-muted uppercase";

/** §6.4 microcopy, verbatim. */
const NO_SHARE = "Sharing isn't available here. Copy or download instead.";
const COPIED = "Copied ✓";

/** §6.5: the confirmation shows for about 1.5 s. */
const COPIED_MS = 1500;

const SHARE_FAILED = "Sharing didn't finish. Copy or download instead.";

/**
 * Supplied under §0 rule 4: §6.4 has no line for "Row", and the button label alone does not
 * say what the row is for. §6.5 describes the History pair it shares a format with as
 * pasting "into Excel or Google Sheets as columns", so this says the same thing about one
 * record — the two screens must not describe one format two ways.
 */
const ROW_HINT = "Copy row pastes into Excel or Google Sheets as one row of columns.";

/** §6.5 fallback when the Clipboard API is missing: pre-selected text and what to do with it. */
const MANUAL_COPY_PROMPT =
  "Copying isn't available here. The text below is selected — copy it with your keyboard or " +
  "your phone's own copy menu.";

/** §4.9 `DROP_ORDER` keys, in the words the person holding the phone uses. */
const DROPPED_NAMES: Record<string, string> = {
  n: "notes",
  en: "engine",
  dr: "drive type",
  fu: "fuel",
  bc: "body",
  tr: "trim",
  gv: "GVWR",
};

function droppedList(dropped: readonly string[]): string {
  return dropped.map((key) => DROPPED_NAMES[key] ?? key).join(", ");
}

const PANEL = "rounded-[var(--radius)] border border-border bg-bg-elev";

/**
 * §6.1 names Copy alongside Scan, Use as-is and Share as a ≥ 56 px target. Inline rather
 * than a class, because the secondary variant's own 48 px min-height is a class and would
 * otherwise win; the variant stays secondary so Share keeps the only primary weight here.
 */
const COPY_TARGET = { minHeight: "var(--tap-lg)" };

export function Actions({ record }: { record: VehicleRecord }) {
  // §4.9 `by`. Read here, once, so the tap handlers below never have to: a Dexie read
  // inside a handler would end the user gesture before the clipboard write (see `copy`).
  const settings = useLiveQuery(() => db.settings.get("settings"), []);
  const deviceLabel = (settings?.deviceLabel ?? "").trim() || null;

  // Two files, not one: Share's has to pass the browser process's allowlists and Download's
  // does not (SH-1 — see `./shareFile`). The bytes are the same record either way.
  const shared = sharedFile(record.vin);
  const saved = downloadFile(record.vin);

  /**
   * Every copyable string, built during render and held in memory. This is not an
   * optimisation: §6.5 and §11 require the clipboard write to be the first thing a tap
   * handler does, so nothing may be computed asynchronously at tap time. `./copyTexts`
   * builds them all synchronously from this record and nothing else.
   */
  const texts = useMemo(
    // The app's base, not the bare origin: `location.origin` drops the path, so under a
    // sub-path deployment the carrier pointed at the site root instead of the app (F2).
    () => buildCopyTexts(record, deviceLabel, appBaseUrl()),
    [record, deviceLabel],
  );

  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState<string | null>(null);
  // SH-3: the engine's own line, or null. §6.4's sentence above it never changes.
  const [shareFailure, setShareFailure] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const manualRef = useRef<HTMLTextAreaElement>(null);
  const failureRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    };
  }, []);

  /**
   * SH-4. §6.2 puts Share at the top of this section and this banner after the six copy
   * buttons, the row hint and the QR note, so the answer to a tap opened a long way below the
   * button that made it: measured at 390×844 with the user scrolled to Share, **0 of 107 px**
   * of the banner inside `main`'s scroll clip and `elementFromPoint` at its centre returning
   * nothing, with Share itself fully visible at 56 px. The same at 360×640. The user tapped,
   * the share failed, and the screen did not change.
   *
   * So the notice is scrolled to where it can be read — the move F8 made for the armed delete
   * and R3-F1 for the carrier rejection, for the same reason. `block: "nearest"` scrolls the
   * least it can, so a screen already showing the banner does not move under a thumb, and
   * nothing is hidden, shrunk or stopped to make room.
   */
  useEffect(() => {
    if (shareFailure === null) return;
    failureRef.current?.scrollIntoView({ block: "nearest" });
  }, [shareFailure]);

  // §6.5: the fallback textarea arrives with its contents already selected.
  useEffect(() => {
    if (manual === null) return;
    const node = manualRef.current;
    if (node === null) return;
    node.focus();
    node.select();
  }, [manual]);

  function flashCopied() {
    setManual(null);
    setCopied(true);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
  }

  /**
   * §6.5 and §11. `navigator.clipboard.writeText` runs synchronously inside the tap
   * handler, from a string already in memory (`texts` above). Do not make this function
   * async and do not await anything ahead of the write — not a Dexie read, not a settings
   * lookup, not a dynamic import. iOS Safari treats the user gesture as over the moment
   * the handler yields, and the copy then fails silently, on that browser only.
   */
  function copy(text: string) {
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined || typeof clipboard.writeText !== "function") {
      setCopied(false);
      setManual(text);
      return;
    }
    clipboard.writeText(text).then(flashCopied, () => {
      setCopied(false);
      setManual(text);
    });
  }

  // §9-S3: detected at render, so a browser without Web Share never shows a dead button.
  const canShare = typeof navigator.share === "function";

  function share() {
    setShareFailure(null);
    const file = new File([texts.json], shared.name, { type: shared.type });
    // Two questions, and `canShare` only answers the first (SH-2). It reports whether this
    // browser does file sharing at all; it does not — cannot — say whether the browser
    // process will accept *this* file, because `CanShareInternal` holds no MIME or extension
    // test of any kind. `shareData` asks the second one before attaching anything, so a file
    // the platform would refuse is dropped and §4.9's text still goes.
    const browserSharesFiles =
      typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
    const data = shareData(texts.summary, file, browserSharesFiles);
    navigator.share(data).catch((cause: unknown) => {
      // Backing out of the system sheet is a choice and stays quiet; an AbortError is not
      // evidence of one, because Chromium sends its internal failures there too (SH-3, see
      // `./shareOutcome`). What it cannot tell apart, it does not claim to (N2).
      if (shareOutcome(cause) === "cancelled") return;
      // §6.4 gives this banner its sentence and the engine gives the line under it: the
      // failures that reach here are the platform's, so the only thing this app knows about
      // one is what it was told, and a user reading it out is how it gets reported at all.
      // Same shape as "Couldn't save this VIN" and the boundary (R3-F4, F12).
      setShareFailure(errorLine(cause));
    });
  }

  function download() {
    const url = URL.createObjectURL(new Blob([texts.json], { type: saved.type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = saved.name;
    // Some browsers only honour the download attribute for an anchor in the document.
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // Safari cancels an in-flight download if the object URL is revoked in the same tick.
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  const closeQr = useCallback(() => setQrOpen(false), []);

  const droppedNames = texts.dropped.length === 0 ? null : droppedList(texts.dropped);

  return (
    <section className="flex flex-col gap-4" aria-labelledby="handoff-heading">
      <h2 id="handoff-heading" className={LABEL}>
        Send this vehicle
      </h2>

      {canShare ? (
        <Button variant="primary" full onClick={share}>
          Share
        </Button>
      ) : (
        <Banner tone="info" title={NO_SHARE} />
      )}

      {/* §6.1: two columns, every target ≥ 48 px and Copy ≥ 56 px, no gesture (N5). */}
      <div className="grid grid-cols-2 gap-3">
        <Button variant="secondary" onClick={() => setQrOpen(true)}>
          QR code
        </Button>
        <Button variant="secondary" onClick={download}>
          Download JSON
        </Button>
        <Button variant="secondary" style={COPY_TARGET} onClick={() => copy(texts.vin)}>
          Copy VIN
        </Button>
        <Button variant="secondary" style={COPY_TARGET} onClick={() => copy(texts.summary)}>
          Copy summary
        </Button>
        <Button variant="secondary" style={COPY_TARGET} onClick={() => copy(texts.link)}>
          Copy link
        </Button>
        <Button variant="secondary" style={COPY_TARGET} onClick={() => copy(texts.json)}>
          Copy JSON
        </Button>
        {/*
         * §6.2 lists Copy row last of the five, and it is the widest thing this grid
         * writes, so it takes the full width rather than leaving an odd cell beside it.
         */}
        <Button
          variant="secondary"
          className="col-span-2"
          style={COPY_TARGET}
          onClick={() => copy(texts.row)}
        >
          Copy row
        </Button>
      </div>

      <p className="text-sm leading-snug text-fg-muted">{ROW_HINT}</p>

      {/* Reserved height, so the confirmation never shifts the buttons under a thumb. */}
      <div className="min-h-[32px]" aria-live="polite">
        {copied ? <Chip tone="ok">{COPIED}</Chip> : null}
      </div>

      {/* §4.9 caps the URL at 700 bytes; what fell out is said plainly, not swallowed. */}
      {droppedNames !== null ? (
        <p className="text-sm leading-snug text-fg-muted">
          The QR code leaves out {droppedNames} to stay scannable. Share, Copy JSON and Download
          JSON still carry the whole record.
        </p>
      ) : null}

      {shareFailure !== null ? (
        <div ref={failureRef}>
          <Banner tone="warn" title={SHARE_FAILED}>
            {/* §6.4 prints the underlying error beneath its banner in monospace wherever the
              app has one, so that a person on a phone can read it back to whoever is asked
              to fix it. Web Share hands out four different faults under one exception name
              (SH-3), and this line is the only thing that separates them on a real device. */}
            <p className="font-vin text-sm break-words text-fg-muted">{shareFailure}</p>
          </Banner>
        </div>
      ) : null}

      {manual !== null ? (
        <div className={`flex flex-col gap-3 p-4 ${PANEL}`}>
          <p className="text-base leading-snug text-fg">{MANUAL_COPY_PROMPT}</p>
          <textarea
            ref={manualRef}
            readOnly
            value={manual}
            rows={6}
            aria-label="Text to copy"
            className={`${PANEL} w-full resize-y p-3 font-vin text-base leading-snug text-fg`}
          />
          <Button variant="secondary" onClick={() => setManual(null)}>
            Done
          </Button>
        </div>
      ) : null}

      {qrOpen ? (
        <QrView
          value={texts.url}
          vin={record.vin}
          note={droppedNames === null ? undefined : `This code leaves out ${droppedNames}.`}
          onClose={closeQr}
        />
      ) : null}
    </section>
  );
}
