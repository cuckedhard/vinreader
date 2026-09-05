/**
 * §13.2 adversary — the D14 guard against a §4.9 carrier damaged in transit.
 *
 * [G2] `carrier.ts` states the requirement in its own words: *"a carrier mangled in
 * transit is no longer decodable, but it still must never reach `extractVin`."* It is not
 * met. `TEXT_CARRIER_RE` only recognises a mangling of the version digit or the case;
 * `URL_CARRIER_RE` needs a literal `#`. Two things that routinely happen to a link on its
 * way between two phones defeat both:
 *
 *   · percent-escaping — `#` becomes `%23` when a link is carried inside another URL's
 *     query, which is what a redirector or a link shortener does (R3-M measured this exact
 *     shape and it is still open);
 *   · fragment stripping — a chat client or preview fetcher that keeps `?d=…` and drops
 *     `#/i`.
 *
 * `matchCarrier` returns null for both, so `ImportScreen.readPaste` falls through
 * `parseCarrier` → `parseShareTextVin` → `extractVin(raw)` (ImportScreen.tsx:338-371) and
 * §4.2 mines the base64url body. `useScanner.readScanResult` has the same fall-through for
 * a re-printed QR.
 *
 * Why §4.2 cannot be the second line of defence here, contrary to what
 * `carrier.adversary.test.ts`'s "belt and braces" case argues from one hand-picked body:
 * a base64url body splits into runs on `-`, `_` and — after step 1 uppercases it — on `I`,
 * `O` and `Q`, so it is ~30 short runs rather than one long one. Whenever exactly one of
 * those runs is exactly 17 characters and no other run is longer, §4.2 step 4(b) returns
 * it. Measured over 20,000 seeded payloads (mulberry32, seed 20260904, per R4-B):
 *
 *     fabricated a VIN            633 / 20,000 = 3.17%   95% CI [2.93%, 3.42%]
 *     of those, check-digit valid  15
 *     saved with NO banner        576 / 20,000 = 2.88%   95% CI [2.66%, 3.12%]
 *
 * The last line is what makes this S1 rather than a refusal. A fabricated window lands a
 * letter in position 9 nine times in ten, so §4.3 `checkDigitApplies` is false, D03's
 * mismatch gate never fires (`useVinCommit.request`), nothing is shown to the user, and
 * the sheet prints §6.4's reassuring *"This number doesn't use a check digit."* over a
 * number no label carries (N2).
 *
 * Deterministic: one literal payload, and one seeded measurement through the repo's single
 * approved generator. No clock, no timers, no `Math.random`.
 */
import { describe, expect, it } from "vitest";
import { checkDigitApplies } from "../vin/checkDigit";
import { extractVin } from "../vin/extractVin";
import { countingRandom } from "../vin/rng.testutil";
import { isPayloadCarrier, matchCarrier } from "./carrier";
import { decodePayload, encodePayload, parseCarrier } from "./codec";
import type { Payload } from "./schema";

/** The §4.11 fixture truck, handed off the way §9-S3 describes. */
const PAYLOAD: Payload = {
  v: 1,
  vin: "1HGCM82633A004352",
  y: "2003",
  mk: "HONDA",
  md: "Accord",
  u: "UNIT-7",
  at: "2026-09-03T14:12:00-08:00",
  by: "Yard truck 12",
};

const BODY = encodePayload(PAYLOAD);

/** What a link shortener or an embedded redirect does to the `#`. */
const PERCENT_ESCAPED = `https://vinrelay.example/%23/i%3Fd%3D${BODY}`;
/** What a chat client that drops fragments leaves behind. */
const FRAGMENT_STRIPPED = `https://vinrelay.example/i?d=${BODY}`;
/** The text carrier with its one separator damaged. */
const SEPARATOR_DAMAGED = `VINRELAY1;${BODY}`;

const MANGLED = [
  ["percent-escaped fragment", PERCENT_ESCAPED],
  ["fragment stripped", FRAGMENT_STRIPPED],
  ["text separator damaged", SEPARATOR_DAMAGED],
] as const;

describe("[G2] a §4.9 carrier damaged in transit is still mined by §4.2", () => {
  it("carries an intact body: only the wrapper is damaged", () => {
    // The evidence that this is a recogniser problem and not a corrupt payload — repair
    // the wrapper and the same bytes decode to the record that was sent.
    expect(decodePayload(BODY)).toEqual(PAYLOAD);
    expect(parseCarrier(`https://vinrelay.example/#/i?d=${BODY}`)).toEqual(PAYLOAD);
  });

  it.each(MANGLED)("refuses to mine a VIN out of a %s carrier", (_name, raw) => {
    // The guard does not fire, so nothing stops §4.2.
    expect(isPayloadCarrier(raw)).toBe(false);
    expect(matchCarrier(raw)).toBeNull();
    // TODAY: { vin: "WWFYZCB0CNVJAYAXM", checkDigitValid: false }. Nothing on the label,
    // nothing in the payload and nothing a human could read off the screen is that number.
    expect(extractVin(raw)).toBeNull();
  });

  it("the fabricated read reaches storage with no banner at all (D03 never fires)", () => {
    const read = extractVin(PERCENT_ESCAPED);
    // Guarded so the assertion below cannot pass by the read having gone away.
    expect(read).not.toBeNull();
    const vin = read?.vin ?? "";
    // §6.3's mismatch banner is gated on `!checkDigitValid && checkDigitApplies(vin)`
    // (`useVinCommit.request`). Position 9 here is a letter, so the second half is false:
    // the write happens straight away, with the success beep and "Got it ✓".
    expect(checkDigitApplies(vin)).toBe(false);
    // The finding, stated as the thing that must not be true.
    expect(read).toBeNull();
  });

  it("fabricates a VIN from ~3% of seeded payloads, nearly all of them silently", () => {
    // 2,000 trials here for suite time; the ledger's 3.17% / 2.88% and their intervals are
    // the same code at 20,000. At this N it measures 76 fabricated, 70 of them silent.
    // R4-B: the one approved generator, so this rate is reproducible and its sample is real.
    const rng = countingRandom(20260904);
    const alphabet = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";
    const makes = ["HONDA", "FORD", "FREIGHTLINER", "INTERNATIONAL", "VOLVO", "CATERPILLAR"];
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(rng.next() * list.length)]!;

    const trials = 2000;
    let fabricated = 0;
    let silent = 0;
    for (let i = 0; i < trials; i += 1) {
      let vin = "";
      for (let c = 0; c < 17; c += 1) vin += pick([...alphabet]);
      const payload: Payload = {
        v: 1,
        vin,
        y: String(1995 + Math.floor(rng.next() * 30)),
        mk: pick(makes),
        md: `Model ${Math.floor(rng.next() * 900)}`,
        u: `UNIT-${Math.floor(rng.next() * 9000)}`,
        at: "2026-09-03T14:12:00-08:00",
        by: `Crew phone ${Math.floor(rng.next() * 99)}`,
      };
      const raw = `https://vinrelay.example/%23/i%3Fd%3D${encodePayload(payload)}`;
      const read = extractVin(raw);
      if (read === null) continue;
      fabricated += 1;
      if (!(read.checkDigitValid === false && checkDigitApplies(read.vin))) silent += 1;
    }
    // A degenerate stream would make the rate meaningless (R4-B), so the sample is pinned.
    expect(rng.distinct()).toBeGreaterThan(trials * 10);
    // §13.6 criterion 4 asks for zero false accepts. This is the same number, off the
    // handoff path rather than the camera path.
    expect({ fabricated, silent }).toEqual({ fabricated: 0, silent: 0 });
  });
});
