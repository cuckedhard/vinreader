import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Link, useNavigate } from "react-router";
import { buildExportBundle, toCsv } from "../../lib/payload/exportBundle";
import { db, nowIso } from "../../lib/storage/db";
import { normalizeVehicle } from "../../lib/storage/normalize";
import type { VehicleRecord } from "../../lib/vin/types";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { SyncChip } from "../../ui/SyncChip";
import { VinDisplay } from "../../ui/VinDisplay";
import { CopyToast, ManualCopy, useCopy } from "./copy";
import { decodeChip, formatScannedAt, headline, matchesQuery, normalizeQuery } from "./display";
import { HistoryTable } from "./HistoryTable";
import { toTsv } from "./rows";
import { allSelected, selectedRecords, toggleVin, withAll } from "./selection";
import { SheetPane } from "./SheetPane";
import { useWide } from "./useWide";

const PANEL_BASE = "rounded-[var(--radius)] border bg-bg-elev";
const PANEL = `${PANEL_BASE} border-border`;

/**
 * §6.1 names Copy alongside Scan, Use as-is, Share and Sign in as a ≥ 56 px target.
 * Inline rather than a class, because the secondary variant's own 48 px min-height is a
 * class and would otherwise win.
 */
const COPY_TARGET = { minHeight: "var(--tap-lg)" };

/**
 * Not in §6.4 — every string here is reported under §0 rule 4. §6.4 names the copy
 * confirmation and the formats but not the controls that reach them, so they are declared
 * together, in one place, rather than written into JSX where they cannot be reviewed.
 *
 * "Copy TSV" and "Copy CSV" are §6.5's own names for the two formats. "Copy all" is §9-S4's
 * name for the whole-device copy, and it sits beside "Export all" because those two do the
 * same thing to the same records and differ only in where the result lands.
 */
const SELECT = "Select";
const SELECT_DONE = "Done";
const SELECT_ALL = "Select all";
// "Clear selection" and not "Clear": the search field's own Clear button can be on screen
// at the same time, and two buttons a thumb apart both reading "Clear" is a field mistake
// waiting to happen.
const SELECT_CLEAR = "Clear selection";
const COPY_TSV = "Copy TSV";
const COPY_CSV = "Copy CSV";
const COPY_ALL_TSV = "Copy all TSV";
const COPY_ALL_CSV = "Copy all CSV";
const SELECTION_GROUP = "Copy selected vehicles";

function selectedLabel(count: number): string {
  return count === 1 ? "1 selected" : `${count} selected`;
}

/** The list row, unchanged below 900 px — a whole-card link to the sheet (§6.2). */
function RowBody({ record, nowMs }: { record: VehicleRecord; nowMs: number }) {
  const title = headline(record);
  const decode = decodeChip(record.decode.status);
  return (
    <>
      {/* N2: an ambiguous year leaves this line to the make and model, or drops it. */}
      {title !== null ? <p className="text-lg leading-tight font-bold text-fg">{title}</p> : null}
      <VinDisplay vin={record.vin} size="md" className="block break-words" />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-base text-fg-muted">
        {record.unit ? <span className="font-bold text-fg">{record.unit}</span> : null}
        <time dateTime={record.lastScannedAt}>{formatScannedAt(record.lastScannedAt, nowMs)}</time>
        {decode !== null ? <Chip tone={decode.tone}>{decode.label}</Chip> : null}
      </div>
    </>
  );
}

interface HistoryRowProps {
  record: VehicleRecord;
  nowMs: number;
  selectMode: boolean;
  isSelected: boolean;
  onToggle: (vin: string) => void;
}

/**
 * Multi-select is a mode, entered by a visible button, and not something a row does on its
 * own: N5 bans the long-press that would otherwise start it, and a checkbox permanently
 * attached to every row would put a second meaning on the tap that opens the vehicle —
 * the one thing this screen exists to do. Out of the mode, this is exactly the row S0
 * shipped.
 *
 * In the mode the checkbox is the control: it carries the label, the state and the keyboard
 * (the card's tap is a pointer convenience over it, which is why it stops the propagation
 * that would otherwise toggle twice).
 */
function HistoryRow({ record, nowMs, selectMode, isSelected, onToggle }: HistoryRowProps) {
  if (!selectMode) {
    return (
      <li>
        <Link
          to={`/v/${record.vin}`}
          className={`flex min-h-[var(--tap)] flex-col gap-2 px-4 py-3 active:opacity-80 ${PANEL}`}
        >
          <RowBody record={record} nowMs={nowMs} />
        </Link>
      </li>
    );
  }

  return (
    <li>
      <div
        onClick={() => onToggle(record.vin)}
        className={
          "flex min-h-[var(--tap)] items-start gap-3 px-4 py-3 " +
          `${PANEL_BASE} ${isSelected ? "border-accent" : "border-border"}`
        }
      >
        <input
          type="checkbox"
          checked={isSelected}
          onClick={(event) => event.stopPropagation()}
          onChange={() => onToggle(record.vin)}
          aria-label={`Select ${record.vin}`}
          className="mt-1 h-6 w-6 shrink-0 accent-[var(--accent)]"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <RowBody record={record} nowMs={nowMs} />
        </div>
      </div>
    </li>
  );
}

function EmptyHistory() {
  const navigate = useNavigate();
  return (
    <div className={`flex flex-col gap-4 p-5 ${PANEL}`}>
      <p className="text-lg leading-tight font-bold text-fg">Nothing scanned yet</p>
      <p className="text-base leading-snug text-fg-muted">
        VINs you scan or type in are saved here on this device, and stay readable with no signal.
      </p>
      <Button variant="primary" full onClick={() => void navigate("/scan")}>
        Go to Scan
      </Button>
    </div>
  );
}

function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <div className={`flex flex-col gap-4 p-5 ${PANEL}`}>
      <p className="text-lg leading-tight font-bold text-fg">No records match that search</p>
      <p className="text-base leading-snug text-fg-muted">
        Search looks at the VIN, the unit, and the make and model from the vehicle details.
      </p>
      <Button variant="primary" full onClick={onClear}>
        Clear search
      </Button>
    </div>
  );
}

/**
 * A file download, not a clipboard write, so the §6.5 synchronous rule does not apply —
 * but two browser quirks do: some browsers honour `download` only on an anchor that is in
 * the document, and Safari cancels an in-flight download if the object URL is revoked in
 * the same tick.
 */
function downloadFile(fileName: string, contents: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * §9-S3 Export all, and §9-S4 Copy all. Occasional, so they sit below the list where they
 * cannot be taken for a row action or crowd the search field. Both act on every saved
 * vehicle held by this screen — the same non-deleted set the list is built from, not the
 * search result — and with nothing saved every action is disabled rather than writing a
 * file, or a clipboard, holding only a header.
 */
function BulkActions({
  records,
  onCopy,
}: {
  records: VehicleRecord[];
  onCopy: (text: string) => void;
}) {
  const count = records.length;
  const empty = count === 0;

  function exportJson() {
    // One clock read for both the bundle stamp and the file name, so they cannot disagree
    // across midnight. §5.1: `nowIso` is local time with an offset, and its first ten
    // characters are that local date.
    const exportedAt = nowIso();
    const bundle = buildExportBundle(records, exportedAt);
    downloadFile(
      `vin-relay-export-${exportedAt.slice(0, 10)}.json`,
      `${JSON.stringify(bundle, null, 2)}\n`,
      "application/json",
    );
  }

  function exportCsv() {
    downloadFile(
      `vin-relay-export-${nowIso().slice(0, 10)}.csv`,
      toCsv(records),
      "text/csv;charset=utf-8",
    );
  }

  return (
    <section className={`flex flex-col gap-3 p-4 ${PANEL}`} aria-labelledby="bulk-heading">
      <h2 id="bulk-heading" className="text-base font-bold text-fg">
        Everything on this device
      </h2>
      <p id="bulk-note" className="text-base leading-snug text-fg-muted">
        {empty
          ? "Nothing to copy or export yet — scan a VIN first."
          : `Copies or downloads all ${count} saved ${count === 1 ? "vehicle" : "vehicles"} on ` +
            "this device, not just what the search shows."}
      </p>
      {/* §6.1: every target ≥ 48 px and the copies ≥ 56 px, one tap each, no gesture (N5). */}
      <div className="grid grid-cols-2 gap-3">
        {/*
         * §6.5 and §11: `records` is already in memory — it is what this screen rendered
         * from — and `toTsv`/`toCsv` are pure and synchronous, so the clipboard write is
         * still the first thing that yields inside the tap handler. Nothing here may
         * become `async`.
         */}
        <Button
          variant="secondary"
          style={COPY_TARGET}
          onClick={() => onCopy(toTsv(records))}
          disabled={empty}
          aria-describedby="bulk-note"
        >
          {COPY_ALL_TSV}
        </Button>
        <Button
          variant="secondary"
          style={COPY_TARGET}
          onClick={() => onCopy(toCsv(records))}
          disabled={empty}
          aria-describedby="bulk-note"
        >
          {COPY_ALL_CSV}
        </Button>
        <Button
          variant="secondary"
          onClick={exportJson}
          disabled={empty}
          aria-describedby="bulk-note"
        >
          Export JSON
        </Button>
        <Button
          variant="secondary"
          onClick={exportCsv}
          disabled={empty}
          aria-describedby="bulk-note"
        >
          Export CSV
        </Button>
      </div>
    </section>
  );
}

/**
 * A clock the render can read. Reading Date.now() during render is impure and
 * would make row labels shift on any unrelated re-render; this snapshots it per
 * mount and re-reads once a minute so a screen left open does not go stale.
 */
function useNow(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return nowMs;
}

/** §6.2 saved vehicles, newest first; §6.6's table and side pane at ≥ 900 px. */
export default function HistoryScreen() {
  const [query, setQuery] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [openVin, setOpenVin] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const { copied, manual, copy, dismissManual } = useCopy();
  const wide = useWide();
  const nowMs = useNow();

  const records = useLiveQuery(async () => {
    const rows = await db.vehicles.orderBy("lastScannedAt").reverse().toArray();
    // db.ts: IndexedDB does not index null, so live records are absent from the
    // `deletedAt` index and "not deleted" can only be a JS filter.
    // §4.12 rows can arrive with empty structural/decode blocks. One unreadable row must
    // cost that row, never the whole route (P7).
    const year = new Date().getFullYear();
    const live = rows
      .filter((row) => row.deletedAt === null)
      .map((row) => normalizeVehicle(row, year))
      .filter((row): row is VehicleRecord => row !== null);
    // db.ts: §5.1 timestamps carry an offset and do not sort lexicographically across
    // time zones, so the index order is refined here by instant.
    return live.sort((a, b) => Date.parse(b.lastScannedAt) - Date.parse(a.lastScannedAt));
  }, []);

  const normalizedQuery = normalizeQuery(query);
  const visible = useMemo(() => {
    if (records === undefined) return [];
    if (normalizedQuery === "") return records;
    return records.filter((record) => matchesQuery(record, normalizedQuery));
  }, [records, normalizedQuery]);

  /**
   * §6.5's rows, resolved during render and therefore in memory before any button exists
   * to tap. This is what lets the copy handlers below write to the clipboard without
   * awaiting anything: the selection is a set of VINs, and the records it names are read
   * out of the live query's answer, never out of Dexie at tap time.
   *
   * It is also self-pruning — a VIN deleted here or on another device (§4.12) drops out of
   * the count and out of the copy without anyone having to notice.
   */
  const chosen = useMemo(() => selectedRecords(records ?? [], selected), [records, selected]);

  const total = records?.length ?? 0;
  const count = chosen.length;

  function exitSelect() {
    setSelectMode(false);
    // Leaving the mode takes the selection with it: the copy buttons go with it too, so a
    // selection left behind would be invisible state waiting to surprise the next copy.
    setSelected(new Set());
  }

  function toggle(vin: string) {
    setSelected((previous) => toggleVin(previous, vin));
  }

  function closePane() {
    const wasOpen = openVin;
    setOpenVin(null);
    // §6.6's keyboard path: Escape returns focus to the row it came from rather than
    // dropping it on the document, where the next Tab would start again from the top.
    if (wasOpen !== null) rowRefs.current.get(wasOpen)?.focus();
  }

  const header = (
    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <h1 className="text-2xl leading-tight font-bold text-fg">History</h1>
      <div className="flex items-center gap-3">
        {total > 0 ? (
          <p className="text-base text-fg-muted" aria-live="polite">
            {visible.length === total
              ? `${total} ${total === 1 ? "vehicle" : "vehicles"}`
              : `${visible.length} of ${total}`}
          </p>
        ) : null}
        {/* §6.2: the sync chip belongs to History and the Sheet. It reads the engine
            itself and renders "signed out" as nothing to say, so it is unconditional. */}
        <SyncChip />
      </div>
    </header>
  );

  const search =
    total > 0 ? (
      <div role="search" className="flex items-center gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          type="text"
          inputMode="text"
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          placeholder="Search VIN, unit, make or model"
          aria-label="Search saved vehicles"
          className={
            "min-h-[var(--tap)] min-w-0 flex-1 px-4 py-3 font-vin text-base text-fg " +
            `placeholder:font-sans placeholder:text-fg-muted ${PANEL}`
          }
        />
        {query !== "" ? (
          <Button variant="secondary" className="shrink-0" onClick={() => setQuery("")}>
            Clear
          </Button>
        ) : null}
      </div>
    ) : null;

  const toolbar =
    total > 0 ? (
      selectMode ? (
        <div role="group" aria-label={SELECTION_GROUP} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            {/* §6.5: both write a header and one line per selected record, in the S3
                column order. Synchronous, from `chosen` — see the note at `chosen`. */}
            <Button
              variant="secondary"
              style={COPY_TARGET}
              disabled={count === 0}
              onClick={() => copy(toTsv(chosen))}
            >
              {COPY_TSV}
            </Button>
            <Button
              variant="secondary"
              style={COPY_TARGET}
              disabled={count === 0}
              onClick={() => copy(toCsv(chosen))}
            >
              {COPY_CSV}
            </Button>
            <p className="text-base text-fg-muted" aria-live="polite">
              {selectedLabel(count)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              disabled={allSelected(visible, selected)}
              onClick={() =>
                setSelected((previous) =>
                  withAll(
                    previous,
                    visible.map((r) => r.vin),
                  ),
                )
              }
            >
              {SELECT_ALL}
            </Button>
            <Button
              variant="secondary"
              disabled={count === 0}
              onClick={() => setSelected(new Set())}
            >
              {SELECT_CLEAR}
            </Button>
            <Button variant="secondary" onClick={exitSelect}>
              {SELECT_DONE}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={() => setSelectMode(true)}>
            {SELECT}
          </Button>
        </div>
      )
    ) : null;

  let body: ReactNode = null;
  if (records !== undefined) {
    if (total === 0) {
      body = <EmptyHistory />;
    } else if (visible.length === 0) {
      body = <NoMatches onClear={() => setQuery("")} />;
    } else if (wide) {
      body = (
        <HistoryTable
          records={visible}
          nowMs={nowMs}
          selectMode={selectMode}
          selected={selected}
          onToggle={toggle}
          openVin={openVin}
          onOpen={setOpenVin}
          onCopy={copy}
          rowRefs={rowRefs}
        />
      );
    } else {
      body = (
        <ul className="flex flex-col gap-3">
          {visible.map((record) => (
            <HistoryRow
              key={record.vin}
              record={record}
              nowMs={nowMs}
              selectMode={selectMode}
              isSelected={selected.has(record.vin)}
              onToggle={toggle}
            />
          ))}
        </ul>
      );
    }
  }

  const fallback = manual === null ? null : <ManualCopy text={manual} onDone={dismissManual} />;

  // Held back until the live query has answered, so the disabled state never flashes
  // over a database that is merely still loading.
  const bulk = records === undefined ? null : <BulkActions records={records} onCopy={copy} />;

  if (wide && total > 0) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-4 p-4">
        <div className="flex shrink-0 flex-col gap-4">
          {header}
          {search}
          {toolbar}
        </div>
        {/*
         * §6.6's Escape. It is bound here rather than on the window so it belongs to the
         * table and its pane: Escape in the search field above still means what the browser
         * makes it mean, and nothing on another route is listening.
         */}
        <div
          className="flex min-h-0 flex-1 gap-4"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || openVin === null) return;
            event.stopPropagation();
            closePane();
          }}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto pb-2">
            {body}
            {fallback}
            {bulk}
          </div>
          <SheetPane
            vin={openVin}
            onClose={closePane}
            className="w-[min(42vw,460px)] shrink-0 overflow-hidden"
          />
        </div>
        <CopyToast copied={copied} />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 p-4 pb-10">
      {header}
      {search}
      {toolbar}
      {body}
      {fallback}
      {bulk}
      <CopyToast copied={copied} />
    </div>
  );
}
