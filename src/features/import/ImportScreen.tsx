/**
 * §6.2 Import — the receiving half of the handoff. Four ways in: a shared link's `?d=`
 * payload, a pasted carrier, summary or bare VIN, a file holding a record or an export
 * bundle, or nothing yet. All land on the same preview, and nothing is written without a
 * tap (§6.4).
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
  summaryFields,
} from "../../lib/payload/codec";
import type { Payload } from "../../lib/payload/schema";
import { exportBundleSchema, vehicleRecordSchema } from "../../lib/payload/schema";
import { parseShareTextVin } from "../../lib/payload/shareText";
import { db } from "../../lib/storage/db";
import { kickDecodeQueue } from "../../lib/storage/decodeQueue";
import { setVehicleMeta, upsertVehicle } from "../../lib/storage/upsert";
import { checkDigitApplies, isCheckDigitValid } from "../../lib/vin/checkDigit";
import { extractVinExplained } from "../../lib/vin/extractVin";
import type { NoVin, PaintSource, VehicleRecord } from "../../lib/vin/types";
import { RefusedRead } from "../../app/RefusedRead";
import { PAINT_LABEL } from "../../app/strings";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { VinDisplay } from "../../ui/VinDisplay";

const PANEL = "rounded-[var(--radius)] border border-border bg-bg-elev";

/**
 * §6.4: *"What the preview says it read, under **From**: Shared link · Pasted link · Pasted
 * summary · Pasted VIN."*
 *
 * The label shipped attached to the wrong value. The provenance was rendered bare, with no
 * label at all, and **From** was spent on the *sender's device label* two rows below — so
 * the one row §6.4 names was unlabelled and the word it names it with described something
 * else. The sender's row keeps its value and takes a label that says what it is.
 */
const SOURCE_LABEL = "From";
const SENDER_LABEL = "Sent by";
const LABEL = "text-sm font-bold tracking-wide text-fg-muted uppercase";

/**
 * §6.4 supplies no import copy, so every line here is written to P7: name what went
 * wrong, never blame the person holding the phone, and always leave a way forward.
 */
const HINT_LINK = "Ask the sender to share it again, or paste the VIN below.";
const HINT_PASTE =
  "A link looks like https://…/#/i?d=…, a code starts with VINRELAY1:, and a VIN is 17 characters.";
/**
 * SH-5, the copy this screen was still contradicting. SH-1 attaches the shared record as
 * `vin-relay-<vin>.txt` because Chromium refuses `application/json` outright, so a receiver
 * holding the file this app just sent them was told, the moment they picked it, to go and
 * find a `.json` — which is the exact turn-away SH-5 was raised to end. It named an
 * extension the app's own Share does not produce, and Download JSON still writes a real
 * `.json`, so the honest line names where the file came from and leaves the shapes to the
 * picker, exactly as the two sentences beside the file button already do.
 */
const HINT_FILE = "Pick a file VIN Relay shared or exported, or paste a link or a VIN instead.";
const HINT_SAVE_ONE = "Tap Import to try again.";
const HINT_SAVE_MANY = "What is left is still listed below. Tap Import to try again.";

const ERR_NOT_A_CARRIER = "That text isn't a VIN Relay link, a VINRELAY1 code, or a VIN.";
const ERR_BAD_VIN = "That payload's VIN isn't 17 valid characters, so there is nothing to save.";
const ERR_NOT_JSON = "That file isn't JSON, so there is nothing to read.";
const ERR_NOT_VIN_RELAY = "That file is JSON, but it isn't a VIN Relay record or export.";
const ERR_EMPTY_BUNDLE = "That export doesn't list any vehicles.";
const ERR_FILE_UNREADABLE = "That file couldn't be read.";

/**
 * The two §4.8-style field labels this screen already renders in `Details`, named once so
 * the preview row and §5.3's chooser below cannot drift apart (§7 item 5). §6.4's preamble
 * puts field labels with the screen's structure rather than its copy, which is why the
 * chooser these head needs no sentence of its own: the label says which field, and the two
 * buttons say the two values and which one wins.
 */
const UNIT_LABEL = "Unit";
const NOTES_LABEL = "Notes";

/**
 * §5.3's paint-code question, in §6.4's voice. §6.4 supplies no line for it, so these are
 * written here and logged under §0 rule 4. The two button labels carry the value *inside*
 * the control the user taps, which is the S5 addendum §5 rule: the reading target and the
 * tap target are the same pixels, so a code cannot be accepted without being read.
 */
const PAINT_CONFLICT_TITLE = "This phone already has a paint code";
const PAINT_CONFLICT_BODY =
  "Nothing can check a paint code, so the import keeps the one already here. Tap the other to use it instead.";
/**
 * The two values, named by where each came from. One pair of words for all three fields
 * §5.3 protects — the unit, the notes and the paint code (R3-C) — because they say where a
 * value came from and nothing about which field it is, which the label above them already
 * says (§7 item 5).
 *
 * They read **Keep** and **Use**, and **Keep** is §6.4's — it answers "Keep the records on
 * this phone?" at sign-out, where §6.4 spells the consequence out precisely because "the
 * words alone do not say what goes". One button word cannot mean two things in one app, and
 * the sign-out one is the spec's.
 *
 * Naming the source rather than the act is also the truer label for what these are: they
 * are `aria-pressed` toggles over one value, not two commands — nothing is written until
 * Import is tapped — and "whose value is this" is the question the user is actually
 * answering, which the verbs only implied.
 */
const ON_THIS_PHONE = "On this phone";
const FROM_THE_SENDER = "From the sender";

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
  /**
   * [F5] §4.9's summary fields, keyed as §4.8's (`summaryFields`). The year, make and model
   * above are what the *preview* says; this is what the *record* is written with, and it is
   * the whole of what §4.9 carries rather than the three the headline needs.
   */
  summary: Record<string, string>;
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
  /**
   * FR-2: the §4.2 refusal behind this failure, where there is one. Only the pasted-text
   * path has one — a `?d=` payload and a file are rejected by the codec or the schema
   * long before §4.2 sees anything, and §6.4 answers those in their own words.
   */
  refusal?: NoVin;
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
    // §4.9: "the payload's summary fields are used immediately so the receiver is useful
    // offline too" — all nine, not just the three the headline reads.
    summary: summaryFields(payload),
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
    summary: {},
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
    // A `.json` record carries the whole §4.8 block it was decoded with, so the file case
    // hands over what it has rather than the nine §4.9 has room for.
    summary: fields,
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
  if (item.unit !== null) rows.push({ label: UNIT_LABEL, value: item.unit });
  // N2: a payload with no paint code shows no paint row, exactly as the sheet shows no
  // empty vPIC row. There is nothing to say, and a dash would look like an answer.
  if (item.paint !== null) rows.push({ label: PAINT_LABEL, value: item.paint });
  const at = item.at === null ? null : formatAt(item.at);
  if (at !== null) rows.push({ label: "Scanned", value: at });
  if (item.by !== null) rows.push({ label: SENDER_LABEL, value: item.by });
  if (item.notes !== null) rows.push({ label: NOTES_LABEL, value: item.notes });
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
 * The two values, as one pair of `aria-pressed` toggles.
 *
 * Each value sits *inside* the control that takes it: the reading target and the tap target
 * are the same pixels, which is the S5 addendum's rule for a paint code and is no less true
 * of a unit or a note. What will happen if the user simply taps Import is the pressed
 * button, because a chooser that showed no state would be a guess about the outcome (N2).
 */
function ChoiceButtons({
  stored,
  incoming,
  chosen,
  mono,
  onChoose,
}: {
  stored: string;
  incoming: string;
  chosen: string;
  /** `--vin-font` for a paint code, which is read out character by character (§6.1). */
  mono?: boolean;
  onChoose: (value: string) => void;
}) {
  const value = `min-w-0 break-words ${mono === true ? "font-vin" : ""}`;
  return (
    <div className="flex flex-wrap gap-3">
      <Button
        variant={chosen === stored ? "primary" : "secondary"}
        aria-pressed={chosen === stored}
        className="max-w-full"
        onClick={() => onChoose(stored)}
      >
        {ON_THIS_PHONE} <span className={value}>{stored}</span>
      </Button>
      <Button
        variant={chosen === incoming ? "primary" : "secondary"}
        aria-pressed={chosen === incoming}
        className="max-w-full"
        onClick={() => onChoose(incoming)}
      >
        {FROM_THE_SENDER} <span className={value}>{incoming}</span>
      </Button>
    </div>
  );
}

/**
 * §5.3's confirmation, for the one field on the record that has no other check.
 *
 * An import may not replace a stored paint code on its own (`upsert.ts`), so this is where
 * the user is asked — before the write, on a screen that already exists to preview it, and
 * never anywhere near the scan path (N1: scanning a §4.9 QR lands here rather than writing
 * a record, so nothing about this question can hold a scan up).
 */
function PaintChoice(props: {
  stored: string;
  incoming: string;
  chosen: string;
  onChoose: (code: string) => void;
}) {
  return (
    <div className={`flex flex-col gap-3 p-4 ${PANEL}`} role="group" aria-label={PAINT_LABEL}>
      <p className="text-base leading-snug font-bold text-fg">{PAINT_CONFLICT_TITLE}</p>
      <p className="text-base leading-snug text-fg-muted">{PAINT_CONFLICT_BODY}</p>
      <ChoiceButtons {...props} mono />
    </div>
  );
}

/**
 * [R3-C] The same confirmation for the unit and the notes, which §5.3 protects in the same
 * sentence and which an import used to replace with nothing said and nothing shown.
 *
 * It adds no sentence. §6.4 has none for this state, and inventing one is not an agent's to
 * do; it does not need one either — the field's own label says which field, the two buttons
 * say the two values and where each came from, and the pressed one says what a plain Import
 * will do. Notes is free text a person typed beside a truck, so it is shown in full and
 * wraps rather than being cut: a truncated value is a value the user cannot recognise.
 */
function FieldChoice({
  label,
  ...props
}: {
  label: string;
  stored: string;
  incoming: string;
  chosen: string;
  onChoose: (value: string) => void;
}) {
  return (
    <div className={`flex flex-col gap-3 p-4 ${PANEL}`} role="group" aria-label={label}>
      <p className={LABEL}>{label}</p>
      <ChoiceButtons {...props} />
    </div>
  );
}

/**
 * The §5.1 fields §5.3 keeps unless the user confirms the overwrite, in the order `Details`
 * above lists them. `field` indexes both the stored record and the incoming item, so a
 * fourth field would be one line here and nowhere else.
 */
type MetaField = "unit" | "paint" | "notes";

const META_FIELDS = [
  { field: "unit", label: UNIT_LABEL },
  { field: "paint", label: PAINT_LABEL },
  { field: "notes", label: NOTES_LABEL },
] as const satisfies readonly { field: MetaField; label: string }[];

/** What this device already holds for one VIN: the values an import could cost it. */
type StoredMeta = Record<MetaField, string | null>;

/** A stored value is something to lose only when it carries text (§5.3, `upsert.ts`). */
function heldValue(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed === "" ? null : trimmed;
}

/**
 * The stored value this import would land on, when the two differ — and null when there is
 * nothing to ask about: no stored value, no incoming one, or the two already agree.
 */
function conflict(
  field: MetaField,
  item: ImportItem,
  stored: Map<string, StoredMeta> | undefined,
): string | null {
  const held = stored?.get(item.vin)?.[field] ?? null;
  const incoming = item[field];
  if (held === null || incoming === null || incoming === held) return null;
  return held;
}

/** Which value the user has picked for one field of one VIN, before anything is written. */
function choiceKey(field: MetaField, vin: string): string {
  return `${field}:${vin}`;
}

/** Every §5.3 question this item raises, or nothing where it raises none. */
function Conflicts({
  item,
  stored,
  chosen,
  onChoose,
}: {
  item: ImportItem;
  stored: Map<string, StoredMeta> | undefined;
  chosen: Record<string, string>;
  onChoose: (field: MetaField, vin: string, value: string) => void;
}) {
  return (
    <>
      {META_FIELDS.map(({ field, label }) => {
        const held = conflict(field, item, stored);
        const incoming = item[field];
        if (held === null || incoming === null) return null;
        // The default is the stored value: keeping what is here needs no tap (§5.3).
        const picked = chosen[choiceKey(field, item.vin)] ?? held;
        const choose = (value: string) => onChoose(field, item.vin, value);
        return field === "paint" ? (
          <PaintChoice
            key={field}
            stored={held}
            incoming={incoming}
            chosen={picked}
            onChoose={choose}
          />
        ) : (
          <FieldChoice
            key={field}
            label={label}
            stored={held}
            incoming={incoming}
            chosen={picked}
            onChoose={choose}
          />
        );
      })}
    </>
  );
}

/**
 * §5.3's confirmed overwrite as a `setVehicleMeta` patch, or null where the user confirmed
 * nothing. That function is the only path allowed to replace a stored value — the same one
 * the Sheet's own fields use — and it is the one that moves §4.12's LWW clock, so a choice
 * made here survives a sync instead of being undone by the next pull.
 *
 * `paintSource: null` is "this device does not know", and it is the whole truth for any of
 * these: the tap said *use the sender's value*, not *I read these characters off a sticker*.
 * §4.9's payload carries no provenance, so letting `setVehicleMeta`'s default call it
 * "typed" would write a sentence onto the record that nothing downstream can contradict
 * (N2, `upsert.ts`).
 */
function confirmedOverwrite(
  item: ImportItem,
  stored: Map<string, StoredMeta> | undefined,
  chosen: Record<string, string>,
): { unit?: string; notes?: string; paint?: string; paintSource?: PaintSource } | null {
  const patch: { unit?: string; notes?: string; paint?: string; paintSource?: PaintSource } = {};
  let confirmed = false;
  for (const { field } of META_FIELDS) {
    const incoming = item[field];
    if (incoming === null || conflict(field, item, stored) === null) continue;
    if (chosen[choiceKey(field, item.vin)] !== incoming) continue;
    patch[field] = incoming;
    confirmed = true;
  }
  if (patch.paint !== undefined) patch.paintSource = null;
  return confirmed ? patch : null;
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
  stored,
  chosen,
  onChoose,
  onImport,
  onCancel,
}: {
  preview: Preview;
  busy: boolean;
  /** What this device already holds, by VIN — read once for the whole preview. */
  stored: Map<string, StoredMeta> | undefined;
  chosen: Record<string, string>;
  onChoose: (field: MetaField, vin: string, value: string) => void;
  onImport: () => void;
  onCancel: () => void;
}) {
  const { items } = preview;
  const single = items.length === 1 ? items[0] : null;
  const headline = single === null ? null : headlineOf(single);
  const mismatches = items.filter((item) => checkDigitMismatch(item.vin)).length;

  return (
    <section className={`flex flex-col gap-4 p-5 ${PANEL}`} aria-labelledby="import-preview">
      <p className={LABEL}>
        {SOURCE_LABEL} {preview.source}
      </p>

      {single !== null ? (
        <>
          {/* §6.4, verbatim shape: "Import 2003 HONDA Accord · 1HG CM826 3 3 A 004352?" */}
          <h2 id="import-preview" className="text-lg leading-snug font-bold text-fg">
            Import{headline === null ? "" : ` ${headline} ·`}{" "}
            <VinDisplay vin={single.vin} size="lg" className="break-words" />?
          </h2>
          <Details item={single} />
          <Conflicts item={single} stored={stored} chosen={chosen} onChoose={onChoose} />
        </>
      ) : (
        <>
          <h2 id="import-preview" className="text-lg leading-snug font-bold text-fg">
            Import {items.length} vehicles?
          </h2>
          <div className="flex flex-col gap-3">
            {items.map((item, index) => (
              <div key={`${index}-${item.vin}`} className="flex flex-col gap-3">
                <PreviewRow item={item} />
                <Conflicts item={item} stored={stored} chosen={chosen} onChoose={onChoose} />
              </div>
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

  /**
   * §5.3: the unit, notes and paint code this device already holds for the VINs on screen.
   * Read here and not in `runImport`, because the question has to be asked *before* the
   * write — R3-C is exactly that: a screen which never reads `db.vehicles` cannot show what
   * is about to be lost, so the preview could not be the confirmation §5.3 means.
   *
   * Keyed by a joined string rather than the array, which is a new identity every render.
   * `undefined` — the query has not answered, or storage never opened — shows no chooser
   * and changes nothing: the upsert keeps the stored values either way (P7, N1).
   */
  const vinsKey = (preview?.items ?? []).map((item) => item.vin).join(",");
  const stored = useLiveQuery(async () => {
    const vins = vinsKey === "" ? [] : vinsKey.split(",");
    const rows = await db.vehicles.bulkGet(vins);
    const found = new Map<string, StoredMeta>();
    for (const row of rows) {
      if (row === undefined) continue;
      found.set(row.vin, {
        unit: heldValue(row.unit),
        paint: heldValue(row.paint),
        notes: heldValue(row.notes),
      });
    }
    return found;
  }, [vinsKey]);
  const [chosen, setChosen] = useState<Record<string, string>>({});

  function replace(outcome: Outcome): void {
    setOverride({ at: encoded, outcome });
  }

  function fail(title: string, hint: string, refusal?: NoVin): void {
    replace({ preview: null, failure: { title, hint, refusal } });
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
    const outcome = extractVinExplained(raw);
    if (!outcome.ok) {
      // FR-2. The title is the one this screen already had, and it is the accurate one
      // here: what was pasted is none of the three shapes this box takes. §6.4's *"That
      // payload's VIN isn't 17 valid characters, so there is nothing to save."* is a
      // different state and stays where it is — it describes a payload, and text that is
      // not a carrier never produced one, so borrowing it would name something that does
      // not exist (N2). What is added underneath is the read itself and §4.2's reason,
      // which is what the user could not see.
      fail(ERR_NOT_A_CARRIER, HINT_PASTE, outcome.refusal);
      return;
    }
    accept({ source: "Pasted VIN", items: [itemFromVin(outcome.result.vin, outcome.result.raw)] });
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
          // §5.3: each of these three fills an empty field and can never replace a stored
          // value. The replacement is the next statement, and only where the user said so.
          unit: item.unit,
          notes: item.notes,
          paint: item.paint,
          // [F5] §4.9: the summary is used immediately, so the receiving phone reads this
          // vehicle by name before it has any signal — and re-shares it that way too.
          summary: item.summary,
        });
        // The replacement §5.3 asks for a confirmation before making. The user gave it on
        // the chooser above, so it goes through the edit path — the same one the Sheet's
        // own fields use — which is the only path allowed to overwrite a stored value and
        // the one that moves §4.12's LWW clock so the choice survives a sync.
        const patch = confirmedOverwrite(item, stored, chosen);
        if (patch !== null) await setVehicleMeta(item.vin, patch);
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
          {/* FR-2: what was read, and why §4.2 would not read a VIN out of it. Above the
              hint, which is about the shapes this box takes rather than about this text. */}
          {failure.refusal === undefined ? (
            <p>{failure.hint}</p>
          ) : (
            <>
              <RefusedRead refusal={failure.refusal} />
              <p className="mt-2">{failure.hint}</p>
            </>
          )}
        </Banner>
      ) : null}

      {preview !== null ? (
        <PreviewCard
          preview={preview}
          busy={busy}
          stored={stored}
          chosen={chosen}
          onChoose={(field, vin, value) =>
            setChosen((prev) => ({ ...prev, [choiceKey(field, vin)]: value }))
          }
          onImport={() => void runImport()}
          onCancel={() => replace(NOTHING)}
        />
      ) : (
        /* P7: with no preview — first visit or a payload that failed — the ways in stay
           on screen, so a bad link never ends at a blank page. */
        <div className="flex flex-col gap-5">
          <p className="text-base leading-snug text-fg-muted">
            Vehicles shared from another device land here. Open the link someone sent you or scan
            its QR code, paste a link, a VINRELAY1 code, a copied summary or a VIN below, or open a
            file VIN Relay shared or exported.
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
            {/*
             * SH-5. This said ".json", and so did the button below it, while SH-1's shared
             * attachment is a `.txt` — so a receiver holding the file this app had just sent
             * them was told by this app that it was the wrong kind. Both shapes are real
             * (Download JSON still writes a genuine `.json`), and the one that matters to the
             * person here is where the file came from, not what it is called, so the copy
             * names the source and leaves extensions to the picker. Supplied under §0 rule 4:
             * §6.4 has no line for either string.
             */}
            <p className="text-base leading-snug text-fg-muted">
              A file VIN Relay shared or exported: one vehicle, or an export holding many.
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
              {busy ? "Reading…" : "Choose a file"}
            </Button>
          </section>
        </div>
      )}
    </div>
  );
}
