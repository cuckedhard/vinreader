import type { RefObject } from "react";
import { toTsvRow } from "./rows";
import { decodeChip, field, formatScannedAt, yearText } from "./display";
import type { VehicleRecord } from "../../lib/vin/types";
import { Chip } from "../../ui/Chip";
import { VinDisplay } from "../../ui/VinDisplay";

/**
 * §6.6 fixes these eight and their order. The checkbox column is added only while
 * multi-select is on, so the table a user sees by default is the one §6.6 describes.
 */
const COLUMNS = ["VIN", "Year", "Make", "Model", "Unit", "Last scanned", "Status", "Copy"] as const;

/**
 * Not in §6.4 — reported under §0 rule 4. It is the table's accessible description, read
 * once by a screen reader before the rows and never shown; it is here because a table whose
 * rows do something needs to say what.
 */
const TABLE_CAPTION =
  "Saved vehicles. Choose a row to show that vehicle beside the table; the VIN and the " +
  "Copy button copy without opening it.";

const CELL = "px-3 py-2 align-middle text-base text-fg";
const HEAD = "px-3 py-2 text-left text-sm font-bold tracking-wide text-fg-muted uppercase";

/**
 * §6.1's ≥ 56 px, which names Copy alongside Scan and Share. Inline rather than a class so
 * it beats the button's own min-height, and applied to both copy targets in a row — the
 * VIN cell is a copy button too (§6.5).
 */
const COPY_TARGET = { minHeight: "var(--tap-lg)" };

const COPY_BUTTON =
  "inline-flex w-full items-center justify-start rounded-[var(--radius)] border " +
  "border-transparent px-2 text-left font-bold text-accent hover:border-border " +
  "focus-visible:outline-[3px] focus-visible:outline-offset-[-3px] focus-visible:outline-accent " +
  "active:opacity-80";

export interface HistoryTableProps {
  records: readonly VehicleRecord[];
  nowMs: number;
  selectMode: boolean;
  selected: ReadonlySet<string>;
  onToggle: (vin: string) => void;
  /** The VIN showing in the side pane, if any. */
  openVin: string | null;
  onOpen: (vin: string) => void;
  /** Writes to the clipboard synchronously (§6.5) — see `useCopy`. */
  onCopy: (text: string) => void;
  /** Where the screen keeps each row's element, so Escape can send focus back to it. */
  rowRefs: RefObject<Map<string, HTMLTableRowElement>>;
}

/**
 * §6.6's table.
 *
 * **Why the row itself is the control.** §6.5 spends both of a row's obvious buttons:
 * the VIN cell copies the VIN, and the Copy column copies the whole row. What opens the
 * vehicle in the side pane is therefore the row, which is a `<tr>` and not a button — so
 * it carries `tabIndex` and an Enter handler of its own, and §6.6's "Tab / Enter / Escape"
 * is exactly the interaction that results: Tab reaches every row and every button inside
 * it, Enter on a row opens it, Escape closes the pane (the screen owns that half). The
 * Enter handler ignores events that started on a nested button, which fire their own click
 * and would otherwise open the pane every time someone copied a VIN with the keyboard.
 *
 * Nothing here is hover-only (§6.6): the hover border on a copy button is decoration over
 * a control that is already visible, labelled and reachable.
 */
export function HistoryTable({
  records,
  nowMs,
  selectMode,
  selected,
  onToggle,
  openVin,
  onOpen,
  onCopy,
  rowRefs,
}: HistoryTableProps) {
  // In select mode the row is a selection target and nothing else: the checkbox says what
  // a tap will do, and opening the pane out from under a selection the user is building
  // would be a second meaning for the same tap.
  const activate = selectMode ? onToggle : onOpen;

  return (
    <div className="overflow-x-auto rounded-[var(--radius)] border border-border">
      <table className="w-full border-collapse">
        <caption className="sr-only">{TABLE_CAPTION}</caption>
        <thead className="border-b border-border bg-bg-elev">
          <tr>
            {selectMode ? (
              <th scope="col" className={HEAD}>
                <span className="sr-only">Selected</span>
              </th>
            ) : null}
            {COLUMNS.map((column) => (
              <th key={column} scope="col" className={HEAD}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((record) => {
            const open = record.vin === openVin;
            const isSelected = selected.has(record.vin);
            const decode = decodeChip(record.decode.status);
            const year = yearText(record);
            return (
              <tr
                key={record.vin}
                ref={(node) => {
                  if (node === null) rowRefs.current.delete(record.vin);
                  else rowRefs.current.set(record.vin, node);
                }}
                tabIndex={0}
                // The pane is showing this vehicle: the one row on screen that is "here".
                aria-current={open ? "true" : undefined}
                onClick={() => activate(record.vin)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  // A nested button's Enter already fired its own click.
                  if (event.target !== event.currentTarget) return;
                  event.preventDefault();
                  activate(record.vin);
                }}
                className={[
                  "cursor-pointer border-b border-border last:border-b-0",
                  "focus-visible:outline-[3px] focus-visible:outline-offset-[-3px]",
                  "focus-visible:outline-accent",
                  open || isSelected ? "bg-bg-elev" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {selectMode ? (
                  <td className={CELL}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      // The row's own click already toggles this one; without the stop it
                      // would toggle twice and never change.
                      onClick={(event) => event.stopPropagation()}
                      onChange={() => onToggle(record.vin)}
                      aria-label={`Select ${record.vin}`}
                      className="h-6 w-6 accent-[var(--accent)]"
                    />
                  </td>
                ) : null}

                {/* §6.5: "the VIN cell copies on click". No `whitespace-nowrap`: `VinDisplay`
                    already wraps at the §4.1 group breaks, and pinning this cell to one line
                    put 304 px of min-content into a table that had 770 to spend on eight
                    columns, which is how Status and Copy ended up outside the container (F9). */}
                <th scope="row" className={`${CELL} font-normal`}>
                  <button
                    type="button"
                    style={COPY_TARGET}
                    className={COPY_BUTTON}
                    onClick={(event) => {
                      event.stopPropagation();
                      onCopy(record.vin);
                    }}
                    aria-label={`Copy VIN ${record.vin}`}
                  >
                    <VinDisplay vin={record.vin} size="md" />
                  </button>
                </th>

                {/* N2: a year vPIC has not resolved shows both candidates, never one — and
                    "1996 or 2026" is three times the width of a resolved year, so it wraps
                    rather than widening the whole table past its container (F9). */}
                <td className={CELL}>{year ?? ""}</td>
                <td className={CELL}>{field(record.decode.fields, "Make") ?? ""}</td>
                <td className={CELL}>{field(record.decode.fields, "Model") ?? ""}</td>
                <td className={`${CELL} font-bold`}>{record.unit ?? ""}</td>
                <td className={`${CELL} whitespace-nowrap text-fg-muted`}>
                  <time dateTime={record.lastScannedAt}>
                    {formatScannedAt(record.lastScannedAt, nowMs)}
                  </time>
                </td>
                {/* `ok` is deliberately blank — see `display.ts`. The chip keeps its text on
                    one line by default, which is right on a phone and wrong in a column that
                    has to share 770 px with seven others: "Details failed — tap to retry" is
                    the longest §6.4 status there is, and unwrapped it alone took the table
                    340 px past its container (F9). Same idiom as `ManualEntry`'s neutral
                    chip: the white-space set on the child wins by inheritance. */}
                <td className={CELL}>
                  {decode !== null ? (
                    <Chip tone={decode.tone}>
                      <span className="whitespace-normal">{decode.label}</span>
                    </Chip>
                  ) : null}
                </td>

                {/* §6.6: "every row has a copy button" — §6.5's Row format, tab-separated. */}
                <td className={CELL}>
                  <button
                    type="button"
                    style={COPY_TARGET}
                    className={COPY_BUTTON}
                    onClick={(event) => {
                      event.stopPropagation();
                      onCopy(toTsvRow(record));
                    }}
                    aria-label={`Copy row for ${record.vin}`}
                  >
                    Copy row
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
