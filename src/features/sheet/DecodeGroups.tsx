/**
 * §4.8 vPIC groups. Every label, key and join rule lives in `src/lib/vpic/fields.ts`;
 * this file renders whatever that map returns and knows no vPIC key of its own, so a
 * §4.8 correction is a one-file change (§9-S2).
 */
import type { FieldRow, RenderedGroup } from "../../lib/vpic/fields";
import { allFieldRows, noticeLines, renderGroups } from "../../lib/vpic/fields";

export interface DecodeGroupsProps {
  /** `VehicleDecode.fields`: `Results[0]` with the empty values already dropped (§4.7). */
  fields: Record<string, string>;
  /** Notice lines the sheet already states in its own banner, so they are not printed twice. */
  skipNotices?: readonly string[];
  className?: string;
}

const LABEL = "text-sm font-bold tracking-wide text-fg-muted uppercase";

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function Rows({ rows }: { rows: readonly FieldRow[] }) {
  return (
    <dl className="mt-1">
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border py-3 last:border-b-0"
        >
          <dt className={LABEL}>{row.label}</dt>
          {/* The value is what the user came for, so it carries the weight, not the label. */}
          <dd className="text-right text-lg leading-snug font-semibold text-fg">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Group({ group }: { group: RenderedGroup }) {
  const headingId = `decode-group-${slugify(group.title)}`;
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className={LABEL}>
        {group.title}
      </h3>
      <Rows rows={group.rows} />
    </section>
  );
}

/**
 * §4.8 "All fields": everything vPIC returned, sorted by key, collapsed. A native
 * details/summary needs no JavaScript and no long-press or swipe (N5), and these are raw
 * API strings, so they are shown in the VIN monospace rather than dressed up as facts.
 */
function AllFields({ rows }: { rows: readonly FieldRow[] }) {
  if (rows.length === 0) return null;
  return (
    <details className="rounded-[var(--radius)] border border-border bg-bg-elev">
      <summary className="flex min-h-[var(--tap)] cursor-pointer items-center px-4 text-base font-bold text-fg">
        All fields
      </summary>
      <dl className="border-t border-border px-4">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex flex-wrap justify-between gap-x-4 gap-y-1 border-b border-border py-2 last:border-b-0"
          >
            <dt className="font-vin text-sm text-fg-muted">{row.label}</dt>
            <dd className="font-vin text-sm break-all text-fg">{row.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** The decoded vehicle: notice area, then the §4.8 groups, then the raw record. */
export function DecodeGroups({ fields, skipNotices = [], className }: DecodeGroupsProps) {
  const groups = renderGroups(fields);
  const notices = noticeLines(fields).filter((line) => !skipNotices.includes(line));
  const raw = allFieldRows(fields);
  // N2: nothing to say means nothing on screen — no empty heading, no placeholder.
  if (groups.length === 0 && notices.length === 0 && raw.length === 0) return null;

  const classes = ["flex flex-col gap-6", className].filter(Boolean).join(" ");
  return (
    <div className={classes}>
      {notices.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-border border-l-4 border-l-accent bg-bg-elev p-4">
          {notices.map((line) => (
            <p key={line} className="text-base leading-snug text-fg">
              {line}
            </p>
          ))}
        </div>
      ) : null}

      {groups.map((group) => (
        <Group key={group.title} group={group} />
      ))}

      <AllFields rows={raw} />
    </div>
  );
}
