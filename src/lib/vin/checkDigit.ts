/**
 * §4.3 check digit (position 9). Constants are copied verbatim from the spec
 * and are never re-derived. Pure: no DOM, no React, no I/O (P3).
 */

import { isVinGrammarValid, VIN_LENGTH } from "./grammar";

/** §4.3 transliteration: letters map to these values, digits are themselves. */
export const TRANSLITERATION: Readonly<Record<string, number>> = {
  A: 1,
  B: 2,
  C: 3,
  D: 4,
  E: 5,
  F: 6,
  G: 7,
  H: 8,
  J: 1,
  K: 2,
  L: 3,
  M: 4,
  N: 5,
  P: 7,
  R: 9,
  S: 2,
  T: 3,
  U: 4,
  V: 5,
  W: 6,
  X: 7,
  Y: 8,
  Z: 9,
  "0": 0,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
};

/** §4.3 weights for positions 1–17. Position 9 weighs 0, so it never feeds its own sum. */
export const CHECK_DIGIT_WEIGHTS: readonly number[] = [
  8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2,
];

/** Position 9, zero-indexed. */
const CHECK_DIGIT_INDEX = 8;

/** §4.3: a check digit can only be 0–9 or X. */
const CHECK_CHAR_RE = /^[0-9X]$/;

export function transliterate(c: string): number {
  const value: number | undefined = TRANSLITERATION[c];
  if (value === undefined) {
    throw new RangeError(`transliterate: ${JSON.stringify(c)} is not a §4.1 VIN character`);
  }
  return value;
}

export function checkDigitSum(vin: string): number {
  if (vin.length !== VIN_LENGTH) {
    throw new RangeError(`checkDigitSum: expected ${VIN_LENGTH} characters, got ${vin.length}`);
  }
  let sum = 0;
  for (let i = 0; i < VIN_LENGTH; i += 1) {
    sum += transliterate(vin[i]) * CHECK_DIGIT_WEIGHTS[i];
  }
  return sum;
}

export function expectedCheckDigit(vin: string): string {
  const remainder = checkDigitSum(vin) % 11;
  return remainder === 10 ? "X" : String(remainder);
}

/**
 * A predicate on candidate reads (§6.3), so a string that is not grammar-valid
 * is simply invalid rather than an exception.
 */
export function isCheckDigitValid(vin: string): boolean {
  if (!isVinGrammarValid(vin)) return false;
  return vin[CHECK_DIGIT_INDEX] === expectedCheckDigit(vin);
}

/**
 * §4.3 / D17. A letter other than X at position 9 means the identifier carries
 * no ISO 3779 check digit, so a mismatch says nothing about the read.
 */
export function checkDigitApplies(vin: string): boolean {
  return CHECK_CHAR_RE.test(vin.charAt(CHECK_DIGIT_INDEX));
}
