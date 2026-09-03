import type { ReactNode } from "react";
import { checkDigitApplies } from "../../lib/vin/checkDigit";
import type { ModelYear, VinStructural } from "../../lib/vin/types";
import { Chip } from "../../ui/Chip";

export interface StructuralBlockProps {
  vin: string;
  structural: VinStructural;
  className?: string;
}

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
        <span className="block text-sm font-normal text-fg-muted">
          will confirm when details load
        </span>
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
        <Chip tone="ok">Check digit ok</Chip>
      ) : checkDigitApplies(vin) ? (
        <Chip tone="warn">Check digit doesn't match</Chip>
      ) : (
        <Chip tone="neutral">This number doesn't use a check digit</Chip>
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
