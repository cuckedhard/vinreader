import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate, useParams } from "react-router";
import { db } from "../../lib/storage/db";
import { setVehicleMeta } from "../../lib/storage/upsert";
import type { VehicleRecord } from "../../lib/vin/types";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { VinDisplay } from "../../ui/VinDisplay";
import { StructuralBlock } from "./StructuralBlock";

const LABEL = "text-sm font-bold tracking-wide text-fg-muted uppercase";
const FIELD =
  "w-full rounded-[var(--radius)] border border-border bg-bg-elev px-4 py-3 " +
  "text-base text-fg placeholder:text-fg-muted";

type SaveStatus = "idle" | "saving" | "saved" | "error";

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

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-4 pb-10">
      <h1>
        <VinDisplay vin={record.vin} size="lg" />
      </h1>

      <StructuralBlock vin={record.vin} structural={record.structural} />

      {/* N1: no vPIC field is invented here, and nothing above waited on one. */}
      <section aria-labelledby="details-heading">
        <h2 id="details-heading" className={LABEL}>
          Vehicle details
        </h2>
        <p className="mt-2 text-base leading-snug text-fg-muted">
          Make, model and the rest arrive in a later step. Everything above is read from the VIN
          itself and needs no signal.
        </p>
      </section>

      <MetaEditor key={record.vin} record={record} />
    </div>
  );
}
