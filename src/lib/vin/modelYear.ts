/**
 * §4.4 model year (position 10). Pure (P3): the current year is always an argument,
 * never read from a clock, so every result is deterministic.
 */
import type { ModelYear } from "./types";

/** §4.4, verbatim. Position-10 code → [1980–2009 candidate, 2010–2039 candidate]. */
export const MODEL_YEAR_CODES: Readonly<Record<string, readonly [number, number]>> = {
  A: [1980, 2010],
  B: [1981, 2011],
  C: [1982, 2012],
  D: [1983, 2013],
  E: [1984, 2014],
  F: [1985, 2015],
  G: [1986, 2016],
  H: [1987, 2017],
  J: [1988, 2018],
  K: [1989, 2019],
  L: [1990, 2020],
  M: [1991, 2021],
  N: [1992, 2022],
  P: [1993, 2023],
  R: [1994, 2024],
  S: [1995, 2025],
  T: [1996, 2026],
  V: [1997, 2027],
  W: [1998, 2028],
  X: [1999, 2029],
  Y: [2000, 2030],
  "1": [2001, 2031],
  "2": [2002, 2032],
  "3": [2003, 2033],
  "4": [2004, 2034],
  "5": [2005, 2035],
  "6": [2006, 2036],
  "7": [2007, 2037],
  "8": [2008, 2038],
  "9": [2009, 2039],
};

const IS_LETTER = /^[A-Z]$/;

/** True only for the 30 codes in §4.4. `I O Q U Z 0` and anything else are invalid. */
export function isValidYearCode(code: string): boolean {
  return Object.hasOwn(MODEL_YEAR_CODES, code);
}

export function modelYearFromVin(vin: string, currentYear: number): ModelYear {
  const code = vin[9];
  // No year at all rather than a guess (N2); the sheet omits the row.
  if (!isValidYearCode(code)) return { candidates: [], resolved: null };

  const [early, late] = MODEL_YEAR_CODES[code];

  // §4.4 step 0, applied before either branch and to both candidates.
  const candidates = [early, late].filter((year) => year <= currentYear + 1);
  if (candidates.length < 2) {
    // Only the early candidate can be the lone survivor, and it is then certain
    // whatever position 7 holds. Neither survives only for a `currentYear` before
    // the cycle starts, which leaves no year to show.
    return { candidates, resolved: candidates.length === 1 ? early : null };
  }

  // §4.4 steps 1 and 2. A letter in position 7 fixes the late candidate. A digit
  // indicates 1980–2009 for light-duty vehicles only; on the heavy trucks and
  // equipment this app scans it proves nothing, so both years stand until vPIC
  // resolves the year.
  return { candidates, resolved: IS_LETTER.test(vin[6]) ? late : null };
}
