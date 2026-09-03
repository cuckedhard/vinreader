/**
 * §5 Dexie schema. The database name is fixed at "vinrelay" and never tracks the
 * product's display name (D01), so a later rename cannot orphan stored data.
 */
import Dexie, { type EntityTable } from "dexie";
import type {
  OutboxRow,
  ScanEvent,
  SettingsRecord,
  SyncStateRecord,
  VehicleRecord,
  WmiRecord,
} from "../vin/types";

export type VinRelayDb = Dexie & {
  vehicles: EntityTable<VehicleRecord, "vin">;
  scanEvents: EntityTable<ScanEvent, "id">;
  wmi: EntityTable<WmiRecord, "wmi">;
  settings: EntityTable<SettingsRecord, "id">;
  outbox: EntityTable<OutboxRow, "id">;
  syncState: EntityTable<SyncStateRecord, "id">;
};

export const db = new Dexie("vinrelay") as VinRelayDb;

/**
 * `outbox` and `syncState` are S4 tables (§5.7, §5.8) declared in version 1, so S4
 * adds no migration.
 *
 * IndexedDB does not index null, so every live record — `deletedAt: null` — is absent
 * from the `deletedAt` index. "Not deleted" is therefore filtered in JS and never
 * queried through that index; the index finds tombstones, not survivors.
 */
db.version(1).stores({
  vehicles: "vin, lastScannedAt, unit, decode.status, deletedAt",
  scanEvents: "id, vin, at",
  wmi: "wmi",
  settings: "id",
  outbox: "id, createdAt, kind",
  syncState: "id",
});

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/**
 * §5.1 timestamps are ISO 8601 **with offset**; `toISOString()` would give UTC with a
 * `Z`. Offset strings are not lexicographically ordered across time zones, so compare
 * two of them by `Date.parse`, never by `<`.
 */
export function nowIso(): string {
  const date = new Date();
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
  return `${day}T${time}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
