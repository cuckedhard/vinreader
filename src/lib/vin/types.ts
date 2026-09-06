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

/** §4.12 `upsert_vehicle_meta(p_vin, p_unit, p_notes, p_meta_updated_at, p_structural, p_decode)`. */
export type VehicleMetaPayload = {
  p_vin: string;
  p_unit: string | null;
  p_notes: string | null;
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

/** The epoch sentinel for a record whose unit and notes have never been edited (D11). */
export const META_NEVER_EDITED = "1970-01-01T00:00:00.000Z";
