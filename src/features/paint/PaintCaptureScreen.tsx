import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { OCR_TOTAL_BYTES } from "../../lib/ocr/assets.generated";
import { PAINT_CROP_BOX } from "../../lib/ocr/cropBox";
import type { PaintCaptureState } from "../../lib/ocr/session";
import type { OcrFailure } from "../../lib/ocr/types";
import { differingPositions, isLowConfidence, type PaintProposal } from "../../lib/ocr/vote";
import { setVehicleMeta } from "../../lib/storage/upsert";
import { asciiUpper } from "../../lib/vin/grammar";
import { Banner } from "../../ui/Banner";
import { Button, TAP_LG_TARGET } from "../../ui/Button";
import { VIN_TEXT_SIZES, VinDisplay } from "../../ui/VinDisplay";
import { usePaintCapture } from "./usePaintCapture";

/**
 * §6.4 has no line for any of this — layer 2 is new — so every sentence below is supplied
 * here and logged under §0 rule 4 for Zach to sign off.
 *
 * The one that is a finding rather than a phrasing choice is `WHERE`. S5 addendum §3:
 * "Point at the door jamb" is wrong for a meaningful fraction of vehicles. VW and Audi put
 * the code on the vehicle data sticker in the trunk or the spare-wheel well; GM legacy
 * uses the SPID label in the glovebox. So the prompt names the *box*, not a place on the
 * car, and the sentence under it says the location varies rather than guessing one.
 */
const AIM = "Put the box on the paint code.";
const WHERE =
  "The sticker is on the door jamb on some vehicles, and in the trunk, the spare-wheel " +
  "well or the glovebox on others.";
const firstUse = (): string =>
  `The first read downloads a ${megabytes(OCR_TOTAL_BYTES)} MB reader. It stays on this phone and works with no signal after that.`;
const READ = "Read the code";
const READ_AGAIN = "Read again";
const STARTING_CAMERA = "Starting camera…";

/**
 * §5, and the only sentence on this screen doing real work. The engine is right about 96
 * of 100 synthetic crops and there is no corpus of real stickers (§13.7), so roughly 4 in
 * 100 are wrong — undetectably, because a paint code has no check digit, no grammar and no
 * downstream lookup (N2). The heading says whose job that makes it.
 */
const CHECK_IT = "Check this against the sticker before you save it.";
const CROP_CAPTION = "The last frame it read:";
const MARKED = "Check the marked characters.";
const PICK_ONE = "It read these. Pick the one on the sticker.";
const LOW =
  "Low confidence. Hold the phone square to the label and fill the box — a tilt is what this gets wrong.";
const NOTHING = "Nothing readable in the box.";
const NOTHING_HELP = "Line the box up with the code, get closer, or type it below.";
const TYPE_LABEL = "Or type the paint code";
const TYPE_SAVE = "Save what I typed";
const BACK = "Back to the vehicle";
const SAVE_FAILED_TITLE = "Could not save";
const SAVE_FAILED = "The paint code is still in the box above. Tap Save to try again.";
const CAMERA_FAILED = "The camera didn't start here. You can still type the code.";

/** One sentence per §4-recorded refusal. None of them blames the user (§6.4). */
function failureText(reason: OcrFailure): string {
  switch (reason) {
    case "no_wasm":
      // §1: iOS Lockdown Mode disables WebAssembly outright, which is why typing stays
      // load-bearing however well this works.
      return "This browser has WebAssembly turned off, so the reader can't run. Type the code instead.";
    case "no_simd":
    case "no_worker":
    case "no_canvas":
    case "no_cache":
      return "This browser can't run the reader. Type the code instead.";
    case "scanner_live":
      return "The camera is busy with a barcode scan. Go back, then try again.";
    case "aborted":
      return "The read stopped when the screen went away. Try again.";
    case "download_failed":
      return "The reader didn't download. Check your signal and try again, or type the code.";
    case "corrupt_asset":
    case "dictionary_present":
      return "The reader didn't download cleanly. Try again, or type the code.";
    case "engine_failed":
    case "busy":
      return "The reader stopped. Try again, or type the code.";
  }
}

/**
 * Megabytes as a data plan counts them, not as a disk does. The number under this button is
 * the one the user is deciding about, and 4.5 against 4.3 for the same bytes is the kind of
 * difference that reads as a lie on a metered connection. Both the offer and the progress
 * line go through here, so they cannot disagree (§7 item 5).
 */
const MEGABYTE = 1_000_000;

function megabytes(bytes: number): string {
  return (bytes / MEGABYTE).toFixed(1);
}

/**
 * §5: "The value lives inside the primary control — `Save  NH-731P`, in `--vin-font` at
 * VinDisplay size on a ≥56 px primary. Tap target and reading target are the same pixels.
 * A pre-filled field with a Save button beside it is auto-accept with extra steps."
 *
 * The marks are an underline rather than a colour. This text sits on `--accent` (or on
 * `--bg-elev` when several candidates are offered), and a second palette colour on either
 * ground is a contrast measurement nobody has made; an underline survives greyscale, glare
 * and a colour-blind reader, which is the §6.1 case.
 */
function CodeInControl({ text, marked }: { text: string; marked: readonly number[] }) {
  return (
    <span className={`font-vin font-semibold ${VIN_TEXT_SIZES.lg}`}>
      {[...text].map((character, index) => (
        <span
          key={index}
          className={marked.includes(index) ? "underline decoration-2 underline-offset-4" : undefined}
        >
          {character}
        </span>
      ))}
    </span>
  );
}

/**
 * The proposal, and every way it refuses to be rubber-stamped.
 *
 * One candidate gets the primary with the value inside it. Two or three get equal-weight
 * ≥56 px buttons with **nothing preselected** and the differing characters marked (§5):
 * when the vote is split, styling one of them as the answer is a guess wearing the clothes
 * of a decision, and N2 says nothing downstream can catch that.
 */
function Proposal({
  proposal,
  cropUrl,
  saving,
  onSave,
}: {
  proposal: PaintProposal;
  cropUrl: string | null;
  saving: boolean;
  onSave: (code: string) => void;
}) {
  const several = proposal.candidates.length > 1;
  const differing = differingPositions(proposal.candidates.map((candidate) => candidate.text));

  return (
    <section className="flex flex-col gap-4" aria-labelledby="proposal-heading">
      <h2 id="proposal-heading" className="text-lg leading-snug font-bold text-fg">
        {several ? PICK_ONE : CHECK_IT}
      </h2>

      {/* §5: the cropped pixels the engine read, above the characters it read them as.
          Memory only, revoked when this screen goes — §12 forbids attaching the photo to
          the record, the share or the export. */}
      {cropUrl === null ? null : (
        <figure className="flex flex-col gap-2">
          <figcaption className="text-base text-fg-muted">{CROP_CAPTION}</figcaption>
          <img
            src={cropUrl}
            data-testid="paint-crop"
            alt=""
            className="w-full rounded-[var(--radius)] border border-border bg-black"
          />
        </figure>
      )}

      <div className="flex flex-col gap-3">
        {proposal.candidates.map((candidate) => (
          <Button
            key={candidate.text}
            data-testid="paint-candidate"
            // Equal weight, on purpose: `secondary` for every one of them when there are
            // several, so none of them is dressed as the answer.
            variant={several ? "secondary" : "primary"}
            full
            style={TAP_LG_TARGET}
            disabled={saving}
            onClick={() => onSave(candidate.text)}
          >
            Save{" "}
            <CodeInControl
              text={candidate.text}
              marked={several ? differing : proposal.marked}
            />
          </Button>
        ))}
      </div>

      {!several && proposal.marked.length > 0 ? (
        <p className="text-base leading-snug text-warn">{MARKED}</p>
      ) : null}
      {isLowConfidence(proposal) ? (
        <p className="text-base leading-snug text-fg-muted">{LOW}</p>
      ) : null}
    </section>
  );
}

/** What the screen says while it is working. Never a claim about the answer. */
function statusOf(state: PaintCaptureState, cameraReady: boolean): string | null {
  switch (state.kind) {
    case "offer":
      return cameraReady ? AIM : STARTING_CAMERA;
    case "downloading":
      return `Downloading the reader… ${megabytes(state.loadedBytes)} of ${megabytes(state.totalBytes)} MB`;
    case "reading":
      return `Reading… hold steady (${state.lines.length + 1} of ${state.total})`;
    case "nothing":
      return NOTHING;
    case "proposal":
    case "unsupported":
    case "failed":
      return null;
  }
}

/**
 * §6.2 (S5 layer 2): the capture mode at `/#/v/:vin/paint`, entered from the Sheet.
 *
 * It pre-fills nothing. Every route off this screen goes through a person: a tap on a
 * control with the characters inside it, or the typed field, which is empty because a
 * field pre-filled with the engine's guess and a Save button beside it is auto-accept with
 * extra steps (§5, N2).
 */
export default function PaintCaptureScreen() {
  const params = useParams<{ vin: string }>();
  const navigate = useNavigate();
  const vin = asciiUpper((params.vin ?? "").trim());
  const capture = usePaintCapture();
  const [typed, setTyped] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const { state, cameraFailed, cameraReady, cropUrl, videoRef, previewRef, boxRef, read } =
    capture;
  const blocked = state.kind === "unsupported" || cameraFailed;
  // §6.3's rule, applied to this screen: the status line never says something the banner
  // below it contradicts. "Starting camera…" over "The camera didn't start here" is the
  // screen arguing with itself, and the one the user acts on is the one they read first.
  const status = blocked ? null : statusOf(state, cameraReady);
  // The preview is dropped once there is something to decide, so the decision is above the
  // fold on a 320-wide phone rather than under 470 px of dead video (F7, F11).
  const aiming = !blocked && state.kind !== "proposal";

  async function save(code: string) {
    if (saving) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      // §5.3: the one path that may replace a stored paint code, because everything it
      // carries was confirmed by a person on this screen (D11, §4.12's LWW clock).
      await setVehicleMeta(vin, { paint: code });
      void navigate(`/v/${vin}`);
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 pb-10">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold text-fg">Paint code</h1>
        <VinDisplay vin={vin} size="md" className="break-all" />
      </div>

      {state.kind === "unsupported" ? (
        <Banner tone="warn" title={failureText(state.reason)} />
      ) : null}
      {cameraFailed && state.kind !== "unsupported" ? (
        <Banner tone="warn" title={CAMERA_FAILED} />
      ) : null}
      {state.kind === "failed" ? <Banner tone="warn" title={failureText(state.reason)} /> : null}

      {/* Mounted whenever the camera is the thing on screen. `hidden` rather than
          unmounted, so the refs the crop is measured against survive a re-read. */}
      <div className={aiming ? "flex flex-col gap-3" : "hidden"}>
        <div
          ref={previewRef}
          className="relative w-full overflow-hidden rounded-[var(--radius)] border border-border bg-black"
        >
          <div className="aspect-[4/3] w-full">
            <video
              ref={videoRef}
              muted
              autoPlay
              playsInline
              aria-hidden="true"
              className="h-full w-full object-cover"
            />
          </div>
          {/*
           * The crop box. A generous single *line* so a gloved hand can put it on one, and
           * emphatically not §6.1's ~90% x 22% barcode guide — [SB-3] measured a band of
           * that shape taking data_matrix from 100% clean to 0%. Different target.
           *
           * The height is a fraction of the preview *floored at `--tap`*, because on a
           * short landscape window the fraction alone is a line nobody can aim with. The
           * crop is measured off this element's rendered box, so the floor is honoured by
           * the pixels the engine reads and not only by the ones on screen.
           *
           * Inert: `pointer-events-none`, no gesture of any kind. N5 bans long-press,
           * swipe and pinch, and there is nothing here to drag.
           */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <div
              ref={boxRef}
              data-testid="paint-crop-box"
              className="rounded-[var(--radius)] border-2 border-white shadow-[inset_0_0_0_2px_#000,0_0_0_100vmax_rgba(0,0,0,0.55)]"
              style={{
                width: `${PAINT_CROP_BOX.width * 100}%`,
                height: `${PAINT_CROP_BOX.height * 100}%`,
                minHeight: "var(--tap)",
              }}
            />
          </div>
        </div>
      </div>

      {status === null ? null : (
        <p role="status" aria-live="polite" className="text-lg leading-snug font-bold text-fg">
          {status}
        </p>
      )}

      {state.kind === "offer" && !blocked ? (
        <p className="text-base leading-snug text-fg-muted">{WHERE}</p>
      ) : null}
      {state.kind === "nothing" ? (
        <p className="text-base leading-snug text-fg-muted">{NOTHING_HELP}</p>
      ) : null}

      {state.kind === "proposal" ? (
        <Proposal
          proposal={state.proposal}
          cropUrl={cropUrl}
          saving={saving}
          onSave={(code) => void save(code)}
        />
      ) : null}

      {saveFailed ? (
        <Banner tone="danger" title={SAVE_FAILED_TITLE}>
          {SAVE_FAILED}
        </Banner>
      ) : null}

      {blocked || state.kind === "downloading" || state.kind === "reading" ? null : (
        <Button
          variant={state.kind === "proposal" ? "secondary" : "primary"}
          full
          style={TAP_LG_TARGET}
          disabled={!cameraReady}
          onClick={read}
        >
          {state.kind === "offer" ? READ : READ_AGAIN}
        </Button>
      )}

      {state.kind === "offer" && !blocked ? (
        <p className="text-base leading-snug text-fg-muted">{firstUse()}</p>
      ) : null}

      {/*
       * The escape, present in every state (§5: "A typed field is always present"), and
       * deliberately **empty** — a field pre-filled with what the engine guessed, with a
       * Save button beside it, is auto-accept with extra steps. It is also the whole route
       * on a device that cannot run the engine at all, which iOS Lockdown Mode makes a real
       * one, so it takes the primary weight there (§6.4's rule for a notice with no retry).
       */}
      <div className="flex flex-col gap-2">
        <label htmlFor="paint-typed" className="text-sm font-bold tracking-wide text-fg-muted uppercase">
          {TYPE_LABEL}
        </label>
        <input
          id="paint-typed"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          className="min-h-[var(--tap)] w-full rounded-[var(--radius)] border border-border bg-bg-elev px-4 py-3 font-vin text-base text-fg"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
        />
        <Button
          variant={blocked ? "primary" : "secondary"}
          full
          style={TAP_LG_TARGET}
          disabled={typed.trim() === "" || saving}
          onClick={() => void save(typed)}
        >
          {TYPE_SAVE}
        </Button>
      </div>

      <Button variant="ghost" full onClick={() => void navigate(`/v/${vin}`)}>
        {BACK}
      </Button>
    </div>
  );
}
