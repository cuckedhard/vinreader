/**
 * Every string the Sheet's copy buttons write, built from a record already in memory.
 *
 * §6.5 and §11 are the reason this is a module of its own: `navigator.clipboard.writeText`
 * has to run **synchronously inside the tap handler**, so nothing a copy button writes may
 * be fetched, read from Dexie, or dynamically imported at tap time. A pure, synchronous
 * builder is that rule expressed as a type — there is no `await` here to add, and `origin`
 * arrives as an argument rather than being read off `window`, so the whole surface is
 * checkable in vitest's node environment where no `window` exists at all.
 *
 * §6.5 "Row" is *"one tab-separated line in the S3 CSV column order"*, and §7 item 5 says
 * that order lives in one place. It does: `CSV_COLUMNS` and the cell derivations in
 * `src/lib/payload/exportBundle.ts`. `toTsvRow` is the existing reuse of them — History's
 * wide layout writes the same line from its own per-row copy button — so the Sheet asks it
 * rather than restating seventeen columns and the vPIC keys behind them. Two lists would
 * drift the day a column moves, and nothing anywhere would fail.
 */
import { buildPayloadUrl, buildTextCarrier, payloadFromRecord } from "../../lib/payload/codec";
import { shareText } from "../../lib/payload/shareText";
import { toTsvRow } from "../history/rows";
import type { VehicleRecord } from "../../lib/vin/types";

export interface CopyTexts {
  /** §6.5: 17 characters, no spaces — pasteable into any lookup form. */
  vin: string;
  /** §4.9's share text. */
  summary: string;
  /** §4.9's `VINRELAY1:` carrier, which another VIN Relay imports from a message. */
  link: string;
  /** The `VehicleRecord`, pretty-printed. */
  json: string;
  /** §6.5 "Row": one tab-separated line in the §9-S3 CSV column order, no header. */
  row: string;
  /** §4.9's URL carrier, for the QR view. */
  url: string;
  /** §4.9 keys dropped to keep the URL under the 700-byte cap. */
  dropped: string[];
}

export function buildCopyTexts(
  record: VehicleRecord,
  deviceLabel: string | null,
  origin: string,
): CopyTexts {
  const payload = payloadFromRecord(record, deviceLabel);
  return {
    vin: record.vin,
    summary: shareText(record),
    // §6.5 calls this "Link" while §4.9 gives links to the URL carrier: the button keeps
    // the §6.5 name and the §4.9 text-prefix behaviour, which is what another VIN Relay
    // imports from a message.
    link: buildTextCarrier(payload),
    json: JSON.stringify(record, null, 2),
    row: toTsvRow(record),
    // The URL carrier points back at whatever deployment is on screen (§4.9); the
    // fragment carries the payload, so it never reaches that host's server.
    ...buildPayloadUrl(payload, origin),
  };
}
