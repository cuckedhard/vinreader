/**
 * [M8] §4.9's text carrier is a **prefix**: `VINRELAY1:<base64url>`. `TEXT_CARRIER_RE` is
 * anchored for that reason, and `bun run mutate` takes the `^` off and survives — no test
 * hands `matchCarrier` a string that merely *contains* the marker.
 *
 * Two things go wrong without the anchor, and the second is the one that matters:
 *
 * 1. Anything quoting a carrier — a messaging app's "Zach sent: VINRELAY1:eyJ2…", a note
 *    with the code pasted after a unit number — becomes a carrier.
 * 2. The body is cut with `trimmed.slice(match[0].length)`, an offset from the start of the
 *    string rather than from the end of the match, because a prefix match makes the two the
 *    same thing. Unanchored, they are not: `"Truck 12 VINRELAY1:eyJ2…"` yields a body that
 *    starts eight characters into the wrong place. §4.9's decoder then reports the payload
 *    as damaged (`encoding`) for a payload that arrived intact.
 *
 * The property below is the invariant that says both at once, and it is the shape of the
 * grammar rather than a restatement of the regex: whatever `matchCarrier` calls a text
 * carrier, the part of the input that is not the body is exactly a §4.9 text-carrier
 * prefix. Seeded, so a failure reproduces.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isPayloadCarrier, matchCarrier, TEXT_PREFIX } from "./carrier";

/** A real §4.9 v1 body: base64url, no padding. Content is irrelevant to the grammar. */
const BODY = "eyJ2IjoxLCJ2aW4iOiIxSEdDTTgyNjMzQTAwNDM1MiJ9";

describe("[M8] the §4.9 text carrier is a prefix, not a substring", () => {
  it("matches at the start and hands back the body and the kind", () => {
    expect(matchCarrier(`${TEXT_PREFIX}${BODY}`)).toEqual({ kind: "text", body: BODY });
  });

  it("is not a carrier when the marker is quoted inside another message", () => {
    // What a phone's messaging app does to a shared code, and what a note reads like when
    // someone typed the unit in front of it.
    expect(matchCarrier(`Truck 12 ${TEXT_PREFIX}${BODY}`)).toBeNull();
    expect(matchCarrier(`Zach sent: ${TEXT_PREFIX}${BODY}`)).toBeNull();
    expect(isPayloadCarrier(`junk${TEXT_PREFIX}${BODY}`)).toBe(false);
  });

  it("keeps the leading-whitespace case, which is trimmed rather than skipped", () => {
    // The trim is deliberate and is not the same permission: whitespace before the marker
    // is transport, characters before it are content.
    expect(matchCarrier(`\n  ${TEXT_PREFIX}${BODY}  `)).toEqual({ kind: "text", body: BODY });
  });

  it("cuts the body at the end of the prefix, whatever the prefix was", () => {
    fc.assert(
      fc.property(
        // Any junk in front, from an alphabet that includes the marker's own letters so a
        // partial `VINRELAY` can be generated, and any version number the wider-than-v1
        // recogniser accepts.
        fc.stringMatching(/^[A-Za-z0-9 :.,]{0,12}$/),
        fc.integer({ min: 1, max: 99 }),
        fc.stringMatching(/^[A-Za-z0-9_-]{0,40}$/),
        (junk, version, body) => {
          const raw = `${junk}VINRELAY${version}:${body}`;
          const match = matchCarrier(raw);
          if (match === null || match.kind !== "text") return;
          const trimmed = raw.trim();
          const prefix = trimmed.slice(0, trimmed.length - match.body.length);
          // The invariant: everything ahead of the body is the §4.9 marker itself.
          expect(prefix).toMatch(/^VINRELAY\d+:$/i);
          expect(`${prefix}${match.body}`).toBe(trimmed);
        },
      ),
      { seed: 0x4c9_0001, numRuns: 500 },
    );
  });
});
