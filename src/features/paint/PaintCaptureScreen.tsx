import { useState } from "react";
import type { CSSProperties } from "react";
import { useNavigate, useParams } from "react-router";
import { OCR_TOTAL_BYTES } from "../../lib/ocr/assets.generated";
import { confusionSet, hasAlternatives, replaceAt } from "../../lib/ocr/confusion";
import { PAINT_CROP_BOX } from "../../lib/ocr/cropBox";
import type { PaintCaptureState } from "../../lib/ocr/session";
import { isLowConfidence, type PaintProposal } from "../../lib/ocr/vote";
import { setVehicleMeta } from "../../lib/storage/upsert";
import type { PaintSource } from "../../lib/vin/types";
import { asciiUpper } from "../../lib/vin/grammar";
import { Banner } from "../../ui/Banner";
import { Button, TAP_LG_TARGET } from "../../ui/Button";
import { VIN_TEXT_SIZES, VinDisplay } from "../../ui/VinDisplay";
import { failureText } from "./failureText";
import { LOW_HELP, nextEdit, proposalView } from "./proposalView";
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

const CROP_CAPTION = "The last frame it read:";
const MARKED = "Check the marked characters.";
const FIX_HEADING = "Fix a character";
const FIX_HINT = "Tap a character to swap it for the one it looks like.";
const NOTHING = "Nothing readable in the box.";
const NOTHING_HELP = "Line the box up with the code, get closer, or type it below.";
const TYPE_LABEL = "Or type the paint code";
const TYPE_SAVE = "Save what I typed";
const BACK = "Back to the vehicle";
const SAVE_FAILED_TITLE = "Could not save";
/**
 * §6.4's Sheet line — "What you typed is still in the boxes above. Tap Save to try again."
 * — is not true of this screen, and was shipped here anyway. The banner sits above the
 * typed field, so "above" points the wrong way; a candidate save leaves that field empty
 * and the characters inside a button; and no control here is called Save — they read
 * "Save WA8555" and "Save what I typed". What holds on both routes is that the write did
 * not land and that what the user was saving is still in front of them.
 */
const SAVE_FAILED = "Nothing was saved. The code is still on this screen — try again.";
const CAMERA_FAILED = "The camera didn't start here. You can still type the code.";

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
 * A ≥56 px square-ish target for one character (§6.1), and no horizontal padding.
 *
 * Inline rather than a class for the same reason `TAP_LG_TARGET` is: `Button`'s own `px-6`
 * and a `px-*` in `className` land on the same element at the same specificity, and which
 * one wins is Tailwind's emission order, not the order they are written (F4). Six of these
 * have to fit a 320-wide phone, so the padding has to actually go.
 */
const CHAR_TARGET: CSSProperties = {
  ...TAP_LG_TARGET,
  minWidth: "var(--tap-lg)",
  paddingLeft: 0,
  paddingRight: 0,
};

/**
 * §5's correction: "a row of per-character ≥56 px buttons — tap a character, get its
 * confusion set. No caret, no long-press (§6.1)."
 *
 * The set rendered includes the character that is already there, so the first tap is
 * reversible without a second control: tap `8`, tap `8` again, and the read is back exactly
 * as the engine returned it. `aria-pressed` says which one that is — state, not a
 * preselection. §5's "nothing preselected" is about the controls that *save*, and nothing
 * here saves anything.
 *
 * A character the table has no lookalike for is disabled rather than absent: a gap in the
 * row would read as a character that cannot be wrong, which is the opposite of true. The
 * typed field below is the route for those, and it is on screen in every state.
 */
function CorrectionRow({
  text,
  marked,
  onPick,
}: {
  text: string;
  marked: readonly number[];
  onPick: (next: string) => void;
}) {
  const [openAt, setOpenAt] = useState<number | null>(null);

  return (
    <section className="flex flex-col gap-3" aria-labelledby="paint-fix-heading">
      <h3 id="paint-fix-heading" className="text-lg leading-snug font-bold text-fg">
        {FIX_HEADING}
      </h3>
      <p className="text-base leading-snug text-fg-muted">{FIX_HINT}</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label={text}>
        {[...text].map((character, index) => (
          <Button
            key={index}
            data-testid="paint-char"
            variant={openAt === index ? "primary" : "secondary"}
            style={CHAR_TARGET}
            disabled={!hasAlternatives(character)}
            aria-expanded={openAt === index}
            aria-label={`Character ${index + 1}, ${character}`}
            onClick={() => setOpenAt(openAt === index ? null : index)}
          >
            <CodeInControl text={character} marked={marked.includes(index) ? [0] : []} />
          </Button>
        ))}
      </div>
      {openAt === null ? null : (
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label={`Character ${openAt + 1}`}
        >
          {confusionSet(text[openAt]).map((option) => (
            <Button
              key={option}
              data-testid="paint-swap"
              variant="secondary"
              style={CHAR_TARGET}
              aria-pressed={option === text[openAt]}
              aria-label={`Character ${openAt + 1} is ${option}`}
              onClick={() => {
                onPick(replaceAt(text, openAt, option));
                setOpenAt(null);
              }}
            >
              <CodeInControl text={option} marked={[]} />
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The proposal, and every way it refuses to be rubber-stamped.
 *
 * One candidate gets the primary with the value inside it. Two or three get equal-weight
 * ≥56 px buttons with **nothing preselected** and the differing characters marked (§5):
 * when the vote is split, styling one of them as the answer is a guess wearing the clothes
 * of a decision, and N2 says nothing downstream can catch that.
 *
 * Which strings those are, what the heading may truthfully say about them, what is marked
 * and what each one would store as provenance are all `proposalView.ts` — pure, and unit
 * tested, because a rule inside a React file is only reachable from Playwright in this repo
 * and a browser test measures whatever it happens to have rendered. This function renders
 * that decision and holds the one piece of state behind it.
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
  onSave: (code: string, provenance: { source: PaintSource; confidence: number | null }) => void;
}) {
  const [edited, setEdited] = useState<string | null>(null);
  const view = proposalView(proposal, edited);

  return (
    <section className="flex flex-col gap-4" aria-labelledby="proposal-heading">
      <h2 id="proposal-heading" className="text-lg leading-snug font-bold text-fg">
        {view.heading}
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
        {view.controls.map((control) => (
          <Button
            key={control.text}
            data-testid="paint-candidate"
            // Equal weight, on purpose: `secondary` for every one of them when there are
            // several, so none of them is dressed as the answer.
            variant={view.several ? "secondary" : "primary"}
            full
            style={TAP_LG_TARGET}
            disabled={saving}
            onClick={() =>
              onSave(control.text, { source: control.source, confidence: control.confidence })
            }
          >
            Save <CodeInControl text={control.text} marked={view.marks} />
          </Button>
        ))}
      </div>

      {view.showMarkedNote ? <p className="text-base leading-snug text-warn">{MARKED}</p> : null}
      {isLowConfidence(proposal) ? (
        <p className="text-base leading-snug text-fg-muted">{LOW_HELP}</p>
      ) : null}

      {/* The row edits the winner — the string in the control the user is likeliest to
          tap — or whatever they have already built from it. Its marks are the read's own
          doubts, never the candidate row's differing positions: two unrelated tokens off
          the same line differ everywhere, and a row with every character underlined marks
          nothing (§5). */}
      <CorrectionRow
        text={view.working}
        marked={view.workingMarks}
        onPick={(picked) => setEdited(nextEdit(proposal.text, picked))}
      />
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

  /**
   * S5 addendum §5: "Persist `source: \"ocr\"` and the confidence so nothing downstream
   * mistakes it for a decoded fact."
   *
   * `"ocr"` is reserved for a string the engine actually returned. A lookalike picked off
   * the confusion table and a character swapped in the correction row are strings no frame
   * ever produced — a person read the glyph on the sticker and chose them — so they are
   * stored exactly as the typed field is, and with no confidence, because there is no read
   * for a confidence to be about (N2).
   */
  async function save(code: string, provenance: { source: PaintSource; confidence: number | null }) {
    if (saving) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      // §5.3: the one path that may replace a stored paint code, because everything it
      // carries was confirmed by a person on this screen (D11, §4.12's LWW clock).
      await setVehicleMeta(vin, {
        paint: code,
        paintSource: provenance.source,
        paintConfidence: provenance.confidence,
      });
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
          onSave={(code, provenance) => void save(code, provenance)}
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
          onClick={() => void save(typed, { source: "typed", confidence: null })}
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
