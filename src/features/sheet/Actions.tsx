import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { buildPayloadUrl, buildTextCarrier, payloadFromRecord } from "../../lib/payload/codec";
import { shareText } from "../../lib/payload/shareText";
import { db } from "../../lib/storage/db";
import type { VehicleRecord } from "../../lib/vin/types";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { QrView } from "../../ui/QrView";

const LABEL = "text-sm font-bold tracking-wide text-fg-muted uppercase";

/** §6.4 microcopy, verbatim. */
const NO_SHARE = "Sharing isn't available here. Copy or download instead.";
const COPIED = "Copied ✓";

/** §6.5: the confirmation shows for about 1.5 s. */
const COPIED_MS = 1500;

const SHARE_FAILED = "Sharing didn't finish. Copy or download instead.";

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

export function Actions({ record }: { record: VehicleRecord }) {
  // §4.9 `by`. Read here, once, so the tap handlers below never have to: a Dexie read
  // inside a handler would end the user gesture before the clipboard write (see `copy`).
  const settings = useLiveQuery(() => db.settings.get("settings"), []);
  const deviceLabel = (settings?.deviceLabel ?? "").trim() || null;

  const fileName = `vin-relay-${record.vin}.json`;

  /**
   * Every copyable string, built during render and held in memory. This is not an
   * optimisation: §6.5 and §11 require the clipboard write to be the first thing a tap
   * handler does, so nothing may be computed asynchronously at tap time.
   */
  const texts = useMemo(() => {
    const payload = payloadFromRecord(record, deviceLabel);
    return {
      vin: record.vin,
      summary: shareText(record),
      // §6.5 calls this "Link" while §4.9 gives links to the URL carrier: the button keeps
      // the §6.5 name and the §4.9 text-prefix behaviour, which is what another VIN Relay
      // imports from a message.
      link: buildTextCarrier(payload),
      json: JSON.stringify(record, null, 2),
      // The URL carrier points back at whatever deployment is on screen (§4.9); the
      // fragment carries the payload, so it never reaches that host's server.
      ...buildPayloadUrl(payload, window.location.origin),
    };
  }, [record, deviceLabel]);

  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const manualRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    return () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    };
  }, []);

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
    setShareError(null);
    const file = new File([texts.json], fileName, { type: "application/json" });
    const canFiles =
      typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
    // §4.9: the readable text always goes; the record rides along as a file when the
    // platform accepts files, and is dropped rather than blocking the share when it does not.
    const data: ShareData = canFiles
      ? { text: texts.summary, files: [file] }
      : { text: texts.summary };
    navigator.share(data).catch((cause: unknown) => {
      // Backing out of the system sheet is a choice, not a failure to report.
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setShareError(SHARE_FAILED);
    });
  }

  function download() {
    const url = URL.createObjectURL(new Blob([texts.json], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
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

      {/* §6.1: two columns of ≥ 48 px targets, no gesture on any of them (N5). */}
      <div className="grid grid-cols-2 gap-3">
        <Button variant="secondary" onClick={() => setQrOpen(true)}>
          QR code
        </Button>
        <Button variant="secondary" onClick={download}>
          Download JSON
        </Button>
        <Button variant="secondary" onClick={() => copy(texts.vin)}>
          Copy VIN
        </Button>
        <Button variant="secondary" onClick={() => copy(texts.summary)}>
          Copy summary
        </Button>
        <Button variant="secondary" onClick={() => copy(texts.link)}>
          Copy link
        </Button>
        <Button variant="secondary" onClick={() => copy(texts.json)}>
          Copy JSON
        </Button>
      </div>

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

      {shareError !== null ? <Banner tone="warn" title={shareError} /> : null}

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
