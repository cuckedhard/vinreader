import { useId, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { RefusedRead } from "../../app/RefusedRead";
import { NOT_A_VIN } from "../../app/refusalText";
import { NOTHING_WRITTEN, WRITE_FAILED_TITLE } from "../../app/strings";
import { checkDigitApplies, isCheckDigitValid } from "../../lib/vin/checkDigit";
import { extractVinExplained, normalizeForExtract } from "../../lib/vin/extractVin";
import { asciiUpper, VIN_LENGTH } from "../../lib/vin/grammar";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { VinDisplay } from "../../ui/VinDisplay";
import { useVinCommit } from "./useVinCommit";

/**
 * Whether there is enough in the field to say anything about it.
 *
 * D15: the field has no `maxlength`, so the value may be the 18-character `I`-prefixed
 * label form or the 22-character grouped form, and its raw length says nothing. What is
 * counted is what survives §4.2 step 1 — everything the user supplied, minus the
 * whitespace and `*` §4.2 itself throws away — so a grouped VIN still says nothing until
 * seventeen characters are in.
 *
 * It counted §4.1 characters until FR-2, and that is what kept the report's part number
 * off the screen: `R25-1251-200622120` is eighteen characters, sixteen of them §4.1, so a
 * paste of the whole thing was read as a half-typed VIN and answered with silence. Every
 * value that used to reach this reaches it still — a §4.1 character survives step 1 — and
 * a hyphen, a slash or a mistyped `O` now counts as the character it is.
 */
function isEnoughSupplied(value: string): boolean {
  return normalizeForExtract(value).length >= VIN_LENGTH;
}

/**
 * The manual path into the app. The write itself belongs to `useVinCommit`, which the
 * scanner shares, so the typed and scanned paths run the same §4.3 gate and §5.3 upsert.
 */
export function ManualEntry() {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  // `useAsIs` is renamed on the way out: it is a plain method, and the hooks lint reads any
  // `use…()` call inside a callback as a misplaced hook.
  const { pending, saving, error, request, useAsIs: saveAsIs, dismiss } = useVinCommit();

  // §4.2, with the branch that refused carried out with it (FR-1): the answer is the same
  // answer `extractVin` gave, and the refusal is what this screen could not say before.
  const outcome = useMemo(() => extractVinExplained(value), [value]);
  const candidate = outcome.ok ? outcome.result : null;
  const refusal = outcome.ok ? null : outcome.refusal;
  // N1: everything the user is shown comes from the extracted candidate, never the raw text.
  const checkValid = candidate !== null && isCheckDigitValid(candidate.vin);
  const checkApplies = candidate !== null && checkDigitApplies(candidate.vin);
  const enoughTyped = isEnoughSupplied(value);

  function handleChange(next: string) {
    // Uppercase at the source, so the stored `raw` is what the user was shown (§5.2).
    // §4.2 step 1, ASCII-only: `String.prototype.toUpperCase` would grow the pasted
    // `1HGCM82633A00435ﬁ` — 17 characters — into the 18-character `1HGCM82633A00435FI`.
    setValue(asciiUpper(next));
    // Editing withdraws both the held read and any failed write: neither describes the
    // text now in the field.
    dismiss();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (candidate === null || saving) return;
    // D03 lives in the hook: a mismatch that means something lands in `pending` and the
    // banner below gates the write.
    void request(candidate, { origin: "manual", symbology: "manual" });
  }

  function handleEdit() {
    dismiss();
    inputRef.current?.focus();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <label htmlFor={inputId} className="text-base font-bold text-fg-muted">
          VIN
        </label>
        <input
          id={inputId}
          ref={inputRef}
          value={value}
          onChange={(event) => handleChange(event.target.value)}
          type="text"
          inputMode="text"
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="done"
          placeholder="17 characters"
          aria-describedby={`${inputId}-feedback`}
          className={
            "min-h-[var(--tap-lg)] w-full rounded-[var(--radius)] border border-border " +
            "bg-bg-elev px-4 py-3 font-vin text-xl tracking-[0.08em] text-fg uppercase " +
            "placeholder:font-sans placeholder:tracking-normal placeholder:normal-case placeholder:text-fg-muted"
          }
        />
      </div>

      <div id={`${inputId}-feedback`} aria-live="polite">
        {candidate !== null ? (
          <div className="rounded-[var(--radius)] border border-border bg-bg-elev p-4">
            <VinDisplay vin={candidate.vin} className="block break-words" />
            <div className="mt-3">
              {checkValid ? (
                <Chip tone="ok">Check digit OK</Chip>
              ) : checkApplies ? (
                <Chip tone="warn">Check digit doesn't match</Chip>
              ) : (
                // D17: no check digit exists here, so nothing is wrong and nothing warns.
                // The Chip keeps its text on one line; this sentence has to wrap on a
                // narrow phone, and white-space set on the child wins by inheritance.
                <Chip tone="neutral">
                  <span className="whitespace-normal">This number doesn't use a check digit.</span>
                </Chip>
              )}
            </div>
          </div>
        ) : enoughTyped && refusal !== null ? (
          <div className="rounded-[var(--radius)] border border-border bg-bg-elev p-4">
            <p className="text-lg leading-tight font-bold text-fg">{NOT_A_VIN}</p>
            {/* FR-2: what was read and why §4.2 refused it, above §6.4's rule and remedy —
                pasting the report's part number in here used to leave this panel empty and
                the field user with nothing to go on. The two say different things: the
                sentence below is what a VIN is, the lines above are what this text was. */}
            <div className="mt-2">
              <RefusedRead refusal={refusal} />
            </div>
            <p className="mt-2 text-base leading-snug text-fg-muted">
              A VIN is 17 characters and never uses I, O or Q. Keep typing, or check for a mistyped
              character.
            </p>
          </div>
        ) : null}
      </div>

      {error !== null ? (
        <Banner tone="danger" title={WRITE_FAILED_TITLE}>
          <p>{`${NOTHING_WRITTEN} Your entry is still here — try again.`}</p>
          <p className="mt-2 font-vin text-sm break-words text-fg-muted">{error}</p>
        </Banner>
      ) : null}

      {pending !== null ? (
        <Banner
          tone="warn"
          title="Check digit doesn't match."
          actions={
            <>
              <Button variant="primary" onClick={handleEdit} disabled={saving}>
                Edit
              </Button>
              {/* §6.1 names Use as-is in the ≥ 56 px list, and this is a secondary — so the
                  pin says something the variant does not, and stays. */}
              <Button
                variant="secondary"
                className="h-14"
                onClick={() => void saveAsIs()}
                disabled={saving}
              >
                Use as-is
              </Button>
            </>
          }
        >
          Usually a misread — try again.
        </Banner>
      ) : (
        <Button type="submit" full disabled={candidate === null || saving}>
          {saving ? "Saving…" : "Save VIN"}
        </Button>
      )}
    </form>
  );
}
