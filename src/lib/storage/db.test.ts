/**
 * `nowIso` — the §5.1 timestamp every record on the device is stamped with.
 *
 * It had no test of its own. `upsert.test.ts` and `decodeQueue.test.ts` match the shape
 * against a regex, but this test process runs in UTC, so every stamp they have ever seen
 * ended `+00:00`: the sign, the minutes field and the offset's *value* were never
 * exercised at all (round-3 coverage: `db.ts:55`, one of the four unexercised branches in
 * the whole of `src/lib`).
 *
 * What is at stake is not cosmetic. §5.1 requires ISO 8601 **with offset** rather than
 * `toISOString()`'s UTC `Z`, and every §4.12 aggregate — `firstScannedAt` as a min,
 * `lastScannedAt` as a max, the D11 last-writer-wins clock — is a comparison between two
 * of these strings. A wrong sign does not produce a malformed timestamp; it produces a
 * well-formed one naming an instant twice the offset away, which is a scan filed hours
 * out and, on the sync path, an edit that silently loses to an older one.
 *
 * The zones are chosen for the arithmetic, not for variety: one west of UTC (the sign
 * branch), one at a half hour and one at three quarters (the `abs % 60` minutes field),
 * and UTC itself, where the sign must be `+` and not `-0`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { nowIso } from "./db";

/** §5.1: date, time to milliseconds, and a numeric offset. Never `Z`, never a bare date. */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

/** A fixed instant with a non-zero millisecond field, so zero-padding is visible. */
const INSTANT = Date.UTC(2026, 8, 4, 17, 30, 5, 7);

const REAL_TZ = process.env.TZ;

/** Stamp `INSTANT` as a device in `zone` would. */
function stampedIn(zone: string): string {
  process.env.TZ = zone;
  vi.useFakeTimers();
  vi.setSystemTime(INSTANT);
  try {
    return nowIso();
  } finally {
    vi.useRealTimers();
  }
}

afterEach(() => {
  vi.useRealTimers();
  if (REAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = REAL_TZ;
});

describe("nowIso — §5.1 ISO 8601 with offset", () => {
  it("stamps a zone west of UTC with a negative offset", () => {
    // America/Chicago is UTC-5 in September. The local wall clock reads 12:30:05.007.
    const stamp = stampedIn("America/Chicago");
    expect(stamp).toMatch(ISO_WITH_OFFSET);
    expect(stamp).toBe("2026-09-04T12:30:05.007-05:00");
  });

  it("stamps a zone east of UTC with a positive offset", () => {
    const stamp = stampedIn("Europe/Berlin");
    expect(stamp).toMatch(ISO_WITH_OFFSET);
    expect(stamp).toBe("2026-09-04T19:30:05.007+02:00");
  });

  it("carries a half-hour offset in the minutes field", () => {
    // Asia/Kolkata is +05:30. An implementation that reported whole hours would write
    // `+05:00` here and file every scan half an hour early.
    expect(stampedIn("Asia/Kolkata")).toBe("2026-09-04T23:00:05.007+05:30");
  });

  it("carries a three-quarter-hour offset, and rolls the date with it", () => {
    // Pacific/Chatham is +12:45, and the local day is already the 5th.
    expect(stampedIn("Pacific/Chatham")).toBe("2026-09-05T06:15:05.007+12:45");
  });

  it("writes UTC as +00:00, never Z and never -00:00", () => {
    const stamp = stampedIn("UTC");
    expect(stamp).toBe("2026-09-04T17:30:05.007+00:00");
    expect(stamp).not.toContain("Z");
  });

  it("names the same instant in every zone", () => {
    // The law the sign exists for: whatever the device's clock is set to, the stamp parses
    // back to the moment it was taken. A flipped sign still matches the regex above and
    // still looks like a plausible timestamp — it is only wrong by twice the offset.
    for (const zone of ["America/Chicago", "Europe/Berlin", "Asia/Kolkata", "Pacific/Chatham"]) {
      expect(Date.parse(stampedIn(zone))).toBe(INSTANT);
    }
  });

  it("orders by instant and not by string, which is why §4.12 compares with Date.parse", () => {
    // Stated because two call sites depend on it: `upsert.ts` picks `firstScannedAt` as a
    // min and `lastScannedAt` as a max, and `decodeQueue` sorts the §5.4 queue oldest
    // first. Two devices in different zones produce offset strings that do not sort
    // lexicographically — here the *later* scan sorts first as text.
    process.env.TZ = "Pacific/Chatham";
    vi.useFakeTimers();
    vi.setSystemTime(INSTANT);
    const chatham = nowIso();
    process.env.TZ = "America/Chicago";
    vi.setSystemTime(INSTANT + 60_000);
    const chicago = nowIso();
    vi.useRealTimers();

    expect(Date.parse(chicago)).toBeGreaterThan(Date.parse(chatham));
    expect(chicago < chatham).toBe(true);
  });
});
