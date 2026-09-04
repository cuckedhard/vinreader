/**
 * §4.9 handoff payload codec: compact JSON → UTF-8 → base64url, no padding.
 * Pure: no DOM, no React, no I/O, no clock (P3) — the host and the device label
 * arrive as arguments.
 *
 * `btoa` / `atob` / `TextEncoder` / `TextDecoder` are the WHATWG globals: present in
 * every browser the app targets and in Node, so the same code runs under Vitest.
 */

import type { VehicleRecord } from "../vin/types";
import type { CarrierMatch } from "./carrier";
import { TEXT_PREFIX, matchCarrier } from "./carrier";
import type { Payload } from "./schema";
import { PAYLOAD_VERSION, payloadSchema } from "./schema";

export { PAYLOAD_VERSION, TEXT_PREFIX };

/** §4.9 hard cap, measured on the whole URL in **bytes**. */
export const MAX_URL_BYTES = 700;

/** §4.9 drop order. Never `vin`, `v`, `y`, `mk` or `md`. */
export const DROP_ORDER = ["n", "en", "dr", "fu", "bc", "tr", "gv"] as const;

export type PayloadErrorKind = "encoding" | "schema" | "version" | "empty";

/** Every rejection is one of these; nothing here throws a platform error (P6). */
export class PayloadError extends Error {
  readonly kind: PayloadErrorKind;

  constructor(kind: PayloadErrorKind, message: string) {
    super(message);
    this.name = "PayloadError";
    this.kind = kind;
  }
}

/** The §4.9 keys that may be dropped, i.e. everything but `v` and `vin`. */
type OptionalKey = Exclude<keyof Payload, "v" | "vin">;

/** §4.9: `y mk md tr bc en fu dr gv` mirror these §4.8 vPIC keys, in sheet order. */
const SUMMARY_KEYS = [
  ["y", "ModelYear"],
  ["mk", "Make"],
  ["md", "Model"],
  ["tr", "Trim"],
  ["bc", "BodyClass"],
  ["en", "EngineModel"],
  ["fu", "FuelTypePrimary"],
  ["dr", "DriveType"],
  ["gv", "GVWR"],
] as const satisfies readonly (readonly [OptionalKey, string])[];

/**
 * Sets a key only when it carries text. §4.9's example shows an empty `"tr"`, but an
 * empty string spends bytes against the 700-byte cap and renders as nothing on the
 * receiver either way, so an absent value stays absent.
 */
function put(payload: Payload, key: OptionalKey, value: string | null | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) payload[key] = trimmed;
}

export function payloadFromRecord(record: VehicleRecord, deviceLabel: string | null): Payload {
  const payload: Payload = { v: PAYLOAD_VERSION, vin: record.vin };
  for (const [key, field] of SUMMARY_KEYS) put(payload, key, record.decode.fields[field]);

  // N2: with no decoded ModelYear the structural year stands in, but only once it has
  // resolved — two surviving candidates (§4.4) are never narrowed to one here.
  if (payload.y === undefined && record.structural.modelYear.resolved !== null) {
    payload.y = String(record.structural.modelYear.resolved);
  }

  put(payload, "at", record.lastScannedAt);
  put(payload, "u", record.unit);
  put(payload, "n", record.notes);
  put(payload, "by", deviceLabel);
  return payload;
}

export function encodePayload(payload: Payload): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
}

export function decodePayload(encoded: string): Payload {
  const body = encoded.trim();
  if (body.length === 0) throw new PayloadError("empty", "This link carries no payload.");

  const json = base64UrlDecodeToString(body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new PayloadError("encoding", "This link's payload is not readable.");
  }

  // Checked before the schema so a future version is named as one rather than
  // reported as a pile of field errors (P6).
  const version = readVersion(parsed);
  if (version !== undefined && version !== PAYLOAD_VERSION) {
    throw new PayloadError(
      "version",
      `This payload is version ${describe(version)}; this app reads version ${PAYLOAD_VERSION}.`,
    );
  }

  const result = payloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new PayloadError(
      "schema",
      `This payload is not a VIN Relay record: ${summarize(result.error)}`,
    );
  }
  return result.data;
}

export function buildPayloadUrl(
  payload: Payload,
  origin: string,
): { url: string; dropped: string[] } {
  const kept: Payload = { ...payload };
  const dropped: string[] = [];
  let url = payloadUrl(kept, origin);

  for (const key of DROP_ORDER) {
    if (byteLength(url) <= MAX_URL_BYTES) break;
    if (kept[key] === undefined) continue;
    delete kept[key];
    dropped.push(key);
    url = payloadUrl(kept, origin);
  }

  // §4.9 leaves this case open: with every droppable field gone a very long `u`, `by`
  // or host can still exceed the cap. The long URL is returned as it is — dropping
  // `vin`, `v`, `y`, `mk` or `md` is forbidden, and a truncated VIN is worse than a
  // dense QR. `dropped` lets the caller say what was left out.
  return { url, dropped };
}

export function buildTextCarrier(payload: Payload): string {
  // Uncapped by design: §4.9 caps the URL, which is what a QR has to hold. Clipboard
  // text has no such limit, so the full record travels when it can.
  return `${TEXT_PREFIX}${encodePayload(payload)}`;
}

const WHITESPACE_RE = /\s+/g;

/**
 * Returns null when `raw` is not a carrier at all — a bare VIN, an ordinary URL — and
 * throws `PayloadError` when it is a carrier whose body is bad. The caller treats those
 * differently: one falls through to the other import paths, the other is an error to show.
 *
 * `matchCarrier` is the same question `isPayloadCarrier` asks (§7 item 5), so null here
 * means the D14 guard said no too: nothing the guard accepts can be dropped in silence.
 */
export function parseCarrier(raw: string): Payload | null {
  const match = matchCarrier(raw);
  if (match === null) return null;
  return decodePayload(unwrap(match));
}

/**
 * A pasted link can arrive line-wrapped; no whitespace is ever part of a body. A URL
 * carrier can also arrive percent-escaped, and base64url has no `%`, so an escape that
 * will not decode is a damaged body rather than a different encoding — it is passed on
 * as it stands and named by the base64url guard instead of being swallowed here (P7).
 */
function unwrap({ kind, body }: CarrierMatch): string {
  const decoded = kind === "url" ? percentDecoded(body) : body;
  return decoded.replace(WHITESPACE_RE, "");
}

function percentDecoded(body: string): string {
  try {
    return decodeURIComponent(body);
  } catch {
    return body;
  }
}

function payloadUrl(payload: Payload, origin: string): string {
  return `${baseUrl(origin)}#/i?d=${encodePayload(payload)}`;
}

/**
 * §4.9 writes the carrier as `https://<host>/#/i?d=…`. Callers pass what the host hands
 * them: `location.origin` already carries a scheme, a bare host does not, and a
 * deployment under a sub-path carries a trailing slash that has to survive.
 */
function baseUrl(origin: string): string {
  const trimmed = origin.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.endsWith("/") ? withScheme : `${withScheme}/`;
}

/** §4.9 caps bytes, not characters: a non-ASCII host makes the two differ. */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function readVersion(parsed: unknown): unknown {
  if (typeof parsed !== "object" || parsed === null || !("v" in parsed)) return undefined;
  return (parsed as { v: unknown }).v;
}

function describe(version: unknown): string {
  return typeof version === "number" ? String(version) : JSON.stringify(version);
}

function summarize(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "payload"} ${issue.message}`)
    .join("; ");
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  // Chunked rather than spread: `String.fromCharCode(...bytes)` overflows the call
  // stack on a long payload, and export bundles are not capped at 700 bytes.
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecodeToString(body: string): string {
  if (!BASE64URL_RE.test(body)) {
    throw new PayloadError("encoding", "This link's payload is not readable.");
  }
  // No encoder can leave a single trailing base64 character, so a length of 1 mod 4 is
  // a truncated body. Named here because `atob` would throw an opaque DOMException.
  if (body.length % 4 === 1) {
    throw new PayloadError("encoding", "This link's payload is cut off.");
  }

  try {
    const binary = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    // `fatal` so bytes that are not UTF-8 are rejected rather than quietly turned into
    // replacement characters and stored as a record.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // The two guards above leave `atob` nothing to reject, so this is the not-UTF-8
    // case — and it keeps any platform difference from escaping as a DOMException (P6).
    throw new PayloadError("encoding", "This link's payload is not readable.");
  }
}
