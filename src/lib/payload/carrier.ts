/**
 * §4.9 handoff carrier recognition. Pure: no DOM, no React, no I/O (P3).
 *
 * §6.3 runs every decode result through `extractVin`, which uppercases and strips
 * its input: the base64url body of a carrier becomes a long run of VIN-legal
 * characters, and roughly one 17-character window in eleven passes the check
 * digit by chance (measured: 9.7% of 2000 realistic payloads fabricated a VIN).
 * A QR decodes identically every frame, so the §6.3 two-read rule then confirms
 * the fabrication. Callers test this predicate first and never extract a carrier.
 */

/**
 * §4.9 text carrier: `VINRELAY1:<base64url>`. Matched case-insensitively — a
 * carrier mangled in transit is no longer decodable, but it still must never
 * reach `extractVin`.
 */
const TEXT_CARRIER_RE = /^VINRELAY1:/i;

/**
 * §4.9 URL carrier: `https://<host>/#/i?d=<base64url>`. Scheme and host are
 * ignored — a payload may come from any deployment, and the fragment never
 * reaches a server — so only the fragment is matched, with or without the
 * HashRouter leading slash, and with `d` in any position of the query.
 */
const URL_CARRIER_RE = /#\/?i\?(?:[^#]*&)?d=/i;

export function isPayloadCarrier(raw: string): boolean {
  const trimmed = raw.trim();
  return TEXT_CARRIER_RE.test(trimmed) || URL_CARRIER_RE.test(trimmed);
}
