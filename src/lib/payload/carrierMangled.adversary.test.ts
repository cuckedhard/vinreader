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
 *
 * CLOSED. The fix is in the recogniser and nowhere else (`carrier.ts`): `TEXT_CARRIER_RE`
 * takes any separator a base64url body cannot begin with, `URL_CARRIER_RE` anchors on the
 * `/i` path segment as well as on `#`, and `matchCarrier` asks the grammar a second time
 * with the percent-escapes undone. §4.2 and §4.9 are both unchanged — the escaped and
 * stripped links now decode to the record that was sent, and nothing on this path hands a
 * base64url body to `extractVin`. Every assertion below that used to pin the defect now
 * pins its absence, and the one that records what §4.2 still does is marked as such.
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

/**
 * The D14 order, as both callers run it: `useScanner.readScanResult` and
 * `ImportScreen.readPaste` ask the §4.9 guard first and only hand `extractVin` what it
 * refuses. The finding is stated over this pipeline and not over `extractVin` alone,
 * because §4.2 is a §4 constant and is not what was wrong: `extractVin` mines any long run
 * of §4.1-legal characters by design, which is exactly why D14 puts the guard in front of
 * it. A VIN out of here is a fabricated VIN; there is no other way for one to come out.
 */
function readAsCaller(raw: string): "carrier" | "vin" | "nothing" {
  if (isPayloadCarrier(raw)) return "carrier";
  return extractVin(raw) === null ? "nothing" : "vin";
}

describe("[G2] a §4.9 carrier damaged in transit no longer reaches §4.2", () => {
  it("carries an intact body: only the wrapper is damaged", () => {
    // The evidence that this is a recogniser problem and not a corrupt payload — repair
    // the wrapper and the same bytes decode to the record that was sent.
    expect(decodePayload(BODY)).toEqual(PAYLOAD);
    expect(parseCarrier(`https://vinrelay.example/#/i?d=${BODY}`)).toEqual(PAYLOAD);
  });

  it.each(MANGLED)("refuses to mine a VIN out of a %s carrier", (_name, raw) => {
    // WAS: false, null, and a VIN — the guard did not fire, so nothing stopped §4.2.
    expect(isPayloadCarrier(raw)).toBe(true);
    expect(matchCarrier(raw)).not.toBeNull();
    expect(readAsCaller(raw)).toBe("carrier");
    // The wrapper is damaged and the body is not, so all three even import: the damage
    // §4.9 cares about is to the body, and the version check owns the rest (P6).
    expect(parseCarrier(raw)).toEqual(PAYLOAD);
  });

  it("keeps the guard load-bearing: §4.2 still mines the body if anything asks it", () => {
    // WHY THE FIX IS IN THE GUARD, kept executable. §4.2 is authoritative (CLAUDE.md rule
    // 2) and untouched by this finding: asked directly, `extractVin` still returns a VIN
    // for the percent-escaped carrier, and it is a number no label carries (N2).
    const mined = extractVin(PERCENT_ESCAPED);
    expect(mined?.vin).toBe("WWFYZCB0CNVJAYAXM");
    // And it would have arrived with no banner at all. §6.3's mismatch banner is gated on
    // `!checkDigitValid && checkDigitApplies(vin)` (`useVinCommit.request`); position 9 is
    // a letter, so the second half is false and the write happens straight away, with the
    // success beep and "Got it ✓". Nothing else downstream would have said a word — which
    // is why the recogniser, not a banner, is where this had to be fixed.
    expect(checkDigitApplies(mined?.vin ?? "")).toBe(false);
    // The finding, stated as the thing that must not be true: no caller asks.
    expect(readAsCaller(PERCENT_ESCAPED)).not.toBe("vin");
  });

  it("still reads a VIN off text that only looks like a carrier", () => {
    // The cost of the widening, bounded. A line carrying a `%` that is not an escape still
    // reaches §4.2 and still reads: `matchCarrier` asks `decodeURIComponent` about every
    // string that is not already a carrier, and a throw there may not cost a read.
    expect(readAsCaller("100% 1HGCM82633A004352")).toBe("vin");
    // The text prefix ahead of a VIN is a human writing a sentence, so the separator is
    // required and whitespace is not one: this stays a non-carrier. (§4.2 then refuses it
    // for its own reasons — step 1 strips the space and R4-A refuses the fused run.)
    expect(isPayloadCarrier("VINRELAY1 1HGCM82633A004352")).toBe(false);
    // And the route is still a route: a `d` parameter somewhere else in an ordinary URL
    // does not make one. (What §4.2 does with a base64url body it is handed directly is
    // the standing §4.2 hazard `carrier.ts` documents, and is not this finding.)
    expect(isPayloadCarrier(`https://example.com/parts?id=99&d=${BODY}`)).toBe(false);
    expect(readAsCaller("https://example.com/parts?id=99")).toBe("nothing");
  });

  it("fabricates a VIN from none of 2,000 seeded payloads, and imports every one", () => {
    // 2,000 trials here for suite time; the ledger's 3.17% / 2.88% and their intervals are
    // the same code at 20,000. WAS, through `extractVin` alone at this N: 76 fabricated, 70
    // of them silent. Now the guard answers first, as both callers do, and the count is the
    // §13.6 criterion-4 zero. The two counters below are what keeps that zero honest — a
    // recogniser that stopped recognising, or a generator that degenerated (R4-B), would
    // reach zero fabrications too, and `recognised`/`imported` would not follow it.
    const rng = countingRandom(20260904);
    const alphabet = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";
    const makes = ["HONDA", "FORD", "FREIGHTLINER", "INTERNATIONAL", "VOLVO", "CATERPILLAR"];
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(rng.next() * list.length)]!;

    const trials = 2000;
    let fabricated = 0;
    let silent = 0;
    let recognised = 0;
    let imported = 0;
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
      if (isPayloadCarrier(raw)) {
        recognised += 1;
        if (parseCarrier(raw)?.vin === vin) imported += 1;
        continue;
      }
      const read = extractVin(raw);
      if (read === null) continue;
      fabricated += 1;
      if (!(read.checkDigitValid === false && checkDigitApplies(read.vin))) silent += 1;
    }
    // A degenerate stream would make the rate meaningless (R4-B), so the sample is pinned.
    expect(rng.distinct()).toBeGreaterThan(trials * 10);
    // §13.6 criterion 4 asks for zero false accepts. This is the same number, off the
    // handoff path rather than the camera path — and every one of those 2,000 mangled
    // links now hands over the VIN that was actually sent instead.
    expect({ fabricated, silent, recognised, imported }).toEqual({
      fabricated: 0,
      silent: 0,
      recognised: trials,
      imported: trials,
    });
  });
});
