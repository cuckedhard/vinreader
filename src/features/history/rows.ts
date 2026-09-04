/**
 * §6.5's tab-separated formats for History: the multi-select **TSV**, and the single
 * **Row** the wide layout's per-row copy button writes.
 *
 * Both are §9-S3's CSV in another delimiter, and §7 item 5 says a column order lives in
 * one place. It does — `CSV_COLUMNS` and the cell derivations in
 * `src/lib/payload/exportBundle.ts`, which exports `toCsv` and nothing narrower. So this
 * file asks that one function for the cells and re-joins them, rather than restating
 * seventeen columns and the vPIC keys behind them. Restating them is the failure this
 * avoids: the second list drifts from the first the day a column moves, the TSV and the
 * CSV disagree about what column 6 is, and nothing anywhere fails.
 *
 * Pure: no DOM, no React, no clock, no I/O. That is not decoration here — §6.5 requires
 * the clipboard write to happen inside the tap handler, so everything it writes has to be
 * computable synchronously, from records already in memory.
 */
import { toCsv } from "../../lib/payload/exportBundle";
import type { VehicleRecord } from "../../lib/vin/types";

/** Excel reads a pasted block by lines; CRLF is what it expects on every platform. */
const TSV_EOL = "\r\n";

/**
 * A tab, a CR or an LF inside a cell is the end of that cell or that row to every
 * spreadsheet that reads a pasted block, and TSV has no quoting to say otherwise. CSV
 * quotes such a field instead, so these characters do survive `toCsv` — a note typed with
 * line breaks is the ordinary case — and they are folded to a space here rather than
 * silently shifting every column to their right by one.
 */
const CELL_BREAKS = /[\t\r\n]+/g;

function tsvCell(value: string): string {
  return value.replace(CELL_BREAKS, " ");
}

/**
 * RFC 4180, only as much of it as `toCsv` can produce: quoted fields, doubled quotes
 * inside them, CRLF between records, and a trailing CRLF that ends the last record rather
 * than starting an empty one.
 */
function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    if (quoted) {
      if (char !== '"') {
        // Inside quotes every character is content, including the CR and LF that end a
        // record outside them.
        field += char;
      } else if (csv[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (char === '"') {
      // `csvField` only ever opens a quote at the start of a field.
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  // Anything after the last separator is a record too — a CSV that does not end in a
  // newline still has a final row. `toCsv` always ends in one, so this normally adds
  // nothing, and it must not add an empty row when it does.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** The header line, then one line per record, in `CSV_COLUMNS` order. */
export function tsvLines(records: VehicleRecord[]): string[] {
  return parseCsv(toCsv(records)).map((cells) => cells.map(tsvCell).join("\t"));
}

/**
 * §6.5: "header + rows, pastes into Excel or Google Sheets as columns".
 *
 * No trailing newline, unlike the CSV *file* `toCsv` builds: this string goes to the
 * clipboard and straight into a grid, where a trailing terminator is one blank row the
 * user has to delete.
 */
export function toTsv(records: VehicleRecord[]): string {
  return tsvLines(records).join(TSV_EOL);
}

/** §6.5 "Row": one tab-separated line in the CSV column order, with no header. */
export function toTsvRow(record: VehicleRecord): string {
  const [, line = ""] = tsvLines([record]);
  return line;
}
