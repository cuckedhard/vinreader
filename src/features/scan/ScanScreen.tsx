import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { PayloadError, encodePayload, parseCarrier } from "../../lib/payload/codec";
import { getSettings } from "../../lib/storage/settings";
import type { ExtractResult } from "../../lib/vin/types";
import { Banner } from "../../ui/Banner";
import { Button, TAP_LG_TARGET } from "../../ui/Button";
import { CameraView } from "./CameraView";
import { ManualEntry } from "./ManualEntry";
import { scanFeedback } from "./feedback";
import type { ScanSighting } from "./scanMachine";
import { useScanner } from "./useScanner";
import { useVinCommit } from "./useVinCommit";

type Mode = "camera" | "manual";

/**
 * The default screen (§6.2): the camera, with the keyboard one tap away. The two modes are
 * exclusive — typing turns the scanner off, which releases the camera and its battery
 * draw while the on-screen keyboard covers the preview anyway.
 */
export function ScanScreen() {
  const [mode, setMode] = useState<Mode>("camera");
  const [carrierError, setCarrierError] = useState<string | null>(null);
  const navigate = useNavigate();
  // §9-S3 phone-to-phone: the receiving phone shows the import preview rather than
  // confirming a VIN. Both carriers are re-encoded into the single `d` the route reads,
  // and an unreadable one just leaves the camera running.
  const handleCarrier = useCallback(
    (raw: string) => {
      let payload;
      try {
        payload = parseCarrier(raw);
      } catch (cause) {
        // P6: an unknown version gets a clear rejection, never a crash — and never
        // silence. The carrier check is what stops extractVin fabricating a VIN out of
        // the base64url body (D14), so this code is the scanner's to report: dropping it
        // leaves the user pointing a working camera at a code that never resolves.
        // P6 wants a clear rejection. `kind === "version"` covers any v other than 1,
        // older included, so the message comes from the error rather than assuming which
        // direction it went — the same text the Import route shows for the same payload.
        setCarrierError(
          cause instanceof PayloadError && cause.kind === "version"
            ? cause.message
            : "That VIN Relay code could not be read. Ask for it again, or type the VIN.",
        );
        return;
      }
      if (payload === null) return;
      setCarrierError(null);
      void navigate(`/i?d=${encodePayload(payload)}`);
    },
    [navigate],
  );
  const { state, videoRef, torch, focus, retry, rescan, accept } = useScanner({
    enabled: mode === "camera",
    onCarrier: handleCarrier,
  });
  // `useAsIs` is renamed on the way out: it is a plain method, and the hooks lint reads any
  // `use…()` call inside a callback as a misplaced hook.
  const { pending, saving, error, request, useAsIs: saveAsIs, dismiss } = useVinCommit();
  // One sighting, one write. React 19 StrictMode double-invokes this effect in development,
  // and a second pass would log one read as two scans (§5.3).
  const acted = useRef<ScanSighting | null>(null);

  useEffect(() => {
    if (state.kind !== "confirmed") return;
    const sighting = state.sighting;
    if (acted.current === sighting) return;
    acted.current = sighting;

    async function commit(read: ScanSighting) {
      // N1: a settings read that fails must not fail the save. useVinCommit already
      // guards its own read this way; these two sites did not, so an unavailable
      // IndexedDB aborted the write before it started and left "Got it ✓" on screen
      // for a scan nothing had stored.
      const settings = await getSettings().catch(() => null);
      const candidate: ExtractResult = {
        vin: read.vin,
        raw: read.raw,
        checkDigitValid: read.checkDigitValid,
      };
      const saved = await request(candidate, { origin: "scan", symbology: read.symbology });
      // §6.3: success feedback never fires on a mismatch — and a read the user has not
      // resolved yet is not a scan, so nothing else fires either.
      if (!saved) return;
      if (settings) scanFeedback(settings);
      accept(read.vin);
    }

    void commit(sighting);
  }, [state, request, accept]);

  const handleUseAsIs = useCallback(async () => {
    if (pending === null) return;
    const vin = pending.vin;
    const settings = await getSettings().catch(() => null);
    const saved = await saveAsIs();
    if (!saved) {
      // The record was never written, so no cooldown may be recorded: `accept` is what
      // writes it, and the store now outlives this screen, so a premature entry would
      // make the offered "Scan again" ignore the same label for a full ten seconds.
      // `rescan` lifts the machine out of `confirmed` without recording anything.
      rescan();
      return;
    }
    if (settings) scanFeedback(settings);
    accept(vin);
  }, [pending, saveAsIs, accept, rescan]);

  const handleRescan = useCallback(() => {
    // §6.3: the read was never persisted, so no cooldown is recorded and the same label
    // reads again straight away.
    dismiss();
    rescan();
  }, [dismiss, rescan]);

  const handleScanAgain = useCallback(() => {
    dismiss();
    retry();
  }, [dismiss, retry]);

  const showManual = useCallback(() => {
    dismiss();
    // The warning is about a code in front of the camera; leaving it set means it
    // reappears on the way back from the keyboard, about a code long gone (P7).
    setCarrierError(null);
    setMode("manual");
  }, [dismiss]);

  // R3-F1: the machine stays `streaming` for a refused carrier, so the preview keeps its
  // full height and the banner opens below the fold — 0 visible pixels of it at 360x640,
  // and 0 of "Keep scanning", while the live QR under "Point at the barcode…" was all the
  // user could see. That is the silent refusal §6.4 owes an answer to (P7), so the banner
  // is scrolled to where it can be read. The same move F8 made for the armed delete, for
  // the same reason, and `block: "nearest"` scrolls the least it can: a screen tall enough
  // to hold the banner already does not move. The camera is not stopped, hidden or shrunk —
  // it is still streaming and still decoding, because a scan is never blocked (N1/P1).
  const carrierRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (carrierError === null) return;
    carrierRef.current?.scrollIntoView({ block: "nearest" });
  }, [carrierError]);

  const showCamera = useCallback(() => {
    setCarrierError(null);
    setMode("camera");
  }, []);

  return (
    // The camera screen lays its preview and its controls side by side in landscape (F11),
    // and a `max-w-md` column is what left it 200 px of an 844 px screen to do it in — the
    // "wide empty margins" the finding measured. The keyboard screen keeps the reading
    // measure: a single input does not want to be 736 px wide, and nothing about it was
    // broken sideways.
    <section
      className={
        "mx-auto flex w-full max-w-md flex-col gap-4 p-4 pb-8" +
        (mode === "camera" ? " landscape:max-w-3xl" : "")
      }
    >
      <h1 className="text-2xl leading-tight font-bold text-fg">
        {mode === "camera" ? "Scan a VIN" : "Type a VIN"}
      </h1>

      {mode === "camera" ? (
        <>
          <CameraView
            state={state}
            videoRef={videoRef}
            torch={torch}
            focus={focus}
            onRetry={retry}
            onTypeInstead={showManual}
            unsaved={error !== null}
          />

          {carrierError !== null ? (
            <div ref={carrierRef}>
              <Banner
                tone="warn"
                title="Couldn't read that code"
                actions={
                  <Button variant="secondary" onClick={() => setCarrierError(null)}>
                    Keep scanning
                  </Button>
                }
              >
                {carrierError}
              </Banner>
            </div>
          ) : null}

          {pending !== null ? (
            <Banner
              tone="warn"
              title="Check digit doesn't match."
              actions={
                <>
                  <Button variant="primary" onClick={handleRescan} disabled={saving}>
                    Rescan
                  </Button>
                  {/* §6.1 names Use as-is in the ≥ 56 px list, and this is a secondary — so
                      the pin says something the variant does not, and stays. */}
                  <Button
                    variant="secondary"
                    className="h-14"
                    onClick={() => void handleUseAsIs()}
                    disabled={saving}
                  >
                    Use as-is
                  </Button>
                </>
              }
            >
              Usually a misread — try again.
            </Banner>
          ) : null}

          {error !== null ? (
            <Banner
              tone="danger"
              title="Couldn't save this VIN"
              actions={
                <Button variant="primary" onClick={handleScanAgain}>
                  Scan again
                </Button>
              }
            >
              <p>Nothing was written. Read the label again, or type it.</p>
              <p className="mt-2 font-vin text-sm break-words text-fg-muted">{error}</p>
            </Banner>
          ) : null}
        </>
      ) : (
        <>
          <p className="text-base leading-snug text-fg-muted">
            Type or paste the VIN from the door jamb label — spaces and a leading I are fine.
          </p>
          <ManualEntry />
          {/* §6.1 names Scan in the ≥ 56 px list. This is that action on the typed screen —
              the way back to the camera — and `secondary` is 48 by variant (R6-SA-3). */}
          <Button variant="secondary" full style={TAP_LG_TARGET} onClick={showCamera}>
            Scan with the camera
          </Button>
        </>
      )}
    </section>
  );
}

export default ScanScreen;
