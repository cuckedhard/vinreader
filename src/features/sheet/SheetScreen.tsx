import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate, useParams } from "react-router";
import { db } from "../../lib/storage/db";
import { refreshDecode } from "../../lib/storage/decodeQueue";
import { setVehicleMeta } from "../../lib/storage/upsert";
import type { ModelYear, VehicleRecord } from "../../lib/vin/types";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { VinDisplay } from "../../ui/VinDisplay";
import { Actions } from "./Actions";
import { DecodeGroups } from "./DecodeGroups";
import { StructuralBlock } from "./StructuralBlock";

const LABEL = "text-sm font-bold tracking-wide text-fg-muted uppercase";
const FIELD =
  "w-full rounded-[var(--radius)] border border-border bg-bg-elev px-4 py-3 " +
  "text-base text-fg placeholder:text-fg-muted";

/** §6.4 microcopy, verbatim. */
const DECODE_PENDING = "Fetching details from NHTSA…";
const DECODE_OFFLINE = "Offline — VIN saved. Details will fill in when you're back on signal.";
const DECODE_PARTIAL = "NHTSA returned partial data";
const DECODE_UNSUPPORTED =
  "This looks like an off-highway machine PIN. NHTSA can't decode it — showing what the number itself tells us.";
const DECODE_FAILED = "Couldn't reach NHTSA after several tries. Tap Refresh details to retry.";

/** §4.4: with a vPIC `ModelYear` on screen, the structural year row is dropped, not rewritten. */
const NO_STRUCTURAL_YEAR: ModelYear = { candidates: [], resolved: null };

type SaveStatus = "idle" | "saving" | "saved" | "error";

/** Reactive `navigator.onLine`: offline is the honest reason a pending decode is idle. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

/**
 * §5.4 / §6.4. Everything here sits below the structural block and none of it gates that
 * block: the sheet is complete without a network and fills in place when vPIC answers (N1).
 */
function DecodeSection({ record }: { record: VehicleRecord }) {
  const online = useOnline();
  const [refreshing, setRefreshing] = useState(false);
  const { decode } = record;
  const errorText = (decode.fields.ErrorText ?? "").trim();
  const partialTitle = errorText === "" ? DECODE_PARTIAL : `${DECODE_PARTIAL}: ${errorText}`;

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      // §4.7: the cache is permanent, so this button is the only way to ask vPIC twice.
      await refreshDecode(record.vin);
    } catch {
      // The record itself carries the outcome (§5.1 `lastError`) and the live query
      // re-renders on its own; the only job left here is to free the button again.
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="details-heading">
      <h2 id="details-heading" className={LABEL}>
        Vehicle details
      </h2>

      {decode.status === "pending" ? (
        <p role="status" className="text-base leading-snug text-fg-muted">
          {online ? DECODE_PENDING : DECODE_OFFLINE}
        </p>
      ) : null}

      {decode.status === "partial" ? <Banner tone="warn" title={partialTitle} /> : null}

      {/* Unsupported is information, not a failure: the structural block above is the answer. */}
      {decode.status === "unsupported" ? (
        <p className="rounded-[var(--radius)] border border-border bg-bg-elev p-4 text-base leading-snug text-fg">
          {DECODE_UNSUPPORTED}
        </p>
      ) : null}

      {decode.status === "failed" ? <Banner tone="warn" title={DECODE_FAILED} /> : null}

      {/* The banner above already carries `ErrorText`; the notice area must not repeat it. */}
      <DecodeGroups
        fields={decode.fields}
        skipNotices={decode.status === "partial" && errorText !== "" ? [errorText] : []}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? "Refreshing" : "Refresh details"}
        </Button>
        {/* A pending decode already says it is offline; every other status does not. */}
        {!online && decode.status !== "pending" ? <Chip tone="neutral">Offline</Chip> : null}
      </div>
    </section>
  );
}

function MetaEditor({ record }: { record: VehicleRecord }) {
  const [unit, setUnit] = useState(record.unit ?? "");
  const [notes, setNotes] = useState(record.notes ?? "");
  const [saved, setSaved] = useState({ unit: record.unit ?? "", notes: record.notes ?? "" });
  const [status, setStatus] = useState<SaveStatus>("idle");
  const dirty = unit !== saved.unit || notes !== saved.notes;

  // D11: an edit goes through setVehicleMeta, never upsertVehicle, so it moves the
  // last-writer-wins clock while a later re-scan of the same VIN leaves it alone (§4.12).
  async function save() {
    if (!dirty || status === "saving") return;
    setStatus("saving");
    try {
      const next = await setVehicleMeta(record.vin, { unit, notes });
      // Storage trims; mirror what it kept so the boxes and the record cannot disagree.
      setUnit(next.unit ?? "");
      setNotes(next.notes ?? "");
      setSaved({ unit: next.unit ?? "", notes: next.notes ?? "" });
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="meta-heading">
      <h2 id="meta-heading" className={LABEL}>
        Your notes
      </h2>

      <div className="flex flex-col gap-2">
        <label htmlFor="sheet-unit" className={LABEL}>
          Unit
        </label>
        <input
          id="sheet-unit"
          value={unit}
          onChange={(event) => setUnit(event.target.value)}
          onBlur={() => void save()}
          className={`${FIELD} min-h-[var(--tap)] font-vin`}
          placeholder="Truck 12"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="sheet-notes" className={LABEL}>
          Notes
        </label>
        <textarea
          id="sheet-notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          onBlur={() => void save()}
          rows={4}
          className={`${FIELD} min-h-[96px] resize-y leading-snug`}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={() => void save()} disabled={!dirty}>
          {status === "saving" ? "Saving" : "Save"}
        </Button>
        {dirty ? (
          <Chip tone="warn">Not saved yet</Chip>
        ) : status === "saved" ? (
          <Chip tone="ok">Saved</Chip>
        ) : null}
      </div>

      {status === "error" ? (
        <Banner tone="danger" title="Could not save">
          What you typed is still in the boxes above. Tap Save to try again.
        </Banner>
      ) : null}
    </section>
  );
}

function NoRecord({ vin }: { vin: string }) {
  const navigate = useNavigate();
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4">
      <VinDisplay vin={vin} size="lg" className="break-all" />
      <p className="text-lg text-fg">No record for this VIN.</p>
      <Button variant="primary" full onClick={() => void navigate("/history")}>
        Back to History
      </Button>
    </div>
  );
}

/** §6.2 the record view at /v/:vin. */
export default function SheetScreen() {
  const params = useParams<{ vin: string }>();
  const vin = (params.vin ?? "").trim().toUpperCase();

  // `undefined` is "the query has not answered yet" and `null` is "no such record";
  // without the sentinel the two look alike and the screen flashes "No record" on load.
  const record = useLiveQuery(async () => (await db.vehicles.get(vin)) ?? null, [vin]);

  if (record === undefined) return null;
  // §4.12: a tombstoned record is gone as far as the user is concerned.
  if (record === null || record.deletedAt !== null) return <NoRecord vin={vin} />;

  /**
   * §4.4 / §9-S2. vPIC's `ModelYear` overrides the structural candidates when present, and
   * the ambiguous year has to resolve in place. The stored `structural` is deterministic per
   * VIN and first-non-empty-wins under §4.12 sync, so it is never rewritten: the year is
   * dropped from the copy handed to `StructuralBlock` (`candidates: []` with `resolved: null`
   * makes its `YearRow` render nothing), which leaves the Identity group's Year — the same
   * `ModelYear` string, via the §4.8 map — as the only year on screen.
   */
  const vpicYear = (record.decode.fields.ModelYear ?? "").trim();
  const structural =
    vpicYear === "" ? record.structural : { ...record.structural, modelYear: NO_STRUCTURAL_YEAR };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-4 pb-10">
      <h1>
        <VinDisplay vin={record.vin} size="lg" />
      </h1>

      <StructuralBlock vin={record.vin} structural={structural} />

      <DecodeSection key={record.vin} record={record} />

      <MetaEditor key={record.vin} record={record} />

      {/* §9-S3: the handoff actions sit below the record they act on. */}
      <Actions key={record.vin} record={record} />
    </div>
  );
}
