/**
 * Shared types for VIN Relay. Enums are locked by §4.10 and must not drift.
 * This file is pure: no DOM, no React, no I/O (P3).
 */

export type Symbology = "code_39" | "code_128" | "data_matrix" | "qr_code" | "manual" | "import";

export type DecodeStatus = "pending" | "ok" | "partial" | "unsupported" | "failed";

export type ScanState = "idle" | "requesting" | "streaming" | "candidate" | "confirmed" | "error";

export type ScanError = "permission_denied" | "no_camera" | "insecure_context" | "stream_lost";

export type Region = "Africa" | "Asia" | "Europe" | "North America" | "Oceania" | "South America";

export type SyncStatus = "signed_out" | "synced" | "pending" | "syncing" | "offline" | "error";

export type OutboxKind = "scan_event" | "vehicle_meta" | "vehicle_delete";

/** Where a record came from. `cloud` is written only by the S4 pull path (D12). */
export type VehicleOrigin = "scan" | "manual" | "import" | "cloud";

/**
 * §4.4. `candidates` lists only the years that survive the current-year cap,
 * newest last. `resolved` is set when exactly one survives, and stays null
 * while two remain — the UI shows both and never guesses (N2).
 */
export interface ModelYear {
  candidates: number[];
  resolved: number | null;
}

/** §5.1 `structural`. Derived from the 17 characters alone, offline, always. */
export interface VinStructural {
  wmi: string;
  vds: string;
  checkDigit: string;
  checkDigitValid: boolean;
  yearCode: string;
  modelYear: ModelYear;
  plantCode: string;
  serial: string;
  /** null for a position-1 character with no assigned region, i.e. `0` (D06). */
  region: Region | null;
  country: string | null;
  manufacturerFromWmi: string | null;
}

/** §5.1 `decode`. Populated by vPIC in S2; every S0 record is `pending`. */
export interface VehicleDecode {
  status: DecodeStatus;
  source: "nhtsa_vpic";
  fetchedAt: string | null;
  attempts: number;
  lastError: string | null;
  /** Results[0] with empty values removed. */
  fields: Record<string, string>;
}

/**
 * Where a stored paint code's characters came from (S5 layer 2, additive to §5.1).
 * `null` is "this device does not know", never "typed".
 */
export type PaintSource = "typed" | "ocr" | null;

/** §5.1, keyed by `vin`. */
export interface VehicleRecord {
  vin: string;
  structural: VinStructural;
  decode: VehicleDecode;
  unit: string | null;
  notes: string | null;
  /**
   * §4.9 `pc`, the paint code (S5). **Captured, never decoded**: it is not derivable from
   * the 17 characters and NHTSA does not carry it (`vpic/fields.ts` maps no colour key),
   * so a stored value is only ever what a human read off a sticker and confirmed. It has
   * no check digit and no grammar shared across manufacturers — Toyota `1F7`, Honda
   * `NH-731P`, Ford `UG`, VW `LC9X`, GM `WA8555` — so nothing downstream can detect a
   * wrong one, which is why §5.3 keeps the stored value unless the user confirms the
   * replacement and why it is never validated into looking correct (N2).
   *
   * `null` is "nobody has typed one", and it is the value every record starts with. A row
   * written before S5 has no such property at all; `normalizeVehicle` reads that as null
   * on the way in, which is why no Dexie version bump was needed (see `db.ts`).
   */
  paint: string | null;
  /**
   * How the characters in `paint` got there, and what the engine thought of them.
   *
   * **Additive to §5.1** (S5 layer 2). The bootstrap does not name these two fields; they
   * are supplied here and reported to Zach rather than written into §5.1 by an agent. S5
   * addendum §5 requires them — "persist `source: \"ocr\"` and the confidence so nothing
   * downstream mistakes it for a decoded fact" — and layer 1 deliberately left them out
   * because nothing produced an OCR value yet.
   *
   * `"ocr"` means the string is exactly what the engine returned, confirmed by a tap on a
   * control with the characters inside it. `"typed"` means a person put those characters
   * there: the typed field, a per-character correction, or a lookalike they picked off
   * `confusion.ts`'s table after looking at the sticker — in every one of those a human
   * read the glyph, which is the distinction that matters (N2). `null` is a paint code
   * whose provenance this device does not know: a row written before layer 2, or one that
   * arrived over §4.12, whose `upsert_vehicle_meta` RPC has no parameter for it.
   *
   * `paintConfidence` is 0–100 as tesseract reports it, and **null** for anything typed,
   * corrected or arrived-from-elsewhere. It is stored and deliberately not rendered:
   * §13.7 records that there is no corpus of real door-jamb stickers, so the number is
   * uncalibrated for this task, and project rule 6 forbids showing a guess as a fact.
   */
  paintSource: PaintSource;
  paintConfidence: number | null;
  firstScannedAt: string;
  lastScannedAt: string;
  scanCount: number;
  origin: VehicleOrigin;
  /**
   * §4.12 last-writer-wins clock. Epoch until the user edits unit or notes,
   * so a later scan can never outrank a real edit (D11).
   */
  metaUpdatedAt: string;
  deletedAt: string | null;
}

/** §5.2, append-only, keyed by `id`. */
export interface ScanEvent {
  id: string;
  vin: string;
  at: string;
  symbology: Symbology;
  raw: string;
  checkDigitValid: boolean;
  deviceLabel: string | null;
}

/** §5.5, keyed by `wmi`. */
export interface WmiRecord {
  wmi: string;
  manufacturer: string;
  make: string | null;
  source: "seed" | "vpic";
  updatedAt: string;
}

/** §5.6, a single row. */
export interface SettingsRecord {
  id: "settings";
  deviceLabel: string;
  sound: boolean;
  haptics: boolean;
  autoDecode: boolean;
  syncEnabled: boolean;
  uploadPromptDismissed: boolean;
}

/** §5.7 (S4). The table exists from S0 so no migration is needed later. */
export interface OutboxRow {
  id: string;
  kind: OutboxKind;
  vin: string;
  payload: Record<string, unknown>;
  createdAt: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
}

/**
 * §4.12 push payloads (S4). An outbox row stores exactly what its push call takes — a
 * `scan_events` row, or the argument object of `upsert_vehicle_meta` / `delete_vehicle` —
 * so the pusher reshapes nothing and §4.12's locked names live in one place. Every key
 * below is quoted from that skeleton, which is authoritative for names.
 *
 * These are type aliases and not interfaces on purpose: an interface has no implicit
 * index signature, so it would not satisfy `OutboxRow["payload"]`.
 */

/** §4.12 `scan_events`. `user_id` is the push engine's to add; it is the only column here
 * this device cannot know. `raw` (§5.2) has no column and stays on the device (N3). */
export type ScanEventPayload = {
  /** §5.2's event id verbatim — §4.12 makes it the key that makes a push idempotent. */
  id: string;
  vin: string;
  at: string;
  symbology: Symbology;
  check_digit_valid: boolean;
  device_label: string | null;
  /** `not null` in §4.12; §5.2's row does not carry it, so the write captures it here.
   * `cloud` is excluded because the pull path writes no outbox rows (D12). */
  origin: Exclude<VehicleOrigin, "cloud">;
};

/**
 * §4.12 `upsert_vehicle_meta(p_vin, p_unit, p_notes, p_meta_updated_at, p_structural, p_decode)`,
 * plus `p_paint` and `p_paint_known` from `supabase/migrations/0002_paint_code.sql` and
 * `0003_paint_known.sql` (S5). The last two arguments carry defaults, so a build older than S5
 * still lands its queued rows — PostgREST resolves these by name.
 */
export type VehicleMetaPayload = {
  p_vin: string;
  p_unit: string | null;
  p_notes: string | null;
  p_paint: string | null;
  /**
   * "This caller knows the column exists, so `p_paint` is its answer for it — null included,
   * which means clear it." Always true from this build, and typed `true` so it cannot be
   * queued any other way: a null `p_paint` from a build that had never heard of the column
   * used to reach the server's last-writer-wins arm as an answer and erase the account's
   * paint code (S5-1). The flag is what makes those two nulls different, and it is the one
   * thing an older build cannot send.
   */
  p_paint_known: true;
  p_meta_updated_at: string;
  p_structural: VinStructural;
  p_decode: VehicleDecode;
};

/** §4.12 `delete_vehicle(p_vin)`. */
export type VehicleDeletePayload = { p_vin: string };

/** Which payload belongs to which §4.10 `OutboxKind`. */
export type OutboxPayloadByKind = {
  scan_event: ScanEventPayload;
  vehicle_meta: VehicleMetaPayload;
  vehicle_delete: VehicleDeletePayload;
};

/** An outbox row narrowed to one kind — what the push engine reads back. */
export type OutboxRowOf<K extends OutboxKind> = OutboxRow & {
  kind: K;
  payload: OutboxPayloadByKind[K];
};

/** §5.8 (S4), a single row. */
export interface SyncStateRecord {
  id: "cursor";
  vehiclesCursor: string | null;
  eventsCursor: string | null;
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastError: string | null;
}

/** What §4.2 returns. `null` from `extractVin` means NO_VIN. */
export interface ExtractResult {
  vin: string;
  raw: string;
  checkDigitValid: boolean;
}

/**
 * Which branch of §4.2 step 4 refused a read. **Data, never words**: these are the four
 * facts the algorithm has when it returns NO_VIN, and the sentence a user reads is the
 * feature layer's (§6.4). Naming a cause the bytes do not carry — "a part number", "the
 * wrong sticker" — is a guess, and N2 forbids showing one as a fact.
 *
 * - `no_run_of_17` — step 3 found no run of 17 §4.1 characters, so no window exists.
 *   Every character outside the alphabet is a separator (step 2), so `I`, `O`, `Q`, a
 *   hyphen and a space all split a run rather than disqualifying a window: `longestRun`
 *   is what the longest surviving piece actually was. This is the field-report case — a
 *   DYNACRAFT component label whose part number splits into runs of 3, 4 and 9.
 * - `ambiguous` — more than one **distinct** check-digit-valid VIN was found, so step
 *   4(a)'s uniqueness rule refuses rather than ranking them (§4.2, "Why uniqueness and
 *   not precedence"). `validCount` is how many.
 * - `not_whole_run` — exactly one window passes §4.3, and it is not an entire run
 *   (R4-A). The run holds more than one window and the bytes cannot say which of them
 *   was printed.
 * - `no_valid_window` — more than one window exists and none passes §4.3, so step 4(b)'s
 *   "exactly one grammar-valid window" cannot fire either.
 *
 * The four are exclusive and exhaustive over NO_VIN, in that order.
 */
export type NoVinReason = "no_run_of_17" | "ambiguous" | "not_whole_run" | "no_valid_window";

/**
 * A NO_VIN with its reason and the evidence behind it — everything §4.2 held when it
 * refused, and nothing it did not.
 *
 * This channel is **additive**: it reports the decision §4.2 already made and changes no
 * part of it. `extractVin` is a projection of `extractVinExplained`, so there is one
 * implementation of §4.2 and it cannot drift from its own explanation (§7 item 5).
 */
export interface NoVin {
  reason: NoVinReason;
  /** The exact input, unmodified, exactly as `ExtractResult.raw` echoes it back. */
  raw: string;
  /**
   * The longest run §4.2 step 2 produced, after step 1's uppercase and strip; `""` when
   * the text held no §4.1 character at all. First of its length wins a tie, so it is the
   * earliest longest run. Its length is `longestRun.length` and is deliberately not
   * carried a second time (§7 item 5). Unbounded: a pasted payload is unbounded, so a
   * caller that renders this truncates it.
   */
  longestRun: string;
  /** How many grammar-valid 17-character windows step 3 collected, over all runs. */
  windowCount: number;
  /** How many **distinct** VINs among them pass §4.3 (§4.2 step 4(a) counts by VIN). */
  validCount: number;
}

/**
 * §4.2's whole answer: the VIN, or the refusal with its reason. `ok: false` is exactly
 * the `null` that `extractVin` returns — same inputs, same outcomes.
 */
export type ExtractOutcome = { ok: true; result: ExtractResult } | { ok: false; refusal: NoVin };

/** The epoch sentinel for a record whose unit and notes have never been edited (D11). */
export const META_NEVER_EDITED = "1970-01-01T00:00:00.000Z";
