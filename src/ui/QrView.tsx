import { useEffect, useRef, useState } from "react";
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

/** Full-screen QR sheet. Escape closes it, and so does the button under the code. */
export function QrView({ value, vin, note, onClose }: QrViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The overlay covers the sheet, so the keyboard's next Tab has to land inside it.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    let cancelled = false;
    void toCanvas(canvas, value, {
      // §2, locked: error correction level M.
      errorCorrectionLevel: "M",
      margin: 2,
      width: Math.round(size * pixelRatio()),
      color: { dark: INK, light: PAPER },
    }).then(
      () => {
        if (!cancelled) setFailed(false);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`QR code for VIN ${groupVin(vin)}`}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 overflow-y-auto p-4"
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
        ref={closeRef}
        type="button"
        onClick={onClose}
        className="min-h-[var(--tap-lg)] w-full max-w-[520px] rounded-[var(--radius)] border-2 px-6 text-lg font-bold active:opacity-80"
        style={{ borderColor: INK, color: INK, backgroundColor: PAPER }}
      >
        Close
      </button>
    </div>
  );
}
