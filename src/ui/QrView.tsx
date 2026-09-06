import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toCanvas } from "qrcode";
import { groupVin } from "../lib/vin/grammar";
import { VinDisplay } from "./VinDisplay";

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
 * The floor, in CSS px. A §4.9 payload at the 700-byte cap is a version-18 code — 89 modules,
 * 93 with the quiet zone — so 200 px is 2.15 px per module, and physically ~53 mm across. The
 * usual working rule for a phone camera is a scanning distance of about ten times the code's
 * width, so 200 px is a code read from roughly half a metre: across a table, or a truck bed,
 * which is what §9-S3's "show QR, scan QR" has to survive. Below this the code stops being the
 * thing the other phone can read, so nothing here shrinks past it — if the viewport is too
 * short to hold a 200 px code *and* the chrome, the overlay scrolls instead: it is the box the
 * code sits in (`boxRef` below) that carries this as its `min-height`, so the code stays whole
 * and the scrollbar is what gives. Measured, that starts under ~250 px of viewport height in
 * landscape and under ~400 px in portrait, i.e. below every phone and every window in the gate.
 */
const MIN_CODE_PX = 200;

/** Past this a bigger code buys a desktop nothing and just costs the rest of the layout room. */
const MAX_CODE_PX = 520;

/**
 * A *visual* inset, not a reservation for the caption: the code stops short of the edges the
 * hand is holding, so a glove or a thumb on the bezel does not land on a finder pattern (§6.1,
 * "one hand free"). The room the caption and Close need is measured, not budgeted — see below.
 */
const CODE_INSET = 0.74;

/**
 * The code is the smallest of three bounds:
 *
 *  1. **the box actually left for it** — `box`, the measured content rect of the one flex item
 *     the code lives in. Everything else in the overlay (the brightness hint, the grouped VIN,
 *     the optional note, Close, the gaps between them and the dialog's padding) takes its space
 *     first and the code flexes into the remainder, so adding a line of caption shrinks the code
 *     by that line with no constant here to keep in step. That is R4-I: the old version took 74%
 *     of the viewport's shorter side and reserved *nothing* for chrome, so whenever the shorter
 *     side was the height — a phone held sideways, a short desktop window — the ~207 px of chrome
 *     went below the fold and took the way out with it;
 *  2. `CODE_INSET` of the viewport's shorter side;
 *  3. `MAX_CODE_PX`.
 *
 * Floored at `MIN_CODE_PX`, which wins over all three: an unscannable code is not a smaller
 * problem than a scrollbar.
 *
 * `box` is null only for the first render, before there is an element to measure; the viewport
 * inset is the opening guess and the layout effect below corrects it before the frame is painted.
 */
function fitSize(box: { w: number; h: number } | null): number {
  const inset = Math.round(Math.min(window.innerWidth, window.innerHeight) * CODE_INSET);
  // Floor, not round: the box is what the code has to stay inside, to the subpixel.
  const room = box === null ? inset : Math.floor(Math.min(box.w, box.h));
  return Math.max(MIN_CODE_PX, Math.min(room, inset, MAX_CODE_PX));
}

/** Past this a denser backing store buys the camera nothing and costs real memory. */
const MAX_PIXEL_RATIO = 3;

/**
 * The *raw* ratio, uncapped. The cap belongs at the draw (`Math.min(ratio, MAX_PIXEL_RATIO)`)
 * and not here, because this value is also what the `(resolution: …dppx)` query below is built
 * from: a capped value would make that query false from the start on a 4× display, and a
 * change from 4× to 2× — which *does* move the drawn ratio, 3 → 2 — would never fire it.
 */
function pixelRatio(): number {
  return window.devicePixelRatio || 1;
}

/**
 * §6.1's two-tone focus ring (R3-U), inverted, and the inversion is the whole point.
 *
 * The overlay is black on white in both themes — a scanner reads dark modules on a light
 * field — so the app-wide `:focus-visible { outline: 3px solid var(--accent) }` lands on
 * white paper here whatever the palette says. Measured in Chromium against the dialog's
 * actual `rgb(255,255,255)`: dark `--accent` #57c7ff is **1.91:1**, against WCAG's 3:1 floor
 * for a focus indicator; light #09538e is 7.96:1, so this failed in the default theme only,
 * which is why the light-theme pass could not see it. Same class as R4-E, one overlay over.
 *
 * `CameraView`'s ring puts black outermost and white inside because there the *inner* side
 * faces scrimmed video. Here both sides are white — the paper field outside the button and
 * the button's own white fill inside — and the edge between them is the button's resting 2 px
 * black border. So the tones swap: white first (0–2 px in from the padding edge, separating
 * the ring from that border so the focused state does not read as a slightly thicker one),
 * black behind it (2–5 px, against the white fill). Measured, both themes, and the same in
 * both because no token is involved: **21.00:1** at every edge — white ring vs. the black
 * border outside it and the black ring inside it, black ring vs. the white fill it sits on.
 *
 * Inset `box-shadow` rather than an `outline` for the same reason as `CameraView`'s: an
 * outward ring on this button is drawn on the white field and would need a white tone to
 * separate it from the paper, which is a colour that cannot be drawn on white. Inset puts
 * both tones inside the one edge that is already black.
 */
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_#fff,inset_0_0_0_5px_#000]";

/**
 * Full-screen QR sheet, modal over the record it came from. Escape closes it, and so does
 * the button under the code; while it is up, the keyboard cannot leave it.
 */
export function QrView({ value, vin, note, onClose }: QrViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(() => fitSize(null));
  const [ratio, setRatio] = useState(pixelRatio);
  const [failed, setFailed] = useState(false);

  const dpr = Math.min(ratio, MAX_PIXEL_RATIO);

  const measure = useCallback((node: HTMLElement) => {
    const rect = node.getBoundingClientRect();
    // A box that has not been laid out at all is not a box 0 px wide, and `fitSize` cannot
    // tell the two apart — it would read the zero as "no room" and hand back `MIN_CODE_PX`.
    // The effect below opens the dialog before it measures, so this cannot fire today; it is
    // here so that if it ever can, the opening guess survives instead of a 200 px floor.
    if (rect.width === 0 && rect.height === 0) return;
    // Same number ⇒ React bails out, so a resize that changes nothing redraws nothing.
    setSize(fitSize({ w: rect.width, h: rect.height }));
  }, []);

  /**
   * §6.6 and §9-S3 in one effect, because the order of the three steps inside it is
   * load-bearing and splitting them across two hooks makes that order an accident of
   * declaration order that nothing states and nothing checks.
   *
   * **1. Open.** `showModal()` rather than a hand-rolled trap: the platform puts the overlay
   * in the top layer, moves focus to the first focusable element inside it (the Close button
   * — the only one, so the explicit `focus()` this replaces was saying the same thing twice),
   * scopes Tab and Shift+Tab to the dialog, and makes everything behind it inert, which is
   * what keeps a screen reader on the code the user is holding up rather than on a form they
   * cannot see. Measured before this: Tab from Close reached the bottom nav, then the browser
   * chrome, then wrapped into the sheet's own Refresh details and unit field; Shift+Tab
   * reached Copy JSON.
   *
   * `<dialog>` sits below this project's floor — Vite's default build target here is iOS 16.4
   * / Chrome 111, and `showModal()` shipped in iOS 15.4 / Chrome 37 — so there is no
   * capability branch to take and no fallback to keep working.
   *
   * A layout effect, not a passive one: the element must be in the top layer before the frame
   * that first paints it, or the overlay is briefly a normal box in the middle of the sheet.
   *
   * **2. Measure, once, by hand**, so the opening guess is never the thing that gets painted.
   * This is why the open has to come first: the UA stylesheet gives a closed `<dialog>`
   * `display: none`, and a `display: none` box measures 0 × 0, which `fitSize` floors to
   * `MIN_CODE_PX`. Today the dialog's own `flex` utility outranks that UA rule, so the box is
   * laid out even while closed and the measurement happens to be right — measured in
   * Chromium at 658 × 320: the box is 305 × 228 before `showModal()`, and the first painted
   * code is 228 px, not 200. That is one class name away from being untrue: re-assert
   * `dialog:not([open]) { display: none }` and the first paint drops to the 200 px floor and
   * only the observer below corrects it. Opening first makes the right measurement a
   * consequence of this function rather than of the class list.
   *
   * **3. Observe.** A `ResizeObserver` on the code's own box rather than a `resize` listener
   * on the window: the box is what the code has to fit, and it moves for reasons the window
   * does not report — the caption rewrapping, the note line appearing, the failure line
   * appearing. It subsumes the window listeners this replaces, because the box is anchored to
   * `inset-0` and so changes on every viewport resize and every orientation change that
   * changes it at all. It cannot feed back on itself: the box is `flex-1` from a zero basis
   * with a fixed minimum, so its size is a function of the viewport and the other rows, never
   * of the canvas inside it.
   */
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const box = boxRef.current;
    if (dialog === null || box === null) return;
    // Where the keyboard was when this opened: the QR button on the sheet.
    const opener = document.activeElement;
    // StrictMode runs this twice; the cleanup closes, so the second call has a shut dialog.
    if (!dialog.open) dialog.showModal();
    measure(box);
    const observer = new ResizeObserver(() => measure(box));
    observer.observe(box);
    return () => {
      observer.disconnect();
      if (dialog.open) dialog.close();
      // The parent unmounts this rather than closing it in place, so the platform's own
      // focus restoration does not get to run — React pulls the element out of the top layer
      // and focus falls to <body>. Put the keyboard back where the user left it.
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [measure]);

  /**
   * R4-J. The draw below reads the device pixel ratio, and a ratio change does not have to
   * move anything else: drag a window from a Retina display to a 1× one and `innerWidth`,
   * the box and therefore `size` are all unchanged, so nothing re-ran the draw and the
   * backing store kept the old ratio — a soft code, which is the §9-S3 failure R4-H was.
   * (Browser zoom was always safe: it moves CSS-px `innerWidth`, so `size` changes.)
   *
   * `matchMedia("(resolution: <current>dppx)")` is the only event the platform offers for
   * this. The query is built from the ratio it is watching, so it is true when it is made and
   * goes false on any change, in either direction; the handler re-reads the ratio, and the
   * new value re-runs this effect, which re-subscribes at the new ratio.
   *
   * `resolution` reached Safari 16, under this project's 16.4 floor. Guarded anyway: the
   * compatibility pass removes `matchMedia` among other capabilities and expects the app to
   * keep rendering, and a missing listener here costs sharpness on a display change, not the
   * handoff.
   */
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(`(resolution: ${ratio}dppx)`);
    const onChange = () => setRatio(pixelRatio());
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [ratio]);

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
     *   box: the only ways to cancel are a `value`/`size`/`dpr` change, whose replacement draw
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
      width: Math.round(size * dpr),
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
    // `dpr` and not `ratio`: above `MAX_PIXEL_RATIO` the drawn ratio does not move, so a
    // 4× → 5× display change re-renders and redraws nothing (R4-J).
  }, [value, size, dpr]);

  return (
    // `role` and `aria-modal` are what `<dialog>` opened with `showModal()` already means;
    // stating them again is how the two drift apart. The size utilities are not decoration:
    // the UA sizes a dialog to its contents and caps it below the viewport, and this one is
    // a light field for a camera to read, edge to edge.
    //
    // `justify-start`, not `justify-center`: the group below grows into every spare pixel, so
    // the two are identical until the overlay overflows — and a centred overflow in a scroll
    // container puts its top out of reach of the scrollbar. Measured before this fix on a
    // 658 × 320 phone: the brightness hint sat at y = −46 with no way to scroll up to it.
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
      className="fixed inset-0 z-50 flex h-full max-h-none w-full max-w-none flex-col items-center justify-start gap-4 overflow-y-auto p-4"
      style={{ backgroundColor: PAPER, color: INK }}
    >
      <p className="max-w-[520px] text-center text-base leading-snug" style={{ color: INK }}>
        {BRIGHTNESS_HINT}
      </p>

      {/*
        Two groups, and the direction between them is the whole of R4-I's fix: stacked while the
        screen is taller than it is wide, side by side once it is not. A phone held sideways has
        no spare height for a column — 320 px of it, less ~207 px of chrome, leaves 113 px, under
        the floor a code has to keep — but it has spare *width*, and this spends it. Measured
        after: the code is 228 px on a 658 × 320 galaxy-s9 (was 237), 305 on an 839 × 412 pixel-7
        (unchanged) and 426 in a 1024 × 576 window (unchanged), so at most 9 px of code buys back
        a Close button that was 46 px under the fold, and nothing in the overlay scrolls.
      */}
      <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-4 landscape:flex-row">
        {/*
          The one item that flexes: the code's box is whatever is left after every other row has
          taken its height (or, in landscape, its width). `flex-1` from a zero basis is what makes
          that "the remainder" rather than "the canvas's own size", and the minimum is the floor —
          when the viewport is too small to hold both, the box keeps the code readable and the
          dialog scrolls (it is `overflow-y-auto`, and Escape and the focus trap do not care).
        */}
        <div
          ref={boxRef}
          className="flex flex-1 items-center justify-center self-stretch"
          style={{ minWidth: MIN_CODE_PX, minHeight: MIN_CODE_PX }}
        >
          {failed ? (
            <p
              className="max-w-full text-center text-base leading-snug font-bold"
              style={{ color: INK }}
            >
              This code couldn&apos;t be drawn. Use Share, Copy link or Download JSON instead.
            </p>
          ) : null}

          {/* Kept mounted while `failed` so the redraw on the next resize has a canvas to use.
              `shrink-0`: the box is a flex container, and a code squeezed narrower than its
              backing store is the R4-H shape of failure again, one axis at a time. */}
          <canvas
            ref={canvasRef}
            className={failed ? "hidden" : "block shrink-0"}
            style={{ width: `${size}px`, height: `${size}px`, backgroundColor: PAPER }}
          />
        </div>

        {/*
          `min-w-[var(--tap)]`: in the landscape row this column and the code split the width, and
          §6.1's 48 px floor is not something a narrow window gets to negotiate away. A viewport
          under 200 + 16 + 48 + 32 = 296 px wide cannot hold the code, the gap, a legal target and
          the padding at once; there the overlay scrolls rather than shrinking either one.
        */}
        <div className="flex w-full max-w-[520px] min-w-[var(--tap)] flex-col items-center gap-4 landscape:flex-1">
          {/* §6.1's VIN display, from the one component that knows what that means: this is
              where a second person reads the number off the screen to key it in, and it used
              to be 18 px with no letter-spacing at all (R3-F6). The ink is a value, not a
              token, because this surface is paper for a camera — hence `style`. */}
          <VinDisplay
            vin={vin}
            size="lg"
            className="max-w-full text-center break-words"
            style={{ color: INK }}
          />

          {note !== undefined ? (
            <p className="max-w-full text-center text-sm leading-snug" style={{ color: INK }}>
              {note}
            </p>
          ) : null}

          {/* §6.1: the way out is a 56 px target, not a gesture (N5). It is also the only tab
              stop the trap leaves, so §6.6's visible ring is this overlay's whole keyboard
              affordance — hence `FOCUS_RING` rather than the palette one. */}
          <button
            type="button"
            onClick={onClose}
            className={
              "min-h-[var(--tap-lg)] w-full rounded-[var(--radius)] border-2 px-6 text-lg " +
              `font-bold active:opacity-80 ${FOCUS_RING}`
            }
            style={{ borderColor: INK, color: INK, backgroundColor: PAPER }}
          >
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}
