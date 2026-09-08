import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { RefusedRead } from "../../app/RefusedRead";
import { NOT_A_VIN } from "../../app/refusalText";
import { NOTHING_WRITTEN, WRITE_FAILED_TITLE } from "../../app/strings";
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
 * §6.4 gives the carrier rejection this word, and a refused read is answered the same way:
 * the tap says "I have read this, carry on", and the camera never stopped either way.
 * Written once so the two banners cannot drift apart (§7 item 5).
 */
const KEEP_SCANNING = "Keep scanning";

/**
 * The default screen (§6.2): the camera, with the keyboard one tap away. The two modes are
 * exclusive — typing turns the scanner off, which releases the camera and its battery
 * draw while the on-screen keyboard covers the preview anyway.
 */
export function ScanScreen() {
  const [mode, setMode] = useState<Mode>("camera");
  /**
   * The code "Keep scanning" was tapped for, as the decoder read it (R3-F5).
   *
   * Clearing the banner alone was not a way forward: the realistic case is the other phone
   * still holding the code up, so the very next decode — 629 ms later, measured — raised the
   * same rejection again, and the only real exits were "Type VIN instead" or walking away.
   * The dismissal is therefore about *that code* rather than about the banner. A different
   * code still reports (nothing is suppressed that the user has not already answered, P7),
   * and the way back from the keyboard re-arms it, because that is a fresh look at the scene.
   *
   * FR-6 turned this from two refs into one state, and that is the whole of the change here:
   * the rejection itself is the machine's now, so the only thing left for the screen to
   * remember is which code the user has already answered — the same shape, in the same words,
   * as the refusal's `dismissedRefusal` below. State rather than a ref for its reason too:
   * what is shown is derived, and only a render can take a banner off the screen.
   */
  const [dismissedCarrier, setDismissedCarrier] = useState<string | null>(null);
  const navigate = useNavigate();
  // §9-S3 phone-to-phone: the receiving phone shows the import preview rather than
  // confirming a VIN. Both carriers are re-encoded into the single `d` the route reads,
  // and an unreadable one just leaves the camera running.
  const handleCarrier = useCallback(
    (raw: string): string | null => {
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
        //
        // FR-6: answered rather than stored. §6.4's words are still this screen's — it is what
        // parses the payload — but the notice they belong to is the machine's, because the
        // machine is the only thing that sees every frame and can therefore end it when the
        // frame moves on. Nothing here consults the dismissal either: a code the user has
        // answered is still a code in the frame, and hiding it is a render's decision.
        return cause instanceof PayloadError && cause.kind === "version"
          ? cause.message
          : "That VIN Relay code could not be read. Ask for it again, or type the VIN.";
      }
      if (payload === null) return null;
      // A readable code leaves for Import, and a dismissal cannot outlive the screen it was
      // made on. `null` tells the machine there is nothing to say about this frame.
      setDismissedCarrier(null);
      void navigate(`/i?d=${encodePayload(payload)}`);
      return null;
    },
    [navigate],
  );
  const { state, refusal, carrierError, videoRef, torch, focus, retry, rescan, accept } =
    useScanner({
      enabled: mode === "camera",
      onCarrier: handleCarrier,
    });
  /**
   * The read "Keep scanning" was tapped for, exactly as R3-F5 handles a refused carrier:
   * the answer is about *that text*, not about the banner, because the realistic case is
   * the same sticker still under the camera and the very next frame raising it again.
   * State rather than a ref, because what is shown is the machine's and only a render can
   * take it off the screen. A different read still reports (P7), and the way back from the
   * keyboard re-arms this one, because that is a fresh look at the scene.
   */
  const [dismissedRefusal, setDismissedRefusal] = useState<string | null>(null);
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

  /**
   * R3-F5: a rejection is about a code in the frame, and once the decoder has read something
   * else that code is gone — a notice describing it is describing something that is not there
   * (N2), and on the paths that keep this screen up it competes with the banner that is
   * actually asking the user something (P7).
   *
   * **FR-6: which is why there is no `state.kind` term here any more.** R3-F5 and FR-4 both
   * spent that rule on this derivation, over a `carrierError` the screen alone ever wrote —
   * `state.kind !== "candidate" && state.kind !== "confirmed"` — and a state guard *suppresses*
   * a notice rather than ending it. Every route back to `streaming` from a state that had merely
   * hidden the banner therefore re-raised it: one frame of a VIN label moved the machine to
   * `candidate`, no second frame agreed, §6.3's `tick` came back 1.5 s later, and the rejection
   * was on screen again about a code two codes ago with nothing in front of the camera. `visible`
   * after a hide past §6.3's window did the same. So the notice moved to the machine, beside the
   * refusal, where `decoded` and every restart of the camera already end exactly this kind of
   * claim (`NO_NOTICE`). One fact, one owner, one lifetime — and a fourth term in this boolean
   * would have answered one door and left the others open.
   *
   * **The precedence between the two banners is §6.3's, not either state's** (FR-4). Neither
   * notice outranks the other by kind; each yields to the other's *established* sighting,
   * because the only thing either has to go on is what the camera last read. What "established"
   * takes differs, and that is where the asymmetry comes from: a §4.9 carrier identifies itself,
   * so one frame is proof of it, while a refusal is a claim about arbitrary bytes and §6.3's
   * two-read agreement is what makes it a fact (FR-2's anti-strobe rule). With both codes in one
   * frame and the decoder alternating between them, the two banners **trade places** every few
   * seconds — ZXing does not strictly alternate, so two consecutive reads of the label do happen,
   * the refusal agrees, this one yields, and the next carrier frame takes it back. What holds
   * through that is the property worth having: never both at once, and never one about a code the
   * camera is not looking at. (FR-7: FR-4's comment claimed this banner "holds still and alone",
   * and the reviewer's 120-sample trace falsified it while confirming the invariant.)
   *
   * **Keyed on the refusal the machine holds, not on the banner.** `showRefusal` is the wrong
   * term here: "Keep scanning" says the user has read that notice, not that the carrier is back
   * in front of the camera, so a dismissal would put this older notice back on screen — the
   * same N2 in a new place.
   */
  const showCarrier =
    carrierError !== null && refusal === null && dismissedCarrier !== carrierError.raw;

  /**
   * FR-2, and the same rule as the line above it: a refusal is about what is in front of
   * the camera, so it must not outlive the code it describes (R3-F5, N2).
   *
   * Neither line takes a `state.kind` term, and since FR-6 that is one rule for both rather
   * than an asymmetry to explain: both notices are the machine's, each is about the last code
   * the camera read, and every read of a different code ends the one it replaces. A term over
   * the state would say something else — that a notice about the code in the frame *now* has to
   * wait for an unrelated candidate to lapse — which is the suppression FR-6 was, delayed rather
   * than fixed. It is not an untestable condition either, which is why it is asserted rather
   * than argued: `scan-carrier-then-lapse.spec.ts` reads the rejection and "Reading… hold
   * steady." out of one snapshot, and restoring the term is what makes that pair unreachable.
   */
  const showRefusal = refusal !== null && dismissedRefusal !== refusal.raw;

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
    setMode("manual");
  }, [dismiss]);

  const showCameraAgain = useCallback(() => {
    // A trip to the keyboard and back is a fresh look at the scene, so whatever was
    // dismissed before it is reported again if it is still there (R3-F5) — for both notices,
    // in the same two lines.
    setDismissedCarrier(null);
    setDismissedRefusal(null);
    // And the notices themselves go with the camera restart rather than with a setter here
    // (FR-6): `retry` is §6.3's own way back to `requesting` and it spreads `NO_NOTICE`, so the
    // update that turns the camera back on is the update that drops whatever was said about the
    // old scene. Left to the `enabled` effect it would land one render later instead — a
    // difference this suite cannot resolve, so the reason to dispatch it in the tap is R3-F5's
    // rather than a measured frame: the tap is where the answer to a notice belongs.
    retry();
    setMode("camera");
  }, [retry]);

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
    if (!showCarrier) return;
    carrierRef.current?.scrollIntoView({ block: "nearest" });
  }, [showCarrier]);

  // R3-F1 again, for the same reason and by the same means: the machine stays `streaming`
  // for a refused read, so this banner opens under a full-height preview and a phone-sized
  // fold does not reach it. The camera is not stopped, hidden or shrunk — it is still
  // decoding, because a scan is never blocked (N1/P1).
  const refusalRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!showRefusal) return;
    refusalRef.current?.scrollIntoView({ block: "nearest" });
  }, [showRefusal]);

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
          {/* R3-F11: §6.4 answers a failed write in two halves — "Not saved." beside the VIN,
              and this banner with what went wrong and the way on — and they were 200 px apart
              with `CameraView`'s "Type VIN instead" between them. The banner leads now: it is
              the most important thing on the screen, it sits against the status line it
              explains, and being above the preview it cannot open below the fold (R3-F1). */}
          {error !== null ? (
            <Banner
              tone="danger"
              title={WRITE_FAILED_TITLE}
              actions={
                <Button variant="primary" onClick={handleScanAgain}>
                  Scan again
                </Button>
              }
            >
              <p>{`${NOTHING_WRITTEN} Read the label again, or type it.`}</p>
              <p className="mt-2 font-vin text-sm break-words text-fg-muted">{error}</p>
            </Banner>
          ) : null}

          <CameraView
            state={state}
            videoRef={videoRef}
            torch={torch}
            focus={focus}
            onRetry={retry}
            onTypeInstead={showManual}
            unsaved={error !== null}
          />

          {showCarrier ? (
            <div ref={carrierRef}>
              <Banner
                tone="warn"
                title="Couldn't read that code"
                actions={
                  <Button variant="secondary" onClick={() => setDismissedCarrier(carrierError.raw)}>
                    {KEEP_SCANNING}
                  </Button>
                }
              >
                {carrierError.message}
              </Banner>
            </div>
          ) : null}

          {/* FR-2: a read that decoded cleanly and is not a VIN. §6.4 has no line for it,
              so the title is the one §6.4 already gives the same fact on the typed path,
              and the body is what was read and why — the string the mechanic in the report
              had to photograph because the app would not show it. The remedy is not
              repeated here: the status line above still says where the VIN barcode is, and
              this banner and "Type VIN instead" are both on screen. */}
          {refusal !== null && showRefusal ? (
            <div ref={refusalRef}>
              <Banner
                tone="warn"
                title={NOT_A_VIN}
                actions={
                  <Button variant="secondary" onClick={() => setDismissedRefusal(refusal.raw)}>
                    {KEEP_SCANNING}
                  </Button>
                }
              >
                <RefusedRead refusal={refusal} />
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
        </>
      ) : (
        <>
          <p className="text-base leading-snug text-fg-muted">
            Type or paste the VIN from the door jamb label — spaces and a leading I are fine.
          </p>
          <ManualEntry />
          {/* §6.1 names Scan in the ≥ 56 px list. This is that action on the typed screen —
              the way back to the camera — and `secondary` is 48 by variant (R6-SA-3). */}
          <Button variant="secondary" full style={TAP_LG_TARGET} onClick={showCameraAgain}>
            Scan with the camera
          </Button>
        </>
      )}
    </section>
  );
}

export default ScanScreen;
