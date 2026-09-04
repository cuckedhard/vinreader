/**
 * §4.9 handoff carrier grammar. Pure: no DOM, no React, no I/O (P3).
 *
 * §6.3 runs every decode result through `extractVin`, which uppercases and strips
 * its input: the base64url body of a carrier becomes a long run of VIN-legal
 * characters, and roughly one 17-character window in eleven passes the check
 * digit by chance (measured: 9.7% of 2000 realistic payloads fabricated a VIN).
 * A QR decodes identically every frame, so the §6.3 two-read rule then confirms
 * the fabrication. Callers test this predicate first and never extract a carrier.
 *
 * The grammar is written once, here, and `codec.ts` reads it through `matchCarrier`
 * (§7 item 5). Two recognisers were kept in step by a comment and drifted: the guard
 * matched `d=` case-insensitively while the parser read it through `URLSearchParams`,
 * so `#/I?D=…` was a carrier to one and a payload-less URL to the other, and the
 * caller dropped it without a word. One match now answers both questions, so a string
 * `isPayloadCarrier` accepts can only be imported or named, never silently discarded.
 */

/** §4.9 text carrier prefix (clipboard, messages) — the only one this app writes. */
export const TEXT_PREFIX = "VINRELAY1:";

/**
 * §4.9 text carrier: `VINRELAY<version>:<base64url>`. Deliberately wider than
 * `TEXT_PREFIX`, which stays v1: recognition is not decoding. A string that names
 * itself as VIN Relay in its first nine characters must reach the §4.9 version check,
 * which says so, rather than `extractVin`, which mines the body — the URL carrier
 * carries no version in its wrapper at all and is answered that way already, and the
 * asymmetry is what let a `VINRELAY2:` payload fabricate a VIN (N2). The payload's own
 * `v` remains the only thing that decides what is readable (P6).
 *
 * Matched case-insensitively — a carrier mangled in transit is no longer decodable,
 * but it still must never reach `extractVin`.
 */
const TEXT_CARRIER_RE = /^VINRELAY\d+:/i;

/**
 * §4.9 URL carrier: `https://<host>/#/i?d=<base64url>`. Scheme and host are
 * ignored — a payload may come from any deployment, and the fragment never
 * reaches a server — so only the fragment is matched, with or without the
 * HashRouter leading slash, and with `d` in any position of the query.
 *
 * `d` is matched case-insensitively along with the route: the fragment is this app's
 * own client-side path, never a server's contract, and a QR generator that uppercases
 * the URL to reach alphanumeric mode is still holding a payload we can read. The body
 * still passes the base64url, version and schema gates, so a loose marker can only
 * yield a valid v1 payload or a named error.
 *
 * Requiring `d=` inside the pattern is also what makes a decode carrying several
 * fragments resolve to the one that has a body rather than to the first `#/i?`. The
 * preceding parameters are skipped one at a time and lazily, so the first `d` wins as
 * it does in a query string, and each skipped chunk ends at the one `&` that can end
 * it — there is no second way to partition a query, so a hostile decode cannot make
 * this backtrack (it runs on every frame, before `extractVin`).
 */
const URL_CARRIER_RE = /#\/?i\?(?:[^#&]*&)*?d=([^#&]*)/i;

/** Which §4.9 carrier this is, and the body exactly as it arrived. */
export interface CarrierMatch {
  kind: "text" | "url";
  body: string;
}

/**
 * The single answer to "is this a §4.9 carrier, and where is its body". `null` means
 * not a carrier at all — a bare VIN, an ordinary URL — which is the only case in which
 * a caller may fall through to `extractVin` (D14). A recognised carrier always yields a
 * body, empty if that is all there is, so the caller always has something to say (P7).
 */
export function matchCarrier(raw: string): CarrierMatch | null {
  const trimmed = raw.trim();

  const text = TEXT_CARRIER_RE.exec(trimmed);
  if (text !== null) return { kind: "text", body: trimmed.slice(text[0].length) };

  const url = URL_CARRIER_RE.exec(trimmed);
  if (url !== null) return { kind: "url", body: url[1] };

  return null;
}

export function isPayloadCarrier(raw: string): boolean {
  return matchCarrier(raw) !== null;
}
