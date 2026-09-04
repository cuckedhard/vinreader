import type { ReactNode } from "react";
import { checkDigitApplies } from "../../lib/vin/checkDigit";
import type { ModelYear, VinStructural } from "../../lib/vin/types";
import { Chip } from "../../ui/Chip";

export interface StructuralBlockProps {
  vin: string;
  structural: VinStructural;
  className?: string;
}

/**
 * §6.4 microcopy, verbatim, hoisted the way `SheetScreen` and `ImportScreen` hoist theirs —
 * R3-J's point: the two strings below are the ones that drifted, and a literal buried in JSX
 * is what let them drift. §6.4 is authoritative for both, punctuation included.
 *
 * The full stop is not decoration. §6.4 writes this line with one, `ManualEntry` renders it
 * with one, and the sheet — the one surface §6.4 actually names for it — dropped it (R3-I).
 */
const NO_CHECK_DIGIT = "This number doesn't use a check digit.";
const CHECK_DIGIT_OK = "Check digit ok";
const CHECK_DIGIT_MISMATCH = "Check digit doesn't match";

/**
 * §6.4's ambiguous-year line is *"1996 or 2026 — will confirm when details load"*: one
 * sentence, and the em dash is the thing joining its halves. Rendering the tail as a block
 * with no separator ran them together — `dd.textContent` read
 * `"1993 or 2023will confirm when details load"` (R3-F7) — so the dash travels with the
 * tail and the space in front of it is emitted by the caller. Two lines on screen, one
 * §6.4 sentence to anything that reads the text: a screen reader, a copy, a test.
 */
const YEAR_PENDING = "— will confirm when details load";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border py-3 last:border-b-0">
      <dt className="text-sm font-bold tracking-wide text-fg-muted uppercase">{label}</dt>
      <dd className="text-right text-lg leading-snug text-fg">{children}</dd>
    </div>
  );
}

/** N2: a row with nothing behind it is not rendered at all — never a dash, never "unknown". */
function TextRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  if (!value || !value.trim()) return null;
  return (
    <Row label={label}>
      <span className={mono ? "font-vin tracking-[0.06em]" : undefined}>{value}</span>
    </Row>
  );
}

/**
 * §4.4 / N2. One surviving candidate is stated; two are both shown and neither is
 * asserted; none — an invalid year code — drops the row entirely.
 */
function YearRow({ modelYear }: { modelYear: ModelYear }) {
  const { candidates, resolved } = modelYear;
  if (resolved !== null) return <Row label="Year">{resolved}</Row>;
  if (candidates.length === 0) return null;
  return (
    <Row label="Year">
      {candidates.join(" or ")}
      {candidates.length > 1 ? (
        <>
          {/* The separator §6.4 puts between the two halves. It renders at the head of the
              second line, where the leading space collapses; it survives in `textContent`,
              which is where it was missing. */}{" "}
          <span className="block text-sm font-normal text-fg-muted">{YEAR_PENDING}</span>
        </>
      ) : null}
    </Row>
  );
}

/**
 * §4.3 / D17. A mismatch is a warning only where a check digit is defined; where it is
 * not — many European-market vehicles, off-highway machine PINs — saying so plainly is
 * the honest answer, and nothing here is alarming.
 */
function CheckDigitRow({ vin, valid }: { vin: string; valid: boolean }) {
  return (
    <Row label="Check digit">
      {valid ? (
        <Chip tone="ok">{CHECK_DIGIT_OK}</Chip>
      ) : checkDigitApplies(vin) ? (
        <Chip tone="warn">{CHECK_DIGIT_MISMATCH}</Chip>
      ) : (
        // §6.1, measured: `Chip` keeps its text on one line — a status pill read at arm's
        // length in glare should — and at 320 px this sentence ran 326.20 px against a
        // 288 px row, hanging 22.20 px past the viewport in both themes. It cannot be
        // fixed from outside the pill: Tailwind emits `whitespace-nowrap` *after*
        // `whitespace-normal` in the same layer, so passing the latter through `className`
        // loses on source order however the class attribute is written (the R3-U-b trap,
        // and invisible to every test in the gate). `white-space` is inherited, so setting
        // it on the text's own element wins with no cascade race — the same fix, for the
        // same sentence, that `ManualEntry` already carries.
        <Chip tone="neutral">
          <span className="whitespace-normal">{NO_CHECK_DIGIT}</span>
        </Chip>
      )}
    </Row>
  );
}

/**
 * §5.1 structural fields. Derived from the 17 characters alone, so this block is
 * complete the instant a record exists and never waits on a network (N1).
 */
export function StructuralBlock({ vin, structural, className }: StructuralBlockProps) {
  return (
    <section className={className} aria-labelledby="structural-heading">
      <h2
        id="structural-heading"
        className="text-sm font-bold tracking-wide text-fg-muted uppercase"
      >
        From the VIN
      </h2>
      <dl className="mt-1">
        <YearRow modelYear={structural.modelYear} />
        <TextRow label="Region" value={structural.region} />
        <TextRow label="Country" value={structural.country} />
        <TextRow label="Manufacturer" value={structural.manufacturerFromWmi} />
        <TextRow label="WMI" value={structural.wmi} mono />
        <TextRow label="VDS" value={structural.vds} mono />
        <CheckDigitRow vin={vin} valid={structural.checkDigitValid} />
        <TextRow label="Plant code" value={structural.plantCode} mono />
        <TextRow label="Serial" value={structural.serial} mono />
      </dl>
    </section>
  );
}
