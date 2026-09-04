import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toCanvas } from "qrcode";
import { groupVin } from "../lib/vin/grammar";

export interface QrViewProps {
  /** The string the code carries — for handoff, the §4.9 URL carrier. */
  value: string;
  /** Printed under the code so the other person can confirm the vehicle before scanning. */
  vin: string;
  /** Optional line about what the payload had to leave out to fit (§4.9 cap). */
  note?: string;
  onClose: () => void;
}

/**
 * §9-S3 asks for a max-brightness hint. The web cannot set screen brightness, so the
 * screen is told to the user instead, and the sheet is painted white to put out as much
 * light as the display has.
 */
const BRIGHTNESS_HINT = "Turn your screen brightness all the way up, then hold the phone steady.";

/**
 * A scanner reads dark modules on a light field. A theme-coloured code — dark modules on
 * the dark background this app defaults to — does not scan, so this overlay is black on
 * white in both themes and says so in its own colours rather than the tokens (§6.1).
 */
const INK = "#000000";
const PAPER = "#ffffff";

/**
 * Big enough to scan from arm's length across a truck hood, small enough to fit the
 * short side of a phone in landscape with the caption still on screen.
 */
function fitSize(): number {
  const shortest = Math.min(window.innerWidth, window.innerHeight);
  return Math.max(200, Math.min(Math.round(shortest * 0.74), 520));
}

/** Draw at device pixels so the module edges stay hard; capped so huge DPRs stay cheap. */
function pixelRatio(): number {
  return Math.min(window.devicePixelRatio || 1, 3);
}

/**
 * Full-screen QR sheet, modal over the record it came from. Escape closes it, and so does
 * the button under the code; while it is up, the keyboard cannot leave it.
 */
export function QrView({ value, vin, note, onClose }: QrViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [size, setSize] = useState(() => fitSize());
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const update = () => setSize(fitSize());
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  /**
   * §6.6 — Tab, Escape and the focus ring have to work here too, and this is the one screen
   * in the app that covers another one.
   *
   * `showModal()` rather than a hand-rolled trap: the platform puts the overlay in the top
   * layer, moves focus to the first focusable element inside it (the Close button — the only
   * one, so the explicit `focus()` this replaces was saying the same thing twice), scopes Tab
   * and Shift+Tab to the dialog, and makes everything behind it inert, which is what keeps a
   * screen reader on the code the user is holding up rather than on a form they cannot see.
   * Measured before this: Tab from Close reached the bottom nav, then the browser chrome, then
   * wrapped into the sheet's own Refresh details and unit field; Shift+Tab reached Copy JSON.
   *
   * `<dialog>` sits below this project's floor — Vite's default build target here is iOS 16.4
   * / Chrome 111, and `showModal()` shipped in iOS 15.4 / Chrome 37 — so there is no
   * capability branch to take and no fallback to keep working.
   *
   * A layout effect, not a passive one: the element must be in the top layer before the frame
   * that first paints it, or the overlay is briefly a normal box in the middle of the sheet.
   */
  useLayoutEffect(() => {
    const node = dialogRef.current;
    if (node === null) return;
    // Where the keyboard was when this opened: the QR button on the sheet.
    const opener = document.activeElement;
    // StrictMode runs this twice; the cleanup closes, so the second call has a shut dialog.
    if (!node.open) node.showModal();
    return () => {
      if (node.open) node.close();
      // The parent unmounts this rather than closing it in place, so the platform's own
      // focus restoration does not get to run — React pulls the element out of the top layer
      // and focus falls to <body>. Put the keyboard back where the user left it.
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    let cancelled = false;

    /**
     * The backing store is `size × DPR` so the module edges stay hard on a phone; the CSS box
     * has to stay `size`. `qrcode`'s canvas renderer ends every draw with
     * `canvas.width = px; canvas.style.width = px + "px"` (`renderer/canvas.js`, `clearCanvas`)
     * — it assumes the backing store it was handed *is* the CSS size, which is true only at
     * DPR 1. So its inline style replaces the box React set, and at DPR 3 a 237 px code becomes
     * a 711 px one: measured on a 320 × 658 phone at x = −195.5, clipped by the viewport on both
     * sides, with Close pushed to y = 727 below the fold. A cropped QR does not decode, and
     * §9-S3's whole flow is "show QR, scan QR". Desktop is DPR 1, which is why it never showed.
     *
     * Put the box back. Not by dropping the multiply above — that trades an overflow for a
     * blurry code on every phone, which is the same §9-S3 failure one step further away.
     *
     * Race-free in all four directions:
     * - **vs. paint.** `toCanvas` renders synchronously inside its own Promise executor
     *   (`browser.js`), so the library's write lands during this effect and this handler runs on
     *   the microtask that follows it. A frame cannot be painted between a task and its
     *   microtask checkpoint, so the oversized box never reaches the screen. If the library ever
     *   went async, the handler still runs immediately after the write it has to undo.
     * - **vs. React.** React writes `style.width` only when the prop changes — which happens
     *   only when `size` changes, which is exactly when this effect re-runs and writes last.
     *   A re-render at the same `size` (the `failed` toggle below) diffs to no style write at
     *   all, so the restored box survives it.
     * - **vs. a second resize.** A resize that changes `size` re-runs this effect: cleanup
     *   cancels the old draw, the new one restores the new size. A resize that computes the same
     *   `size` does not re-render, so the library is never re-run and there is nothing to undo.
     * - **vs. cancellation.** Skipping the restore when `cancelled` cannot strand a pixel-sized
     *   box: the only ways to cancel are a `value`/`size` change, whose replacement draw
     *   restores, and unmount.
     *
     * The rejection path restores too. `QRCode.create` throws before the renderer runs, so
     * today there is nothing to undo there — but the restore is what makes that a fact about
     * this component rather than one about the library's throw site.
     */
    const restoreCssSize = () => {
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
    };

    void toCanvas(canvas, value, {
      // §2, locked: error correction level M.
      errorCorrectionLevel: "M",
      margin: 2,
      width: Math.round(size * pixelRatio()),
      color: { dark: INK, light: PAPER },
    }).then(
      () => {
        if (cancelled) return;
        restoreCssSize();
        setFailed(false);
      },
      () => {
        if (cancelled) return;
        restoreCssSize();
        setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  return (
    // `role` and `aria-modal` are what `<dialog>` opened with `showModal()` already means;
    // stating them again is how the two drift apart. The size utilities are not decoration:
    // the UA sizes a dialog to its contents and caps it below the viewport, and this one is
    // a light field for a camera to read, edge to edge.
    <dialog
      ref={dialogRef}
      aria-label={`QR code for VIN ${groupVin(vin)}`}
      onCancel={(event) => {
        // Escape. The parent owns whether this is mounted — the same path the Close button
        // takes — so let React take it down instead of letting the platform hide it behind
        // React's back and leave a live overlay nobody can see.
        event.preventDefault();
        onClose();
      }}
      className="fixed inset-0 z-50 flex h-full max-h-none w-full max-w-none flex-col items-center justify-center gap-4 overflow-y-auto p-4"
      style={{ backgroundColor: PAPER, color: INK }}
    >
      <p className="max-w-[520px] text-center text-base leading-snug" style={{ color: INK }}>
        {BRIGHTNESS_HINT}
      </p>

      {failed ? (
        <p
          className="max-w-[520px] text-center text-base leading-snug font-bold"
          style={{ color: INK }}
        >
          This code couldn&apos;t be drawn. Use Share, Copy link or Download JSON instead.
        </p>
      ) : null}

      {/* Kept mounted while `failed` so the redraw on the next resize has a canvas to use. */}
      <canvas
        ref={canvasRef}
        className={failed ? "hidden" : "block"}
        style={{ width: `${size}px`, height: `${size}px`, backgroundColor: PAPER }}
      />

      <p
        className="max-w-full text-center font-vin text-[18px] font-semibold break-words"
        style={{ color: INK }}
      >
        {groupVin(vin)}
      </p>

      {note !== undefined ? (
        <p className="max-w-[520px] text-center text-sm leading-snug" style={{ color: INK }}>
          {note}
        </p>
      ) : null}

      {/* §6.1: the way out is a 56 px target, not a gesture (N5). */}
      <button
        type="button"
        onClick={onClose}
        className="min-h-[var(--tap-lg)] w-full max-w-[520px] rounded-[var(--radius)] border-2 px-6 text-lg font-bold active:opacity-80"
        style={{ borderColor: INK, color: INK, backgroundColor: PAPER }}
      >
        Close
      </button>
    </dialog>
  );
}
