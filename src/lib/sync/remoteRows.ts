/**
 * Pulled rows → the client's own shapes (§4.12, §5.1, §5.2).
 *
 * Everything PostgREST hands back is `unknown` as far as this file is concerned. The rows
 * belong to the user's own account and RLS keeps anyone else's out, but they were written
 * by *some* build of this app — an older one, a newer one, or one running on a phone whose
 * clock or schema is not this one's — so a row that cannot be read is dropped rather than
 * coerced. P7: one unreadable row costs that row, never the pull.
 *
 * Pure: no Dexie, no client, no clock.
 */
import { isVinGrammarValid } from "../vin/grammar";
import { pendingDecode } from "../storage/upsert";
import type { DecodeStatus, ScanEvent, Symbology, VehicleDecode } from "../vin/types";
import type { RemoteScanEvent, RemoteVehicle } from "./types";

/**
 * §4.10's two closed value sets, as runtime tables. They are typed `Record<T, true>` rather
 * than written as arrays so that adding or removing a member of `Symbology` or
 * `DecodeStatus` fails to compile here: the list cannot drift from the enum it validates,
 * which is what §7 item 5 is protecting against — the type in `vin/types.ts` stays the
 * single definition, and this is the compiler's copy of it.
 */
const SYMBOLOGIES: Record<Symbology, true> = {
  code_39: true,
  code_128: true,
  data_matrix: true,
  qr_code: true,
  manual: true,
  import: true,
};

const DECODE_STATUSES: Record<DecodeStatus, true> = {
  pending: true,
  ok: true,
  partial: true,
  unsupported: true,
  failed: true,
};

function has(table: Record<string, true>, value: unknown): boolean {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(table, value);
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A timestamptz as PostgREST sent it. Anything that will not parse is not one. */
function timestamp(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * §4.12's `decode` jsonb → §5.1's block, or null when the server has nothing usable.
 *
 * Null covers both `'{}'::jsonb` (the default a row gets from `apply_scan_event`) and a
 * status outside §4.10. Both are worth exactly the same to the merge: `decode_rank` scores
 * an unrecognised status 0, the rank `pending` and `failed` already carry, so a block that
 * cannot be read can never displace one that can.
 */
export function parseRemoteDecode(value: unknown): VehicleDecode | null {
  const raw = record(value);
  if (raw === null || !has(DECODE_STATUSES, raw.status)) return null;

  const fields: Record<string, string> = {};
  const rawFields = record(raw.fields);
  if (rawFields !== null) {
    for (const [key, field] of Object.entries(rawFields)) {
      // §4.7: every vPIC field is a string and an empty one means unknown (N2).
      if (typeof field === "string" && field !== "") fields[key] = field;
    }
  }

  const attempts = raw.attempts;
  return {
    ...pendingDecode(),
    status: raw.status as DecodeStatus,
    fetchedAt: timestamp(raw.fetchedAt),
    attempts:
      typeof attempts === "number" && Number.isInteger(attempts) && attempts >= 0 ? attempts : 0,
    lastError: text(raw.lastError),
    fields,
  };
}

/**
 * One `public.vehicles` row. Null when the row has no grammar-valid VIN (§4.1 — the same
 * refusal `normalizeVehicle` makes on the read path) or no `meta_updated_at`/`updated_at`:
 * the first is the key every merge rule is written against, the second is the LWW clock,
 * and the third is the §5.8 cursor. A row missing any of them cannot be merged or paged.
 */
export function parseRemoteVehicle(row: Record<string, unknown>): RemoteVehicle | null {
  const vin = text(row.vin);
  const metaUpdatedAt = timestamp(row.meta_updated_at);
  const updatedAt = timestamp(row.updated_at);
  if (vin === null || !isVinGrammarValid(vin) || metaUpdatedAt === null || updatedAt === null) {
    return null;
  }

  const scanCount = row.scan_count;
  return {
    vin,
    unit: text(row.unit),
    notes: text(row.notes),
    paint: text(row.paint),
    metaUpdatedAt,
    // Emptiness is the only thing §4.12 merges `structural` by; see `RemoteVehicle`.
    structural: (() => {
      const parsed = record(row.structural);
      return parsed === null || Object.keys(parsed).length === 0 ? null : parsed;
    })(),
    decode: parseRemoteDecode(row.decode),
    firstScannedAt: timestamp(row.first_scanned_at),
    lastScannedAt: timestamp(row.last_scanned_at),
    scanCount:
      typeof scanCount === "number" && Number.isInteger(scanCount) && scanCount >= 0
        ? scanCount
        : 0,
    deletedAt: timestamp(row.deleted_at),
    updatedAt,
  };
}

/**
 * One `public.scan_events` row. Null when the id, VIN, `at`, `inserted_at` or symbology is
 * unusable — a symbology outside §4.10 comes from a build this one does not know, and
 * coercing it to a value from the enum would put an invented fact in an append-only log
 * (N2). The row stays in the account; this device simply does not claim to know it.
 */
export function parseRemoteScanEvent(row: Record<string, unknown>): RemoteScanEvent | null {
  const id = text(row.id);
  const vin = text(row.vin);
  const at = timestamp(row.at);
  const insertedAt = timestamp(row.inserted_at);
  const origin = text(row.origin);
  if (id === null || vin === null || !isVinGrammarValid(vin) || at === null) return null;
  if (insertedAt === null || origin === null || !has(SYMBOLOGIES, row.symbology)) return null;

  return {
    id,
    vin,
    at,
    symbology: row.symbology as Symbology,
    // `not null` in §4.12, so anything else is a row this build cannot read.
    checkDigitValid: row.check_digit_valid === true,
    deviceLabel: text(row.device_label),
    origin,
    insertedAt,
  };
}

/**
 * A pulled event as a §5.2 row.
 *
 * `raw` is empty because §4.12 has no column for it and N3 keeps it on the device that
 * scanned: what came back from the account is the event, not the bytes the camera read.
 * That is also why the apply path never overwrites an event the local log already holds —
 * the local copy is the only one that carries the raw read.
 */
export function toLocalScanEvent(event: RemoteScanEvent): ScanEvent {
  return {
    id: event.id,
    vin: event.vin,
    at: event.at,
    symbology: event.symbology as Symbology,
    raw: "",
    checkDigitValid: event.checkDigitValid,
    deviceLabel: event.deviceLabel,
  };
}
