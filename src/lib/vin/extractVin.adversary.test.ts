/**
 * §13.2 adversary tests for §4.2 extraction as the S1 scanner uses it, round 1 of
 * `harden S1`.
 *
 * The characterisation tests marked [A-01] PASS today. They exist because the
 * behaviour they pin is a §4.2 false accept and §4.2 is a §4 constant: no agent may
 * change it (CLAUDE.md rule 2, §13.6 hard stop). They are the repro attached to the
 * NEEDS-ZACH finding, and they fail loudly if §4.2 is ever revised — which is what a
 * decision from Zach would look like.
 */

import { describe, expect, it } from "vitest";

import { expectedCheckDigit } from "./checkDigit";
import { extractVin } from "./extractVin";

const VIN = "1HGCM82633A004352";
const ALPHABET = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";

describe("[A-01] §4.2 step 4a prefers a run-start window over the real VIN", () => {
  /**
   * §4.2 step 4a ranks a window "aligned to a run's start" above every later window.
   * One stray §4.1-legal character in front of the VIN shifts the run by one, and the
   * offset-0 window passes the check digit about one time in thirty-three — so the scanner
   * confirms a 17-character string that is not on the label, with
   * `checkDigitValid: true`. Nothing downstream can tell it from a real read.
   */
  it("returns the straddling window, not the VIN, for a leading B / K / S / 2", () => {
    expect(extractVin(`B${VIN}`)).toEqual({
      vin: "B1HGCM82633A00435",
      raw: `B${VIN}`,
      checkDigitValid: true,
    });
    for (const c of ["B", "K", "S", "2"]) {
      expect(extractVin(`${c}${VIN}`)?.vin).toBe(`${c}${VIN}`.slice(0, 17));
    }
  });

  /**
   * §4.2 step 1 strips whitespace *before* step 2 splits into runs (D05, deliberate),
   * so a multi-field label — a Code 128 carrying `<unit> <VIN>`, or a 2D code with
   * space-separated text — is concatenated into a single run and the same straddling
   * window wins.
   */
  it("does the same when whitespace joined a neighbouring field to the VIN", () => {
    expect(extractVin(`B ${VIN}`)?.vin).toBe("B1HGCM82633A00435");
    // A realistic two-field label: "UNIT B" then the VIN. The `I` splits the run, the
    // newline is stripped, and the surviving run is `TB1HGCM82633A004352` whose
    // offset-0 window passes the check digit — so the record is a VIN nobody printed.
    expect(extractVin(`UNIT B\n${VIN}`)?.vin).toBe("TB1HGCM82633A0043");
    expect(extractVin(`2\t${VIN}`)?.vin).toBe("21HGCM82633A00435");
  });

  it("is a ~3% hazard across random single-field-plus-VIN payloads", () => {
    // Deterministic LCG: the rate is a measurement, not a flake.
    let seed = 12345;
    const rng = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = () => ALPHABET[Math.floor(rng() * ALPHABET.length)];
    let wrong = 0;
    const N = 2000;
    for (let i = 0; i < N; i += 1) {
      let body = "";
      for (let j = 0; j < 17; j += 1) body += pick();
      const vin = body.slice(0, 8) + expectedCheckDigit(body) + body.slice(9);
      let prefix = "";
      for (let j = 0; j < 2 + Math.floor(rng() * 5); j += 1) prefix += pick();
      const result = extractVin(`${prefix} ${vin}`);
      if (result !== null && result.vin !== vin) wrong += 1;
    }
    // Pinned as a range so a §4.2 revision moves it and the ledger notices.
    expect(wrong / N).toBeGreaterThan(0.01);
    expect(wrong / N).toBeLessThan(0.06);
  });

  /**
   * §4.2 step 1 says "Uppercase", and `String.prototype.toUpperCase` maps several
   * non-ASCII characters *into* the §4.1 alphabet: U+017F LATIN SMALL LETTER LONG S
   * becomes `S`, U+00DF becomes `SS`, the `ﬅ` ligature becomes `ST`. A 2D code
   * carrying UTF-8 text can therefore grow a run and trigger the straddle above.
   */
  it("lets toUpperCase manufacture §4.1 characters out of non-ASCII text", () => {
    // U+017F uppercases to a bare ASCII "S", which is a §4.1 character, so the run
    // grows by one and the straddling window wins.
    expect(extractVin(`ſ${VIN}`)?.vin).toBe("S1HGCM82633A00435");
    // U+FB05 uppercases to "ST": two characters, so this VIN's straddle happens to
    // fail the check digit and the run's end wins. The mechanism is the same.
    expect(extractVin(`ﬅ${VIN}`)?.vin).toBe(VIN);
  });
});

describe("adversary — hostile text that must stay NO_VIN", () => {
  it.each([
    ["a combining mark inside the VIN", "1HGCM82633A00435́2"],
    ["a NUL byte inside the VIN", "1HGCM826\u000033A004352"],
    ["fullwidth digits and letters", "１ＨＧCM82633A004352"],
    ["a Turkish dotless i, which uppercases to the excluded I", "ıHGCM82633A004352"],
    ["the Kelvin sign, which is not an ASCII K", "1HGCM82633A00435K"],
    ["sixteen characters", "1HGCM82633A00435"],
    ["an empty string", ""],
  ])("returns NO_VIN for %s", (_name, raw) => {
    expect(extractVin(raw)).toBeNull();
  });

  it("survives an oversized decode without throwing or degrading superlinearly", () => {
    // A QR tops out near 3 kB, but a pasted or crafted payload is unbounded; the
    // window scan must stay linear and must not throw.
    for (const n of [3_000, 300_000]) {
      expect(extractVin("A".repeat(n))).toBeNull();
    }
    expect(extractVin(`${"A".repeat(100_000)} ${VIN}`)).not.toBeNull();
  });

  it("keeps raw byte-for-byte however hostile it was", () => {
    const raw = `  ‏*${VIN}*‎  `;
    expect(extractVin(raw)?.raw).toBe(raw);
  });
});
