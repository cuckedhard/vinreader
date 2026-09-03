/**
 * §4.1 VIN grammar and display grouping. Pure: no DOM, no React, no I/O (P3).
 */

export const VIN_LENGTH = 17;

/** §4.1 alphabet: A–Z and 0–9 excluding I, O and Q. */
export const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

const VIN_CHAR_RE = /^[A-HJ-NPR-Z0-9]$/;

/** Anything outside the §4.1 alphabet separates two runs (§4.2 step 2). */
const SEPARATOR_RE = /[^A-HJ-NPR-Z0-9]+/;

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
