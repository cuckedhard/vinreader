import { useId, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { checkDigitApplies, isCheckDigitValid } from "../../lib/vin/checkDigit";
import { extractVin } from "../../lib/vin/extractVin";
import { asciiUpper, isAllowedVinChar, VIN_LENGTH } from "../../lib/vin/grammar";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { VinDisplay } from "../../ui/VinDisplay";
import { useVinCommit } from "./useVinCommit";

/**
 * D15: the field has no `maxlength`, so the value may be the 18-character `I`-prefixed
 * label form or the 22-character grouped form. §4.2 drops the separators, so the raw
 * length says nothing about whether there is enough typed to hold a VIN — count only
 * the §4.1 characters.
 */
function vinCharCount(value: string): number {
  let count = 0;
  for (const c of value) {
    if (isAllowedVinChar(c)) count += 1;
  }
  return count;
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

  const candidate = useMemo(() => extractVin(value), [value]);
  // N1: everything the user is shown comes from the extracted candidate, never the raw text.
  const checkValid = candidate !== null && isCheckDigitValid(candidate.vin);
  const checkApplies = candidate !== null && checkDigitApplies(candidate.vin);
  const enoughTyped = vinCharCount(value) >= VIN_LENGTH;

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
        ) : enoughTyped ? (
          <div className="rounded-[var(--radius)] border border-border bg-bg-elev p-4">
            <p className="text-lg leading-tight font-bold text-fg">Not a VIN yet</p>
            <p className="mt-1 text-base leading-snug text-fg-muted">
              A VIN is 17 characters and never uses I, O or Q. Keep typing, or check for a mistyped
              character.
            </p>
          </div>
        ) : null}
      </div>

      {error !== null ? (
        <Banner tone="danger" title="Couldn't save this VIN">
          <p>Nothing was written. Your entry is still here — try again.</p>
          <p className="mt-2 font-vin text-sm break-words text-fg-muted">{error}</p>
        </Banner>
      ) : null}

      {pending !== null ? (
        <Banner
          tone="warn"
          title="Check digit doesn't match."
          actions={
            <>
              {/* h-14 pins the §6.1 56 px target: the Banner action row sets its children
                  to a 48 px minimum, which would otherwise win over the Button's own. */}
              <Button variant="primary" className="h-14" onClick={handleEdit} disabled={saving}>
                Edit
              </Button>
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
