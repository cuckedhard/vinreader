import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate, useParams } from "react-router";
import { FailureNotice } from "../../app/ErrorBoundary";
import { useStorageFailure } from "../../app/useStorageFailure";
import { currentYear, db } from "../../lib/storage/db";
import { normalizeVehicle } from "../../lib/storage/normalize";
import { refreshDecode } from "../../lib/storage/decodeQueue";
import { setVehicleMeta } from "../../lib/storage/upsert";
import { asciiUpper } from "../../lib/vin/grammar";
import type { ModelYear, VehicleRecord } from "../../lib/vin/types";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { SyncChip } from "../../ui/SyncChip";
import { VinDisplay } from "../../ui/VinDisplay";
import { Actions } from "./Actions";
import { DecodeGroups } from "./DecodeGroups";
import { DeleteVehicle, DeletedNotice } from "./DeleteVehicle";
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

/**
 * §6.4 supplies no line for the paint code, so these two are written in its voice and
 * logged under §0 rule 4 for Zach to sign off. The hint is the whole provenance in one
 * sentence: nothing decoded this, and nothing can check it — which is why the sheet keeps
 * it out of "From the VIN" and out of "Vehicle details" (N2).
 */
const PAINT_LABEL = "Paint code";
/** The half of the hint that is true however the characters got there (§7 item 5). */
const PAINT_NOT_DECODED = "The VIN doesn't carry it and NHTSA doesn't publish it.";
const PAINT_HINT = `Typed in from the paint sticker. ${PAINT_NOT_DECODED}`;
/**
 * S5 layer 2, and §5's "persist `source: \"ocr\"` … so nothing downstream mistakes it for
 * a decoded fact". This *is* downstream: three weeks later the sheet is where someone
 * reads the code out at a paint counter, and the two ways it could have got there are not
 * equally checked. A person typing has read the sticker character by character; a person
 * confirming a camera read has looked at six characters at once, on a control they may
 * have tapped without reading (§5's stated risk).
 *
 * What is deliberately not here is the number. `paintConfidence` is stored and never
 * rendered: §13.7 records that there is no corpus of real door-jamb stickers, so a
 * percentage would be uncalibrated for this task, and rule 6 forbids showing a guess as a
 * fact. A record whose provenance this device does not know (imported, pulled, or written
 * before layer 2) shows the plain hint rather than a claim about either.
 */
const PAINT_HINT_OCR = `Read off the sticker by the camera on this phone. ${PAINT_NOT_DECODED}`;
/**
 * Layer 2's way in. It names the camera and not a place on the car: S5 addendum §3 records
 * that "point at the door jamb" is wrong for a meaningful fraction of vehicles — VW and
 * Audi use the trunk or the spare-wheel well, GM legacy the glovebox — and the capture
 * screen says so itself.
 */
const PAINT_CAPTURE = "Read it with the camera";

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
  const navigate = useNavigate();
  const [unit, setUnit] = useState(record.unit ?? "");
  const [paint, setPaint] = useState(record.paint ?? "");
  const [notes, setNotes] = useState(record.notes ?? "");
  const [saved, setSaved] = useState({
    unit: record.unit ?? "",
    paint: record.paint ?? "",
    notes: record.notes ?? "",
  });
  const [status, setStatus] = useState<SaveStatus>("idle");
  const dirty = unit !== saved.unit || paint !== saved.paint || notes !== saved.notes;

  // D11: an edit goes through setVehicleMeta, never upsertVehicle, so it moves the
  // last-writer-wins clock while a later re-scan of the same VIN leaves it alone (§4.12).
  // It is also the only path §5.3 lets replace a paint code, because everything typed
  // here was typed by the person holding the phone.
  async function save() {
    if (!dirty || status === "saving") return;
    setStatus("saving");
    try {
      const next = await setVehicleMeta(record.vin, { unit, paint, notes });
      // Storage trims; mirror what it kept so the boxes and the record cannot disagree.
      setUnit(next.unit ?? "");
      setPaint(next.paint ?? "");
      setNotes(next.notes ?? "");
      setSaved({ unit: next.unit ?? "", paint: next.paint ?? "", notes: next.notes ?? "" });
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

      {/*
       * §4.9 `pc`. It sits in this section and in no other, because the sheet's three
       * blocks are three provenances and this is the third one: "From the VIN" is derived
       * from the 17 characters, "Vehicle details" is what NHTSA answered, and everything
       * here was typed by the person holding the phone. A paint code is not derivable and
       * NHTSA does not carry it, so rendering it above would state it as a decoded fact
       * (N2) — and it has no check digit and no grammar, so nothing could catch that.
       *
       * The field is not validated, uppercased or masked. Toyota `1F7`, Honda `NH-731P`,
       * Ford `UG`, VW `LC9X`, GM `WA8555` share no shape, so any rule here would refuse a
       * real code; monospace is for reading it back — the confusions are `0/O`, `B/8`,
       * `1/I` — and not a claim about the format. No placeholder either: a greyed example
       * inside an empty box is a code the eye can take for this vehicle's.
       */}
      <div className="flex flex-col gap-2">
        <label htmlFor="sheet-paint" className={LABEL}>
          {PAINT_LABEL}
        </label>
        <input
          id="sheet-paint"
          value={paint}
          onChange={(event) => setPaint(event.target.value)}
          onBlur={() => void save()}
          className={`${FIELD} min-h-[var(--tap)] font-vin`}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          aria-describedby="sheet-paint-hint"
        />
        <p id="sheet-paint-hint" className="text-base leading-snug text-fg-muted">
          {record.paintSource === "ocr" ? PAINT_HINT_OCR : PAINT_HINT}
        </p>
        {/*
         * Layer 2 pre-fills this field and replaces nothing: the capture screen ends at a
         * person confirming, and the confirmed string is saved through the same
         * `setVehicleMeta` the box above uses (§5, N2). Secondary, because the field is
         * the primary route and OCR is the shortcut — and because a paint code is optional.
         */}
        <Button variant="secondary" onClick={() => void navigate(`/v/${record.vin}/paint`)}>
          {PAINT_CAPTURE}
        </Button>
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

function NoRecord({ vin, onBack }: { vin: string; onBack?: () => void }) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4">
      {/* The VIN is what this screen is about, exactly as it is when the record exists,
          so it is the screen's heading here too — a state with no `<h1>` is one nobody
          reaches by heading navigation (§6.6, F13). */}
      <h1>
        <VinDisplay vin={vin} size="lg" className="break-all" />
      </h1>
      <p className="text-lg text-fg">No record for this VIN.</p>
      {onBack ? (
        <Button variant="primary" full onClick={onBack}>
          Back to History
        </Button>
      ) : null}
    </div>
  );
}

/**
 * §4.12's tombstone, read defensively. `deletedAt` is `string | null` on every write path,
 * so this is `!== null` for every row the app itself made; a row that somehow carries
 * `undefined` is one that was never deleted, and reading it as deleted would hide a vehicle
 * the user still has (N2).
 */
function isTombstoned(record: VehicleRecord): boolean {
  return typeof record.deletedAt === "string" && record.deletedAt !== "";
}

export interface SheetScreenProps {
  /**
   * §6.6: at ≥ 900 px History renders the Sheet in a right-hand pane, where there is no
   * `:vin` route param to read. Given, it wins over the param and the screen also drops the
   * two things that only make sense as a whole screen — the "Back to History" buttons —
   * because the pane has its own Close and leaving would take History with it.
   */
  vin?: string;
  /**
   * Called with the VIN after a delete this screen performed, so a host can react to it.
   * The screen already shows the outcome on its own; this is for the pane, which may want
   * to close rather than sit on a deleted vehicle.
   */
  onDeleted?: (vin: string) => void;
}

/** §6.2 the record view at /v/:vin, and §6.6's pane at ≥ 900 px. */
export default function SheetScreen({ vin: vinProp, onDeleted }: SheetScreenProps) {
  const params = useParams<{ vin: string }>();
  const navigate = useNavigate();
  const embedded = vinProp !== undefined;
  // §4.2 step 1 is ASCII-only everywhere a VIN is normalised, the route parameter included.
  const vin = asciiUpper((vinProp ?? params.vin ?? "").trim());
  const back = embedded ? undefined : () => void navigate("/history");

  // F1-b: the live query below never emits when the database never opened — Dexie filters
  // `DatabaseClosedError` before `observer.error`, so nothing throws and the boundary above
  // this screen is never reached. Without this signal `record` stays `undefined` and the
  // early return below rendered an empty `<main>`: no heading, no message, no error, for
  // the rest of the session, on the route a scan lands on.
  const storageFailure = useStorageFailure();

  // `undefined` is "the query has not answered yet" and `null` is "no such record";
  // without the sentinel the two look alike and the screen flashes "No record" on load.
  const record = useLiveQuery(async () => {
    const row = await db.vehicles.get(vin);
    // A row synced from §4.12 can arrive with empty structural/decode blocks; the sheet
    // rebuilds rather than crashes on them.
    return row ? normalizeVehicle(row, currentYear()) : null;
  }, [vin]);

  // `undefined` still means "no answer yet" and renders nothing while the query is in
  // flight; it only stops meaning that once storage has said it cannot answer at all (P7).
  if (record === undefined) {
    return storageFailure === null ? null : (
      <FailureNotice error={storageFailure.cause} fromStorage />
    );
  }
  if (record === null) return <NoRecord vin={vin} onBack={back} />;
  // §4.12: a tombstoned record is gone as far as the user's history is concerned — but it
  // is not the same fact as a VIN this device never had, and only one of the two is undone
  // by scanning the label again, so it gets its own state rather than "No record".
  if (isTombstoned(record)) return <DeletedNotice vin={record.vin} onBack={back} />;

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
      {/*
       * §6.2 puts the sync chip on this screen. It sits beside the VIN rather than below
       * the record because it describes the account, not this vehicle, and it renders
       * nothing at all signed out (or in a build with no Supabase) — so signed out this row
       * is the same single heading it was before S4.
       */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <h1>
          <VinDisplay vin={record.vin} size="lg" />
        </h1>
        <SyncChip className="shrink-0" />
      </div>

      <StructuralBlock vin={record.vin} structural={structural} />

      {/*
       * Each of these four holds state belonging to one vehicle — a half-typed unit, an
       * open QR, a Refresh in flight, an armed delete — so a `:vin` change (§6.2), or a new
       * row chosen in §6.6's pane, has to remount them rather than hand the next record to
       * the last one's state. The keys must also differ from
       * each other: React's array reconciler gathers the outgoing siblings into a Map keyed
       * by `key`, so one key shared by several siblings leaves one entry, only that sibling
       * is deleted, and the rest keep their DOM after their fibers are gone. That is the
       * previous vehicle's make, model and unit sitting under this vehicle's VIN (N2).
       */}
      <DecodeSection key={`decode-${record.vin}`} record={record} />

      <MetaEditor key={`meta-${record.vin}`} record={record} />

      {/* §9-S3: the handoff actions sit below the record they act on. */}
      <Actions key={`actions-${record.vin}`} record={record} />

      {/* §6.2 lists Delete last. Keyed with the rest: an armed confirmation belongs to one
          vehicle, and must never be handed to the next one shown here. */}
      <DeleteVehicle key={`delete-${record.vin}`} vin={record.vin} onDeleted={onDeleted} />
    </div>
  );
}
