import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Link, useNavigate } from "react-router";
import { db } from "../../lib/storage/db";
import type { DecodeStatus, VehicleRecord } from "../../lib/vin/types";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import type { ChipTone } from "../../ui/Chip";
import { VinDisplay } from "../../ui/VinDisplay";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const PANEL = "rounded-[var(--radius)] border border-border bg-bg-elev";

/**
 * N6: every label says what is actually known. `pending` is the only status S0 writes,
 * and it means "not fetched yet", not "failed".
 */
const DECODE_CHIP: Record<DecodeStatus, { tone: ChipTone; label: string }> = {
  pending: { tone: "neutral", label: "Details pending" },
  ok: { tone: "ok", label: "Details saved" },
  partial: { tone: "warn", label: "Some details" },
  unsupported: { tone: "neutral", label: "No details published" },
  failed: { tone: "warn", label: "Details not fetched" },
};

/** Case-insensitive, space-insensitive, so a VIN pasted in §4.1 display groups still matches. */
function normalize(value: string): string {
  return value.toUpperCase().replace(/\s+/g, "");
}

/**
 * VIN and unit only. Make and model are vPIC fields that no S0 record carries, so
 * searching them would silently match nothing (N1).
 */
function matchesQuery(record: VehicleRecord, query: string): boolean {
  if (normalize(record.vin).includes(query)) return true;
  return record.unit !== null && normalize(record.unit).includes(query);
}

function formatScannedAt(iso: string, nowMs: number): string {
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

function HistoryRow({ record, nowMs }: { record: VehicleRecord; nowMs: number }) {
  const year = record.structural.modelYear.resolved;
  const decode = DECODE_CHIP[record.decode.status];
  return (
    <li>
      <Link
        to={`/v/${record.vin}`}
        className={`flex min-h-[var(--tap)] flex-col gap-2 px-4 py-3 active:opacity-80 ${PANEL}`}
      >
        <VinDisplay vin={record.vin} size="md" className="block break-words" />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-base text-fg-muted">
          {record.unit ? <span className="font-bold text-fg">{record.unit}</span> : null}
          {/* N2: only a single surviving candidate is a fact; an ambiguous year shows on the sheet. */}
          {year !== null ? <span>{year}</span> : null}
          <time dateTime={record.lastScannedAt}>
            {formatScannedAt(record.lastScannedAt, nowMs)}
          </time>
          <Chip tone={decode.tone}>{decode.label}</Chip>
        </div>
      </Link>
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
        Search looks at the VIN and the unit. Make and model arrive with vehicle details later.
      </p>
      <Button variant="primary" full onClick={onClear}>
        Clear search
      </Button>
    </div>
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

/** §6.3 saved vehicles, newest first. */
export default function HistoryScreen() {
  const [query, setQuery] = useState("");

  const records = useLiveQuery(async () => {
    const rows = await db.vehicles.orderBy("lastScannedAt").reverse().toArray();
    // db.ts: IndexedDB does not index null, so live records are absent from the
    // `deletedAt` index and "not deleted" can only be a JS filter.
    const live = rows.filter((row) => row.deletedAt === null);
    // db.ts: §5.1 timestamps carry an offset and do not sort lexicographically across
    // time zones, so the index order is refined here by instant.
    return live.sort((a, b) => Date.parse(b.lastScannedAt) - Date.parse(a.lastScannedAt));
  }, []);

  const normalizedQuery = normalize(query);
  const visible = useMemo(() => {
    if (records === undefined) return [];
    if (normalizedQuery === "") return records;
    return records.filter((record) => matchesQuery(record, normalizedQuery));
  }, [records, normalizedQuery]);

  const nowMs = useNow();
  const total = records?.length ?? 0;

  let body: ReactNode = null;
  if (records !== undefined) {
    if (total === 0) {
      body = <EmptyHistory />;
    } else if (visible.length === 0) {
      body = <NoMatches onClear={() => setQuery("")} />;
    } else {
      body = (
        <ul className="flex flex-col gap-3">
          {visible.map((record) => (
            <HistoryRow key={record.vin} record={record} nowMs={nowMs} />
          ))}
        </ul>
      );
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 p-4 pb-10">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-2xl leading-tight font-bold text-fg">History</h1>
        {total > 0 ? (
          <p className="text-base text-fg-muted" aria-live="polite">
            {visible.length === total
              ? `${total} ${total === 1 ? "vehicle" : "vehicles"}`
              : `${visible.length} of ${total}`}
          </p>
        ) : null}
      </header>

      {total > 0 ? (
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
            placeholder="Search VIN or unit"
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
      ) : null}

      {body}
    </div>
  );
}
