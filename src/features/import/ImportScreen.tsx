/**
 * §6.2 Import — the receiving half of the handoff. Four ways in: a shared link's `?d=`
 * payload, a pasted carrier, summary or bare VIN, a `.json` record or export bundle, or
 * nothing yet. All land on the same preview, and nothing is written without a tap (§6.4).
 */
import { useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
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
import { kickDecodeQueue } from "../../lib/storage/decodeQueue";
import { upsertVehicle } from "../../lib/storage/upsert";
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

function PreviewRow({ item }: { item: ImportItem }) {
  const headline = headlineOf(item);
  return (
    <div className="flex flex-col gap-1 border-t border-border pt-3">
      {headline !== null ? (
        <p className="text-base leading-tight font-bold text-fg">{headline}</p>
      ) : null}
      <VinDisplay vin={item.vin} size="md" className="block break-words" />
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
  onImport,
  onCancel,
}: {
  preview: Preview;
  busy: boolean;
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
            <VinDisplay vin={single.vin} size="md" className="break-words" />?
          </h2>
          <Details item={single} />
        </>
      ) : (
        <>
          <h2 id="import-preview" className="text-lg leading-snug font-bold text-fg">
            Import {items.length} vehicles?
          </h2>
          <div className="flex flex-col gap-3">
            {items.map((item, index) => (
              <PreviewRow key={`${index}-${item.vin}`} item={item} />
            ))}
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
        });
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
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
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
