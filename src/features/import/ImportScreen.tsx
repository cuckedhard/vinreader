/**
 * §6.2 Import — the receiving half of the handoff. Four ways in: a shared link's `?d=`
 * payload, a pasted carrier, summary or bare VIN, a `.json` record or export bundle, or
 * nothing yet. All land on the same preview, and nothing is written without a tap (§6.4).
 */
import { useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate, useSearchParams } from "react-router";

import {
  decodePayload,
  parseCarrier,
  PAYLOAD_VERSION,
  PayloadError,
} from "../../lib/payload/codec";
import type { Payload } from "../../lib/payload/schema";
import { exportBundleSchema, vehicleRecordSchema } from "../../lib/payload/schema";
import { parseShareTextVin } from "../../lib/payload/shareText";
import { db } from "../../lib/storage/db";
import { kickDecodeQueue } from "../../lib/storage/decodeQueue";
import { setVehicleMeta, upsertVehicle } from "../../lib/storage/upsert";
import { checkDigitApplies, isCheckDigitValid } from "../../lib/vin/checkDigit";
import { extractVin } from "../../lib/vin/extractVin";
import type { VehicleRecord } from "../../lib/vin/types";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { VinDisplay } from "../../ui/VinDisplay";

const PANEL = "rounded-[var(--radius)] border border-border bg-bg-elev";
const LABEL = "text-sm font-bold tracking-wide text-fg-muted uppercase";

/**
 * §6.4 supplies no import copy, so every line here is written to P7: name what went
 * wrong, never blame the person holding the phone, and always leave a way forward.
 */
const HINT_LINK = "Ask the sender to share it again, or paste the VIN below.";
const HINT_PASTE =
  "A link looks like https://…/#/i?d=…, a code starts with VINRELAY1:, and a VIN is 17 characters.";
const HINT_FILE = "Pick a .json file VIN Relay exported, or paste a link or a VIN instead.";
const HINT_SAVE_ONE = "Tap Import to try again.";
const HINT_SAVE_MANY = "What is left is still listed below. Tap Import to try again.";

const ERR_NOT_A_CARRIER = "That text isn't a VIN Relay link, a VINRELAY1 code, or a VIN.";
const ERR_BAD_VIN = "That payload's VIN isn't 17 valid characters, so there is nothing to save.";
const ERR_NOT_JSON = "That file isn't JSON, so there is nothing to read.";
const ERR_NOT_VIN_RELAY = "That file is JSON, but it isn't a VIN Relay record or export.";
const ERR_EMPTY_BUNDLE = "That export doesn't list any vehicles.";
const ERR_FILE_UNREADABLE = "That file couldn't be read.";

/**
 * §5.3's paint-code question, in §6.4's voice. §6.4 supplies no line for it, so these are
 * written here and logged under §0 rule 4. The two button labels carry the value *inside*
 * the control the user taps, which is the S5 addendum §5 rule: the reading target and the
 * tap target are the same pixels, so a code cannot be accepted without being read.
 */
const PAINT_LABEL = "Paint code";
const PAINT_CONFLICT_TITLE = "This phone already has a paint code";
const PAINT_CONFLICT_BODY =
  "Nothing can check a paint code, so the import keeps the one already here. Tap the other to use it instead.";
const PAINT_KEEP = "Keep";
const PAINT_USE = "Use";

/** §4.3 / D17: shown, never enforced — the record is already someone else's decision. */
const CHECK_DIGIT_ONE =
  "Check digit doesn't match. The sender may have accepted a misread — you can still import it.";
const CHECK_DIGIT_MANY = "Some check digits don't match.";
const CHECK_DIGIT_MANY_BODY =
  "The sender may have accepted a misread. Those rows are marked, and they still import.";

interface ImportItem {
  vin: string;
  year: string | null;
  make: string | null;
  model: string | null;
  unit: string | null;
  notes: string | null;
  /** §4.9 `pc`. Captured by whoever sent this, never decoded from anything. */
  paint: string | null;
  at: string | null;
  by: string | null;
  /** §5.2 keeps the bytes the record arrived as; see `itemFromRecord` for the file case. */
  raw: string;
}

interface Preview {
  /** Where this preview came from, so the user can tell a link from a file at a glance. */
  source: string;
  items: ImportItem[];
}

interface Failure {
  title: string;
  hint: string;
}

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function messageOf(cause: unknown): string {
  // `PayloadError` messages are already written for this screen (P6), and every other
  // throw here is a Dexie or platform error whose message is the only thing known.
  if (cause instanceof PayloadError) return cause.message;
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/**
 * A refused carrier as this screen says it (§6.4).
 *
 * §6.4 gives one rejection a line of its own — a payload that parses but carries no usable
 * VIN — and until F10 that line could not render: it sat behind an
 * `isVinGrammarValid(payload.vin)` check *after* the codec had already validated the same
 * field with the same regex, so the codec always threw first and what a field user read was
 * zod's wording quoting §4.1. The state is real; only the place it was detected was wrong.
 * `PayloadError.fields` names the field, so the case is recognised where it actually
 * happens, and every other rejection keeps the message the codec wrote for it.
 */
function failureOf(cause: unknown): Failure {
  const badVin = cause instanceof PayloadError && cause.fields.includes("vin");
  return { title: badVin ? ERR_BAD_VIN : messageOf(cause), hint: HINT_LINK };
}

function itemFromPayload(payload: Payload, raw: string): ImportItem {
  return {
    vin: payload.vin,
    year: text(payload.y),
    make: text(payload.mk),
    model: text(payload.md),
    unit: text(payload.u),
    notes: text(payload.n),
    paint: text(payload.pc),
    at: text(payload.at),
    by: text(payload.by),
    raw,
  };
}

/**
 * A VIN and nothing else — the two paste paths that carry no fields. §4.9 says the
 * receiver runs its own vPIC decode, so a VIN alone is a whole import.
 */
function itemFromVin(vin: string, raw: string): ImportItem {
  return {
    vin,
    year: null,
    make: null,
    model: null,
    unit: null,
    notes: null,
    paint: null,
    at: null,
    by: null,
    raw,
  };
}

function itemFromRecord(record: VehicleRecord): ImportItem {
  const { fields } = record.decode;
  const resolved = record.structural.modelYear.resolved;
  return {
    vin: record.vin,
    // N2: the structural year stands in only once one candidate survives (§4.4).
    year: text(fields.ModelYear) ?? (resolved === null ? null : String(resolved)),
    make: text(fields.Make),
    model: text(fields.Model),
    unit: text(record.unit),
    notes: text(record.notes),
    paint: text(record.paint),
    at: record.lastScannedAt,
    by: null,
    // A `.json` record carries no carrier text, and the file itself can be megabytes;
    // the VIN is the only source string worth keeping in the §5.2 event.
    raw: record.vin,
  };
}

function headlineOf(item: ImportItem): string | null {
  // N2: only what the payload actually carries; a missing part is dropped, never filled.
  const parts = [item.year, item.make, item.model].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" ");
}

/** §4.3 / D17: a mismatch says something only where position 9 carries a check digit. */
function checkDigitMismatch(vin: string): boolean {
  return checkDigitApplies(vin) && !isCheckDigitValid(vin);
}

function formatAt(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * P6: a VIN Relay file written by another codec version is named as one rather than
 * reported as a pile of shape errors. Returns null when this is not that case.
 */
function foreignBundleVersion(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const row = parsed as { app?: unknown; v?: unknown };
  if (row.app !== "vin-relay" || row.v === PAYLOAD_VERSION) return null;
  return typeof row.v === "number" ? String(row.v) : JSON.stringify(row.v ?? null);
}

/** What the screen is showing: at most one preview, at most one failure. */
interface Outcome {
  preview: Preview | null;
  failure: Failure | null;
}

const NOTHING: Outcome = { preview: null, failure: null };

/**
 * The `?d=` carrier, read during render rather than in an effect: parsing is pure and
 * synchronous, so an effect would only add a cascading render (react-hooks).
 */
function readLink(encoded: string): Outcome {
  try {
    const payload = decodePayload(encoded);
    return {
      preview: { source: "Shared link", items: [itemFromPayload(payload, `#/i?d=${encoded}`)] },
      failure: null,
    };
  } catch (cause) {
    return { preview: null, failure: failureOf(cause) };
  }
}

function Details({ item }: { item: ImportItem }) {
  const rows: { label: string; value: string }[] = [];
  if (item.unit !== null) rows.push({ label: "Unit", value: item.unit });
  // N2: a payload with no paint code shows no paint row, exactly as the sheet shows no
  // empty vPIC row. There is nothing to say, and a dash would look like an answer.
  if (item.paint !== null) rows.push({ label: PAINT_LABEL, value: item.paint });
  const at = item.at === null ? null : formatAt(item.at);
  if (at !== null) rows.push({ label: "Scanned", value: at });
  if (item.by !== null) rows.push({ label: "From", value: item.by });
  if (item.notes !== null) rows.push({ label: "Notes", value: item.notes });
  if (rows.length === 0) return null;
  return (
    <dl className="flex flex-col gap-2 text-base leading-snug">
      {rows.map((row) => (
        <div key={row.label} className="flex flex-wrap gap-x-2">
          <dt className="text-fg-muted">{row.label}</dt>
          <dd className="font-bold break-words text-fg">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * §5.3's confirmation, for the one field on the record that has no other check.
 *
 * An import may not replace a stored paint code on its own (`upsert.ts`), so this is where
 * the user is asked — before the write, on a screen that already exists to preview it, and
 * never anywhere near the scan path (N1: scanning a §4.9 QR lands here rather than writing
 * a record, so nothing about this question can hold a scan up).
 *
 * Both codes sit *inside* the controls, in `--vin-font`: the reading target and the tap
 * target are the same pixels, which is the S5 addendum's rule for a value nothing
 * downstream can check. What will happen if the user simply taps Import is the pressed
 * button, because a chooser that showed no state would be a guess about the outcome (N2).
 */
function PaintChoice({
  stored,
  incoming,
  chosen,
  onChoose,
}: {
  stored: string;
  incoming: string;
  chosen: string;
  onChoose: (code: string) => void;
}) {
  return (
    <div className={`flex flex-col gap-3 p-4 ${PANEL}`} role="group" aria-label={PAINT_LABEL}>
      <p className="text-base leading-snug font-bold text-fg">{PAINT_CONFLICT_TITLE}</p>
      <p className="text-base leading-snug text-fg-muted">{PAINT_CONFLICT_BODY}</p>
      <div className="flex flex-wrap gap-3">
        <Button
          variant={chosen === stored ? "primary" : "secondary"}
          aria-pressed={chosen === stored}
          onClick={() => onChoose(stored)}
        >
          {PAINT_KEEP} <span className="font-vin">{stored}</span>
        </Button>
        <Button
          variant={chosen === incoming ? "primary" : "secondary"}
          aria-pressed={chosen === incoming}
          onClick={() => onChoose(incoming)}
        >
          {PAINT_USE} <span className="font-vin">{incoming}</span>
        </Button>
      </div>
    </div>
  );
}

/** The stored paint code this import would land on, when the two differ. */
function paintConflict(
  item: ImportItem,
  storedPaint: Map<string, string> | undefined,
): string | null {
  const stored = storedPaint?.get(item.vin) ?? null;
  if (stored === null || item.paint === null || item.paint === stored) return null;
  return stored;
}

function PreviewRow({ item }: { item: ImportItem }) {
  const headline = headlineOf(item);
  return (
    <div className="flex flex-col gap-1 border-t border-border pt-3">
      {headline !== null ? (
        <p className="text-base leading-tight font-bold text-fg">{headline}</p>
      ) : null}
      <VinDisplay vin={item.vin} size="lg" className="block break-words" />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-base text-fg-muted">
        {item.unit !== null ? <span className="font-bold text-fg">{item.unit}</span> : null}
        {checkDigitMismatch(item.vin) ? <Chip tone="warn">Check digit mismatch</Chip> : null}
      </div>
    </div>
  );
}

/** §6.4: preview then confirm. Import and Cancel, and no write until Import is tapped. */
function PreviewCard({
  preview,
  busy,
  storedPaint,
  chosenPaint,
  onChoosePaint,
  onImport,
  onCancel,
}: {
  preview: Preview;
  busy: boolean;
  /** What this device already holds, by VIN — read once for the whole preview. */
  storedPaint: Map<string, string> | undefined;
  chosenPaint: Record<string, string>;
  onChoosePaint: (vin: string, code: string) => void;
  onImport: () => void;
  onCancel: () => void;
}) {
  const { items } = preview;
  const single = items.length === 1 ? items[0] : null;
  const headline = single === null ? null : headlineOf(single);
  const mismatches = items.filter((item) => checkDigitMismatch(item.vin)).length;

  return (
    <section className={`flex flex-col gap-4 p-5 ${PANEL}`} aria-labelledby="import-preview">
      <p className={LABEL}>{preview.source}</p>

      {single !== null ? (
        <>
          {/* §6.4, verbatim shape: "Import 2003 HONDA Accord · 1HG CM826 3 3 A 004352?" */}
          <h2 id="import-preview" className="text-lg leading-snug font-bold text-fg">
            Import{headline === null ? "" : ` ${headline} ·`}{" "}
            <VinDisplay vin={single.vin} size="lg" className="break-words" />?
          </h2>
          <Details item={single} />
          {(() => {
            const stored = paintConflict(single, storedPaint);
            return stored === null || single.paint === null ? null : (
              <PaintChoice
                stored={stored}
                incoming={single.paint}
                chosen={chosenPaint[single.vin] ?? stored}
                onChoose={(code) => onChoosePaint(single.vin, code)}
              />
            );
          })()}
        </>
      ) : (
        <>
          <h2 id="import-preview" className="text-lg leading-snug font-bold text-fg">
            Import {items.length} vehicles?
          </h2>
          <div className="flex flex-col gap-3">
            {items.map((item, index) => {
              const stored = paintConflict(item, storedPaint);
              return (
                <div key={`${index}-${item.vin}`} className="flex flex-col gap-3">
                  <PreviewRow item={item} />
                  {stored === null || item.paint === null ? null : (
                    <PaintChoice
                      stored={stored}
                      incoming={item.paint}
                      chosen={chosenPaint[item.vin] ?? stored}
                      onChoose={(code) => onChoosePaint(item.vin, code)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {mismatches > 0 ? (
        single !== null ? (
          <Banner tone="warn" title={CHECK_DIGIT_ONE} />
        ) : (
          <Banner tone="warn" title={CHECK_DIGIT_MANY}>
            <p>{CHECK_DIGIT_MANY_BODY}</p>
          </Banner>
        )
      ) : null}

      <div className="flex flex-col gap-3">
        <Button variant="primary" full onClick={onImport} disabled={busy}>
          {busy ? "Importing…" : "Import"}
        </Button>
        <Button variant="secondary" full onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

export default function ImportScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const encoded = searchParams.get("d");
  const fromLink = useMemo(() => (encoded === null ? NOTHING : readLink(encoded)), [encoded]);
  /**
   * Anything the user did here, tagged with the link it was done against. Cancel has to
   * land on the paste box even though the URL still describes the dismissed preview —
   * and a *different* link arriving later must not stay masked by that decision.
   */
  const [override, setOverride] = useState<{ at: string | null; outcome: Outcome } | null>(null);
  const { preview, failure } =
    override !== null && override.at === encoded ? override.outcome : fromLink;

  /**
   * §5.3: the codes this device already holds for the VINs on screen. Read here and not in
   * `runImport`, because the question has to be asked *before* the write — R3-C's point
   * about the unit and notes preview is that a screen which never reads `db.vehicles`
   * cannot show what is about to be lost.
   *
   * Keyed by a joined string rather than the array, which is a new identity every render.
   * `undefined` — the query has not answered, or storage never opened — shows no chooser
   * and changes nothing: the upsert keeps the stored code either way (P7, N1).
   */
  const vinsKey = (preview?.items ?? []).map((item) => item.vin).join(",");
  const storedPaint = useLiveQuery(async () => {
    const vins = vinsKey === "" ? [] : vinsKey.split(",");
    const rows = await db.vehicles.bulkGet(vins);
    const found = new Map<string, string>();
    for (const row of rows) {
      const code = typeof row?.paint === "string" ? row.paint.trim() : "";
      if (row !== undefined && code !== "") found.set(row.vin, code);
    }
    return found;
  }, [vinsKey]);
  const [chosenPaint, setChosenPaint] = useState<Record<string, string>>({});

  function replace(outcome: Outcome): void {
    setOverride({ at: encoded, outcome });
  }

  function fail(title: string, hint: string): void {
    replace({ preview: null, failure: { title, hint } });
  }

  function accept(next: Preview): void {
    replace({ preview: next, failure: null });
  }

  function readPaste(): void {
    const raw = pasted.trim();
    if (raw === "") return;

    let payload: Payload | null;
    try {
      payload = parseCarrier(raw);
    } catch (cause) {
      // A carrier whose body is bad — as opposed to text that is not a carrier at all.
      replace({ preview: null, failure: failureOf(cause) });
      return;
    }

    if (payload !== null) {
      accept({ source: "Pasted link", items: [itemFromPayload(payload, raw)] });
      return;
    }

    // Not a carrier, but §4.9's share text is this app's own format too, so it is parsed
    // rather than mined: "Copy summary" over there has to import here (§6.5), and §4.2
    // cannot read it — step 1 fuses the "VIN" label onto the grouped VIN and R4-A refuses
    // the run that leaves. Same order as the carrier above: our formats first, `extractVin`
    // only for bytes no format claims (D14).
    const summarised = parseShareTextVin(raw);
    if (summarised !== null) {
      accept({ source: "Pasted summary", items: [itemFromVin(summarised, raw)] });
      return;
    }

    // Neither: §4.2 still finds a bare VIN typed here, or one copied with whatever
    // text came along with it.
    const extracted = extractVin(raw);
    if (extracted === null) {
      fail(ERR_NOT_A_CARRIER, HINT_PASTE);
      return;
    }
    accept({ source: "Pasted VIN", items: [itemFromVin(extracted.vin, extracted.raw)] });
  }

  async function readFile(file: File): Promise<void> {
    setBusy(true);
    try {
      let source: string;
      try {
        source = await file.text();
      } catch (cause) {
        fail(`${ERR_FILE_UNREADABLE} ${messageOf(cause)}`, HINT_FILE);
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(source);
      } catch {
        fail(ERR_NOT_JSON, HINT_FILE);
        return;
      }

      const foreign = foreignBundleVersion(parsed);
      if (foreign !== null) {
        fail(
          `That export is VIN Relay version ${foreign}; this app reads version ${PAYLOAD_VERSION}.`,
          HINT_FILE,
        );
        return;
      }

      const bundle = exportBundleSchema.safeParse(parsed);
      if (bundle.success) {
        if (bundle.data.vehicles.length === 0) {
          fail(ERR_EMPTY_BUNDLE, HINT_FILE);
          return;
        }
        accept({ source: file.name, items: bundle.data.vehicles.map(itemFromRecord) });
        return;
      }

      const record = vehicleRecordSchema.safeParse(parsed);
      if (record.success) {
        accept({ source: file.name, items: [itemFromRecord(record.data)] });
        return;
      }

      fail(ERR_NOT_VIN_RELAY, HINT_FILE);
    } finally {
      setBusy(false);
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    // Cleared so picking the same file twice still fires a change.
    event.target.value = "";
    if (file !== undefined) void readFile(file);
  }

  async function runImport(): Promise<void> {
    if (preview === null || busy) return;
    setBusy(true);
    replace({ preview, failure: null });

    const items = preview.items;
    let saved = 0;
    try {
      for (const item of items) {
        await upsertVehicle({
          vin: item.vin,
          origin: "import",
          symbology: "import",
          raw: item.raw,
          checkDigitValid: isCheckDigitValid(item.vin),
          // §4.12: an import may carry an older `at`, and the upsert takes the min and
          // max itself. Absent means "now", which is what a bare VIN deserves.
          ...(item.at === null ? {} : { at: item.at }),
          // Provenance: `by` is the device that sent this, which is what the §5.2 event
          // records. A file record carries no sender.
          deviceLabel: item.by,
          unit: item.unit,
          notes: item.notes,
          // §5.3: this fills an empty field and can never replace a stored code.
          paint: item.paint,
        });
        // The replacement §5.3 asks for a confirmation before making. The user gave it on
        // the chooser above, so it goes through the edit path — the same one the Sheet's
        // own field uses — which is the only path allowed to overwrite a paint code and
        // the one that moves §4.12's LWW clock so the choice survives a sync.
        const stored = paintConflict(item, storedPaint);
        if (stored !== null && item.paint !== null && chosenPaint[item.vin] === item.paint) {
          await setVehicleMeta(item.vin, { paint: item.paint });
        }
        saved += 1;
      }
    } catch (cause) {
      setBusy(false);
      // The preview survives so Import can be tapped again, and it drops what already
      // landed: a retry must not re-count scans for records that are safely stored.
      replace({
        preview: { ...preview, items: items.slice(saved) },
        failure:
          items.length === 1
            ? { title: `That vehicle couldn't be saved. ${messageOf(cause)}`, hint: HINT_SAVE_ONE }
            : {
                title: `Imported ${saved} of ${items.length}. The rest couldn't be saved. ${messageOf(cause)}`,
                hint: HINT_SAVE_MANY,
              },
      });
      return;
    }

    // §9-S3 ends the import the way the scan path ends: upsert, then kick the queue, or
    // the receiving phone reads "Fetching details from NHTSA…" until §5.4's 60 s poll.
    void kickDecodeQueue();
    void navigate(items.length === 1 ? `/v/${items[0].vin}` : "/history");
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 p-4 pb-10">
      <header>
        <h1 className="text-2xl leading-tight font-bold text-fg">Import</h1>
      </header>

      {failure !== null ? (
        <Banner tone="danger" title={failure.title}>
          <p>{failure.hint}</p>
        </Banner>
      ) : null}

      {preview !== null ? (
        <PreviewCard
          preview={preview}
          busy={busy}
          storedPaint={storedPaint}
          chosenPaint={chosenPaint}
          onChoosePaint={(vin, code) => setChosenPaint((prev) => ({ ...prev, [vin]: code }))}
          onImport={() => void runImport()}
          onCancel={() => replace(NOTHING)}
        />
      ) : (
        /* P7: with no preview — first visit or a payload that failed — the ways in stay
           on screen, so a bad link never ends at a blank page. */
        <div className="flex flex-col gap-5">
          <p className="text-base leading-snug text-fg-muted">
            Vehicles shared from another device land here. Open the link someone sent you or scan
            its QR code, paste a link, a VINRELAY1 code, a copied summary or a VIN below, or pick a
            .json file VIN Relay exported.
          </p>

          <section className={`flex flex-col gap-3 p-5 ${PANEL}`}>
            <label htmlFor="import-paste" className={LABEL}>
              Paste a link, code or VIN
            </label>
            <textarea
              id="import-paste"
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              rows={3}
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://…/#/i?d=…"
              className={
                "w-full resize-y rounded-[var(--radius)] border border-border bg-bg px-4 py-3 " +
                "font-vin text-base break-all text-fg placeholder:font-sans placeholder:text-fg-muted"
              }
            />
            <Button
              variant="primary"
              full
              onClick={readPaste}
              disabled={busy || pasted.trim() === ""}
            >
              Preview import
            </Button>
          </section>

          <section className={`flex flex-col gap-3 p-5 ${PANEL}`}>
            <p className={LABEL}>Or open a file</p>
            <p className="text-base leading-snug text-fg-muted">
              A single vehicle, or an export holding many.
            </p>
            {/*
             * The other half of SH-1. Share attaches the record as `text/plain` because
             * Chromium's browser process refuses `application/json` outright, so the file a
             * receiver saves out of a message is `vin-relay-<vin>.txt` — and a picker
             * filtered to `.json` would have hidden the very file this app just sent. What
             * is opened is still read by parsing it (`readFile` below: `file.text()` then
             * `JSON.parse`, never the name or the type), so this widens what can be *chosen*
             * and nothing else: a `.txt` that is not a record still answers §6.4's "That
             * file isn't JSON, so there is nothing to read."
             */}
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json,text/plain,.txt"
              className="hidden"
              onChange={onFileChange}
            />
            <Button
              variant="secondary"
              full
              onClick={() => fileRef.current?.click()}
              disabled={busy}
            >
              {busy ? "Reading…" : "Choose a .json file"}
            </Button>
          </section>
        </div>
      )}
    </div>
  );
}
