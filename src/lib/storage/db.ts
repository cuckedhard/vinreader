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
 * adds no migration: S4 needed no column and no index beyond what §5.7 and §5.8 already
 * name here, and this declaration has not changed since the first S0 commit, so no
 * installed database can be missing either store. `outbox.test.ts` opens a database
 * written by an earlier run and proves the records survive; a later version() must keep
 * that test passing.
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

/**
 * The client-generated UUID every row that carries one gets: §5.2's scan events and
 * §5.7's outbox rows. It lives beside `nowIso` because those two stamps are what a local
 * row is given at birth, and because §7 item 5 allows exactly one generator (S4 moved it
 * here from `upsert.ts` rather than writing a second).
 *
 * `crypto.randomUUID` is `[SecureContext]`, so over plain http it is `undefined` — and
 * that origin is one the app is built for: §6.3 routes an insecure context to
 * `error(insecure_context)`, and the keyboard §6.4 sends the user to writes through the
 * upsert. `getRandomValues` carries no such gate, so the fallback is a v4 built from it
 * rather than a weaker id shape; `Math.random` is the last resort for a runtime with no
 * `crypto` at all. The shape is not cosmetic: §5.2 is append-only and S4 pushes these ids
 * as the primary key that makes a push idempotent (§4.12), so they must not collide.
 */
export function newId(): string {
  const webCrypto: Crypto | undefined = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof webCrypto?.getRandomValues === "function") {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // RFC 4122 version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant 10xx
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * [G4] The year §4.4 step 0 caps against: the device clock, floored at the year this build
 * was made (`__BUILD_YEAR__`, from `scripts/build-year.ts`).
 *
 * §4.4 takes the current year as an explicit argument and never reads a clock inside
 * itself, so this is where the argument is decided, once, for every caller (§7 item 5) —
 * `upsertVehicle`, `normalizeVehicle` on the Sheet and History, the §4.12 pull and the
 * account's "add these local records".
 *
 * A bare `new Date().getFullYear()` is not the current year, it is what the clock says,
 * and the two part company on exactly the phones this app is for: an Android that lost its
 * RTC, a handset left flat in the cold, a factory reset with no signal to fetch time from.
 * §4.4 step 0 drops "any candidate greater than the current year + 1" so that a *future*
 * year is never shown; hand it a clock reading 2016 and it drops the real year instead.
 * `1FUJGLDR0PLBT1234` — position 10 `P`, position 7 a letter — is a 2023 truck on any
 * correct clock and resolved to **1993** on that phone: one year, stated as certain, no
 * "1993 or 2023", wrong by thirty years while the user stands next to the truck (N2). It
 * was written to the §5.1 record and queued in §5.7's `vehicle_meta` as well.
 *
 * The device cannot learn the date offline, but it cannot be running before it was built,
 * so the build year is a lower bound on "now" that no clock can drag below. Flooring at it
 * makes a stale clock behave exactly as a correct one, and it can never do the opposite:
 * `Math.max` only ever moves the year up, so a clock that is correct — or ahead of the
 * build, which is every device after the build's own year — is used unchanged and the cap
 * still refuses a genuinely future candidate. Nothing in §4.4 moved; this is the argument
 * §4.4 asked its caller for.
 */
export function currentYear(): number {
  return Math.max(new Date().getFullYear(), __BUILD_YEAR__);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/**
 * [F6] The instant the last stamp named, so the next one can be later than it.
 *
 * A device clock has millisecond resolution, and two writes the user made in sequence —
 * a delete and the re-scan right after it — regularly land inside one of them. Every §4.12
 * comparison over these stamps is strict: `merge.ts` resurrects a tombstoned record only
 * on a scan STRICTLY newer than the delete, and `dueRows` drains the outbox oldest-first
 * with equal `createdAt` broken by the row's random UUID, which is to say not broken at
 * all. A tie there is a truck that came back through the gate and stayed deleted, about a
 * quarter of the time (ledger F6, and its cost is a §13.5 gate that goes red at random).
 *
 * §4.12 is what must not move, so what moves is the clock this side of it. This does not
 * make the stamp untrue: the correction is one millisecond per collision, applied only when
 * the clock has not advanced since the last stamp, and a device that is stamping faster
 * than its own clock ticks cannot say which millisecond it meant anyway.
 */
let lastStampedMs = Number.NEGATIVE_INFINITY;

/**
 * §5.1 timestamps are ISO 8601 **with offset**; `toISOString()` would give UTC with a
 * `Z`. Offset strings are not lexicographically ordered across time zones, so compare
 * two of them by `Date.parse`, never by `<`.
 *
 * Strictly increasing within a session, per `lastStampedMs` above.
 */
export function nowIso(): string {
  const reading = new Date();
  const readingMs = reading.getTime();
  const stampMs = readingMs > lastStampedMs ? readingMs : lastStampedMs + 1;
  lastStampedMs = stampMs;
  // The reading itself whenever the clock had moved, which is every call but the collisions.
  const date = stampMs === readingMs ? reading : new Date(stampMs);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
  return `${day}T${time}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
