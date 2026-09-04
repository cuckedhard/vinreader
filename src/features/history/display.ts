/**
 * What History puts on screen about a record, derived once and read by both layouts — the
 * phone list and §6.6's table. Pure: no DOM, no React, no I/O, and the clock is an
 * argument, so the same record renders the same way in both places by construction rather
 * than by two functions agreeing.
 */
import type { DecodeStatus, VehicleRecord } from "../../lib/vin/types";
import type { ChipTone } from "../../ui/Chip";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface DecodeChip {
  tone: ChipTone;
  label: string;
}

/**
 * N6: every label says what is actually known, and only when it tells the user
 * something. `ok` gets no chip — the row already shows the year, make and model
 * that were fetched, so a badge on every healthy row is noise that buries the
 * three statuses worth reading. §4.10 fixes the members; none may be added.
 *
 * The same rule holds in §6.6's Status column, where `ok` leaves the cell empty. An empty
 * cell beside rows reading "Details pending" says the same thing the missing chip says in
 * the list, and a word invented for it ("OK", "Complete") would be a fifth status this app
 * does not have.
 */
const DECODE_CHIP: Record<DecodeStatus, DecodeChip | null> = {
  pending: { tone: "neutral", label: "Details pending" },
  ok: null,
  partial: { tone: "warn", label: "Some details" },
  // §4.7: an off-highway PIN vPIC cannot decode is a legitimate machine, not a
  // failure, so this stays neutral and never reads as an error.
  unsupported: { tone: "neutral", label: "No details published" },
  // The row is a link to the sheet, which is where Refresh details lives (§4.7).
  failed: { tone: "warn", label: "Details failed — tap to retry" },
};

/**
 * P7: a row whose `decode.status` is outside §4.10 — corrupt storage, or a row written by
 * a future schema — renders no chip instead of throwing and taking the whole route down
 * with it. The lookup is total to TypeScript, so only the runtime needs guarding; §4.10
 * itself is unchanged and no member is added.
 */
export function decodeChip(status: DecodeStatus): DecodeChip | null {
  return DECODE_CHIP[status] ?? null;
}

/** Case-insensitive, space-insensitive, so a VIN pasted in §4.1 display groups still matches. */
export function normalizeQuery(value: string): string {
  return value.toUpperCase().replace(/\s+/g, "");
}

/** A vPIC field that is actually populated. Empty strings mean "unknown" (§4.7). */
export function field(fields: Record<string, string>, key: string): string | null {
  const value = fields[key];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * §4.4 and N2, for a column of its own. vPIC's `ModelYear` when it answered, else the
 * structural year once resolved, else **both candidates** — "1996 or 2026", the §6.4 form
 * — because an unresolved year is two facts and neither may be printed alone.
 *
 * The list's `headline` drops the same year instead of showing it, and that is not a
 * disagreement: "1996 or 2026 HONDA Accord" on one line reads as a model year that spans
 * thirty years, while a Year column has room to say it.
 */
export function yearText(record: VehicleRecord): string | null {
  const decoded = field(record.decode.fields, "ModelYear");
  if (decoded !== null) return decoded;
  const { candidates, resolved } = record.structural.modelYear;
  if (resolved !== null) return String(resolved);
  return candidates.length === 0 ? null : candidates.join(" or ");
}

/**
 * What someone standing at the truck reads first: the decoded year, make and model.
 * The structural year carries the line until vPIC answers, and when neither exists
 * the line is dropped rather than filled with a placeholder (N2).
 */
export function headline(record: VehicleRecord): string | null {
  const { fields } = record.decode;
  const resolved = record.structural.modelYear.resolved;
  const year = field(fields, "ModelYear") ?? (resolved === null ? null : String(resolved));
  const parts = [year, field(fields, "Make"), field(fields, "Model")].filter(
    (part): part is string => part !== null,
  );
  return parts.length === 0 ? null : parts.join(" ");
}

/** VIN, unit, and — now that S2 fetches them — the vPIC make and model. */
export function matchesQuery(record: VehicleRecord, query: string): boolean {
  if (normalizeQuery(record.vin).includes(query)) return true;
  if (record.unit !== null && normalizeQuery(record.unit).includes(query)) return true;
  const { fields } = record.decode;
  return ["Make", "Model"].some((key) => {
    const value = field(fields, key);
    return value !== null && normalizeQuery(value).includes(query);
  });
}

export function formatScannedAt(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const ago = nowMs - at;
  if (ago < MINUTE) return "Just now";
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)} hr ago`;
  if (ago < 7 * DAY) return `${Math.floor(ago / DAY)} d ago`;
  const date = new Date(at);
  const options: Intl.DateTimeFormatOptions =
    date.getFullYear() === new Date(nowMs).getFullYear()
      ? { day: "numeric", month: "short" }
      : { day: "numeric", month: "short", year: "numeric" };
  return date.toLocaleDateString(undefined, options);
}
