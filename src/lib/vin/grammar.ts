/**
 * §4.1 VIN grammar and display grouping. Pure: no DOM, no React, no I/O (P3).
 */

export const VIN_LENGTH = 17;

/** §4.1 alphabet: A–Z and 0–9 excluding I, O and Q. */
export const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

const VIN_CHAR_RE = /^[A-HJ-NPR-Z0-9]$/;

/** Anything outside the §4.1 alphabet separates two runs (§4.2 step 2). */
const SEPARATOR_RE = /[^A-HJ-NPR-Z0-9]+/;

/** The only characters §4.2 step 1 may touch. */
const ASCII_LOWER_RE = /[a-z]/g;

/**
 * §4.2 step 1, and the single definition of "uppercase" for this app (§7 item 5): map
 * `a`–`z` to `A`–`Z` and leave every other code point exactly as it came in.
 *
 * Never `String.prototype.toUpperCase`. That map is *length-changing* and it maps code
 * points from outside §4.1 **into** §4.1 — `ß`→`SS`, `ﬀ`→`FF`, `ﬁ`→`FI`, `ﬂ`→`FL`,
 * `ﬃ`→`FFI`, `ﬄ`→`FFL`, `ſ`→`S`, and 102 code points in all whose uppercase changes
 * length. Step 1 runs *before* step 2 splits into runs, so a Unicode uppercase invents
 * §4.1 characters the label never carried: `1HGCM82653A0ß352` is 16 characters in two
 * runs of 12 and 3, holding no VIN at any offset, and became the 17-character run
 * `1HGCM82653A0SS352` — a check-digit-valid VIN, returned as fact, past R4-A's whole-run
 * rule because step 1 had built it a run of its own. Ruled by Zach, 2026-09-05, ledger
 * row G1. Applies wherever a VIN is normalised, not only in `extractVin`.
 */
export function asciiUpper(raw: string): string {
  return raw.replace(ASCII_LOWER_RE, (c) => String.fromCharCode(c.charCodeAt(0) - 32));
}

export function isVinGrammarValid(s: string): boolean {
  return VIN_RE.test(s);
}

export function isAllowedVinChar(c: string): boolean {
  return VIN_CHAR_RE.test(c);
}

/**
 * §4.2 step 2. `s` is already uppercased with whitespace and `*` stripped;
 * every remaining character outside the alphabet is a separator.
 */
export function splitRuns(s: string): string[] {
  return s.split(SEPARATOR_RE).filter((run) => run.length > 0);
}

/** §4.1 display grouping: `WMI VDS C Y P SERIAL`. */
export function groupVin(vin: string): string {
  if (vin.length !== VIN_LENGTH) return vin;
  return [
    vin.slice(0, 3),
    vin.slice(3, 8),
    vin.slice(8, 9),
    vin.slice(9, 10),
    vin.slice(10, 11),
    vin.slice(11, 17),
  ].join(" ");
}
