/**
 * §13.2 adversary, round 3 of `harden S1`. The D14 guard, attacked at its edges.
 *
 * The scanner runs `isPayloadCarrier` (carrier.ts) before `extractVin`, and hands whatever
 * it accepts to `parseCarrier` (codec.ts). Those are two independently written recognisers
 * for one §4.9 grammar, and the scan screen's behaviour depends on them agreeing:
 *
 *   isPayloadCarrier false → the text goes to `extractVin`, which mines any long run of
 *                            §4.1-legal characters — and a base64url body is exactly that.
 *   isPayloadCarrier true  → `parseCarrier` navigates to Import, throws (banner), or
 *                            returns null, in which case ScanScreen.handleCarrier drops it
 *                            in silence (ScanScreen.tsx:38) and the camera keeps running
 *                            at a code that will never resolve — the R2-D symptom.
 *
 * Pure modules only, no clock, no randomness that is not seeded here.
 *
 * Findings: [R3-C] and [R3-D]. Both are CLOSED — R3-F and R3-M put one §4.9 grammar
 * behind both recognisers and taught it every version (bf95090), and ledger Z6 then
 * narrowed §4.2 step 4(a) underneath. The tests below are the regression guard for both,
 * and each keeps the behaviour it used to pin, so a return is legible when it comes.
 */
import { describe, expect, it } from "vitest";
import { isPayloadCarrier } from "./carrier";
import {
  PayloadError,
  buildPayloadUrl,
  buildTextCarrier,
  parseCarrier,
  TEXT_PREFIX,
} from "./codec";
import type { Payload } from "./schema";
import { isCheckDigitValid } from "../vin/checkDigit";
import { extractVin } from "../vin/extractVin";

const ORIGIN = "https://vinrelay.example";
const PAYLOAD: Payload = {
  v: 1,
  vin: "1HGCM82633A004352",
  y: "2003",
  mk: "HONDA",
  md: "Accord",
  u: "UNIT-42",
};

const URL_CARRIER = buildPayloadUrl(PAYLOAD, ORIGIN).url;
const TEXT_CARRIER = buildTextCarrier(PAYLOAD);

/** What the scan screen does with one decoded string, as a single word. */
function outcome(raw: string): "import" | "banner" | "silent" | "vin" | "keep-scanning" {
  if (isPayloadCarrier(raw)) {
    try {
      return parseCarrier(raw) === null ? "silent" : "import";
    } catch {
      return "banner";
    }
  }
  return extractVin(raw) === null ? "keep-scanning" : "vin";
}

describe("[R3-C] every string the guard accepts gets an answer", () => {
  it("routes the carriers the app itself writes", () => {
    expect(outcome(URL_CARRIER)).toBe("import");
    expect(outcome(TEXT_CARRIER)).toBe("import");
  });

  it("shows a banner for a carrier whose body is damaged rather than dropping it", () => {
    expect(outcome(TEXT_CARRIER.slice(0, -12))).toBe("banner");
    expect(outcome(`${ORIGIN}/#/i?d=`)).toBe("banner");
  });

  it("never answers a recognised carrier with silence", () => {
    // A QR generator that uppercases the URL to reach alphanumeric mode produces this.
    // The body is then unrecoverable either way — but P7 wants that said out loud, and
    // the two recognisers disagreed instead: `isPayloadCarrier` matched `d=` case-
    // insensitively (carrier.ts URL_CARRIER_RE), while `parseCarrier` read the parameter
    // through URLSearchParams, whose names are case-sensitive (codec.ts).
    //
    // WAS: "silent" — the camera kept running and nothing was ever said. R3-F closed it
    // by making one match answer both questions (carrier.ts `matchCarrier`).
    const shouted = URL_CARRIER.replace("#/i?d=", "#/I?D=");
    expect(isPayloadCarrier(shouted)).toBe(true);
    expect(outcome(shouted), "#/I?D=").not.toBe("silent");

    // The same disagreement, reached the other way: the guard matches the last `#/i?` in
    // the string, `parseCarrier` matches the first, so a decode carrying two fragments is
    // a carrier to one and an empty query to the other.
    const twoFragments = `${ORIGIN}/#/x?y=1${URL_CARRIER.slice(ORIGIN.length)}`;
    if (isPayloadCarrier(twoFragments)) {
      expect(outcome(twoFragments), "two fragments").not.toBe("silent");
    }
  });
});

describe("[R3-D] a carrier of any version is named rather than mined, twice over", () => {
  it("names the version when a payload from another version arrives as a URL", () => {
    // The URL recogniser is version-agnostic — it matches the route, not the body — so a
    // future payload is decoded far enough to be named. This is the behaviour the text
    // carrier should have too, and the test that proves the asymmetry is not theoretical.
    const future = buildPayloadUrl({ ...PAYLOAD, v: 2 }, ORIGIN).url;
    expect(outcome(future)).toBe("banner");
    expect(() => parseCarrier(future)).toThrow(PayloadError);
    try {
      parseCarrier(future);
    } catch (error) {
      expect((error as PayloadError).kind).toBe("version");
      expect((error as PayloadError).message).toContain("version 2");
    }
  });

  it("recognises a VIN Relay text carrier whatever version digit it carries", () => {
    // §4.9 fixes this app's prefix at `VINRELAY1:` and that constant is not in question:
    // v1 is still the only thing written and the only thing decoded. What is in question
    // was the guard — `TEXT_CARRIER_RE` in carrier.ts was `/^VINRELAY1:/i`, so a carrier
    // that announces itself as VIN Relay in its very first nine characters was treated as
    // ordinary label text and mined for a VIN.
    //
    // WAS: `isPayloadCarrier` false, so this reached `extractVin` and was mined. R3-M
    // widened `TEXT_CARRIER_RE` to `/^VINRELAY\d+:/i`; `TEXT_PREFIX` is still v1, because
    // recognising a carrier is not decoding one (§4.9 unchanged).
    const future = `VINRELAY2:${buildTextCarrier({ ...PAYLOAD, v: 2 }).slice(TEXT_PREFIX.length)}`;
    expect(isPayloadCarrier(future)).toBe(true);
    expect(outcome(future)).toBe("banner");
  });

  it("refuses the base64url body as well, so the §4.9 guard is belt and §4.2 is braces", () => {
    // WHY THE GUARD EXISTS, kept executable. §4.9's carrier guard is there precisely
    // because `extractVin` would otherwise mine this body: carrier.ts measures 9.7% of
    // realistic payloads fabricating a VIN that way. While the guard was pinned to
    // `VINRELAY1:` (R3-M, the test above), this exact string fell through to §4.2 and came
    // back as `DLRKXWME5ANLC1WLN`, `checkDigitValid: true`. The carrier holds
    // N97KFLV0NZ6W5ZSE6; nothing on it, and nothing a human could read off it, is that
    // number — but the window passed §4.3, a QR decodes identically every frame so §6.3's
    // two-read rule agreed, and the record was written, beeped and shown as fact (N2).
    // Measured over 3,000 seeded payloads: 8.3% of bodies that reached `extractVin`
    // yielded a VIN and every one was wrong — the same figure for a `%23`-escaped URL
    // carrier and for a text carrier with a label in front, so it was the body doing it,
    // not the wrapper.
    //
    // BELT: R3-M widened the guard, so the body no longer reaches §4.2 at all, and the
    // user is told which version this is instead of being shown a VIN (P7).
    const future =
      "VINRELAY2:eyJ2IjoyLCJ2aW4iOiJOOTdLRkxWME5aNlc1WlNFNiIsInkiOiIyMDE5IiwibWsiOiJDQVRF" +
      "UlBJTExBUiIsIm1kIjoiMzIwRCIsInUiOiJVTklULTQyIn0";
    expect(isPayloadCarrier(future)).toBe(true);
    expect(outcome(future)).toBe("banner");

    // BRACES: ledger Z6 narrowed §4.2 step 4(a) — a check-digit-valid window may only be
    // returned from a run in which EVERY window satisfies §4.3 `checkDigitApplies`, since
    // a window whose position 9 is a letter was never tested and so is not refuted by
    // failing. Uppercased, this body's only long run is `TDLRKXWME5ANLC1WLNFN`: four
    // windows, and three of them — `TDLRKXWME5ANLC1WL`, `LRKXWME5ANLC1WLNF`,
    // `RKXWME5ANLC1WLNFN`, position 9 `E`, `A`, `N` — carry no check digit at all. The run
    // cannot be settled, so it is refused whole. Base64url bodies are like this by
    // construction: 64 characters of noise, so most windows land a letter in position 9.
    expect(extractVin(future)).toBeNull();
    // The window still passes §4.3. What changed is that the RUN is refused, not that the
    // fabrication stopped validating — which is why the guard can never be "nearly right"
    // and why this test stays: it is what notices if §4.2 is ever widened again, or if a
    // carrier shape slips past the guard the way `VINRELAY2:` once did.
    expect(isCheckDigitValid("DLRKXWME5ANLC1WLN")).toBe(true);
  });
});

describe("[R3-C/R3-D] the guard under size and under noise", () => {
  it("decides about a 100 KB decoded string without throwing or hanging", () => {
    // The largest thing a 2D symbol can carry is ~3 KB; this is 30x that, on the path
    // that runs before `extractVin` on every frame.
    const huge = `${TEXT_PREFIX}${"QUJDREVGR0hKS0xNTlBSU1RVVldYWVo".repeat(3500)}`;
    expect(huge.length).toBeGreaterThan(100_000);
    expect(isPayloadCarrier(huge)).toBe(true);
    expect(() => parseCarrier(huge)).toThrow(PayloadError);
    expect(outcome(huge)).toBe("banner");
  });

  it("decides about a 100 KB string full of fragment markers without hanging", () => {
    // The two URL recognisers are the only regexes on the hot path that scan a whole
    // decode; neither may degrade on an adversarial input.
    const spikes = `${"#/i?".repeat(20_000)}d=`;
    expect(spikes.length).toBeGreaterThan(80_000);
    expect(isPayloadCarrier(spikes)).toBe(true);
    // A decode this hostile may be refused; it may never become a VIN.
    expect(outcome(spikes)).not.toBe("vin");
  });

  it("keeps scanning rather than importing when the text is not a carrier at all", () => {
    expect(outcome("1HGCM82633A004352")).toBe("vin");
    expect(outcome("I1HGCM82633A004352")).toBe("vin");
    expect(outcome("https://example.com/parts?id=99")).toBe("keep-scanning");
    expect(outcome("")).toBe("keep-scanning");
  });
});
