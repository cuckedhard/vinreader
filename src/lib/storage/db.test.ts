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
 * A23-a: the zone used to arrive by assigning `process.env.TZ` at run time, which moves
 * the clock only under vitest's default `forks` pool — a worker process re-reads TZ, a
 * worker thread does not. Under `threads` the assignment is inert, every case below
 * silently collapses back into the UTC case it was written to escape, and the file cannot
 * run there at all. Stryker's vitest runner pins `pool: "threads"`, so this file had to be
 * excluded from the §13.5 mutation run and `nowIso`'s offset arithmetic went unmeasured —
 * the one place in `src/lib` where surviving mutants were not gaps. The zone now reaches
 * `nowIso` through the clock it reads rather than through the process: the readings are
 * the real ICU ones for that zone (`Intl.DateTimeFormat` with an explicit `timeZone`), so
 * the arithmetic under test is untouched; only the seam the zone arrives by has moved.
 *
 * The zones are chosen for the arithmetic, not for variety: one west of UTC (the sign
 * branch), one at a half hour and one at three quarters (the `abs % 60` minutes field),
 * and UTC itself, where the sign must be `+` and not `-0`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { nowIso } from "./db";

/** §5.1: date, time to milliseconds, and a numeric offset. Never `Z`, never a bare date. */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

/** Held before anything below stubs the global, because the fake clock is built from it. */
const RealDate = globalThis.Date;

/** A fixed instant with a non-zero millisecond field, so zero-padding is visible. */
const INSTANT = RealDate.UTC(2026, 8, 4, 17, 30, 5, 7);

/**
 * What a device in `zone` reads off its clock at `instant`: the eight values `nowIso` asks
 * a `Date` for, and nothing else. `Intl` is the same ICU data the process would have used
 * had it been started in that zone, so nothing here is a hand-computed offset that could
 * drift from the rule under test.
 */
function wallClockIn(zone: string, instant: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);

  const wall = {
    year: field("year"),
    month: field("month"),
    day: field("day"),
    hour: field("hour"),
    minute: field("minute"),
    second: field("second"),
    // Every zone offset is a whole number of minutes, so the wall clock's milliseconds are
    // the instant's; `Intl` does not report them anyway.
    millisecond: ((instant % 1000) + 1000) % 1000,
  };
  const asIfUtc = RealDate.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
    wall.millisecond,
  );
  // `getTimezoneOffset` reports UTC minus local, so a zone *east* of UTC returns a
  // negative number. That inversion is exactly what `nowIso` flips back, and getting it
  // backwards here would make a broken implementation look right.
  return { ...wall, timezoneOffset: Math.round((instant - asIfUtc) / 60_000) };
}

/**
 * A stand-in for the device clock. It extends the real `Date`, so the statics and the UTC
 * accessors stay honest and only the local readings are re-pointed at `zone`.
 */
function clockIn(zone: string, instant: number): DateConstructor {
  const wall = wallClockIn(zone, instant);
  class ZonedDate extends RealDate {
    constructor() {
      super(instant);
    }
    override getFullYear(): number {
      return wall.year;
    }
    override getMonth(): number {
      return wall.month - 1;
    }
    override getDate(): number {
      return wall.day;
    }
    override getHours(): number {
      return wall.hour;
    }
    override getMinutes(): number {
      return wall.minute;
    }
    override getSeconds(): number {
      return wall.second;
    }
    override getMilliseconds(): number {
      return wall.millisecond;
    }
    override getTimezoneOffset(): number {
      return wall.timezoneOffset;
    }
  }
  return ZonedDate as unknown as DateConstructor;
}

/** Stamp `instant` as a device in `zone` would. The stub covers one synchronous call. */
function stampedIn(zone: string, instant: number = INSTANT): string {
  vi.stubGlobal("Date", clockIn(zone, instant));
  try {
    return nowIso();
  } finally {
    vi.unstubAllGlobals();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
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
    const chatham = stampedIn("Pacific/Chatham");
    const chicago = stampedIn("America/Chicago", INSTANT + 60_000);

    expect(Date.parse(chicago)).toBeGreaterThan(Date.parse(chatham));
    expect(chicago < chatham).toBe(true);
  });
});
