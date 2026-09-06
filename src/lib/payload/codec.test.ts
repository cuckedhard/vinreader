import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { buildStructural } from "../vin/structural";
import type { VehicleRecord } from "../vin/types";
import { isPayloadCarrier } from "./carrier";
import {
  buildPayloadUrl,
  buildTextCarrier,
  DROP_ORDER,
  decodePayload,
  encodePayload,
  MAX_URL_BYTES,
  PAYLOAD_VERSION,
  parseCarrier,
  payloadFromRecord,
  PayloadError,
  type PayloadErrorKind,
  TEXT_PREFIX,
} from "./codec";
import type { Payload } from "./schema";

const VIN = "1HGCM82633A004352";
const ORIGIN = "vinrelay.example";

/** §4.9's example, with its `"tr": ""` kept verbatim and its `…` placeholders filled. */
const EXAMPLE: Payload = {
  v: 1,
  vin: VIN,
  y: "2003",
  mk: "HONDA",
  md: "Accord",
  tr: "",
  bc: "Sedan/Saloon",
  en: "K24A4",
  fu: "Gasoline",
  dr: "FWD",
  gv: "Class 1: 6,000 lb or less",
  at: "2026-09-03T14:12:00-08:00",
  u: "UNIT-42",
  n: "Rear bumper scuffed",
  by: "Zach's iPhone",
};

const MINIMAL: Payload = { v: 1, vin: VIN, y: "2003", mk: "HONDA", md: "Accord" };

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * The same encoding the codec uses, over BYTES rather than text: a body that arrived from
 * another device can carry bytes no `TextEncoder` would ever produce, and one of them is
 * what pins the UTF-8 guard below (M1).
 */
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The same encoding the codec uses, so a test can hand it a body it chose. */
function toBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

/**
 * §6.4 microcopy, quoted from `codec.ts`. Three different guards there raise `"encoding"`,
 * so the sentence is the only thing that says which one answered — and every one of these
 * strings mutates to `""` without a test noticing until they are asserted (M1).
 */
const NO_PAYLOAD = "This link carries no payload.";
const NOT_READABLE = "This link's payload is not readable.";
const CUT_OFF = "This link's payload is cut off.";

/**
 * A rejection as `kind` AND message, which is how every test below asserts one.
 *
 * M1, round 5's mutation run: `codec.ts` scored 76.83% — the worst of the four files
 * §13.5 gates at 100% coverage — and 27 of its 38 survivors were this single habit. The
 * tests asserted `PayloadError.kind` and nothing else, while the base64url alphabet, the
 * `1 mod 4` length, the UTF-8 decode and `JSON.parse` all raise `"encoding"`: no guard was
 * pinned individually, and §6.4's sentences could all be emptied in silence.
 *
 * It also replaces a `try { … } catch (error) { expect(…) }` shape used in four places,
 * which asserts nothing at all when nothing is thrown — the assertions sit in a branch the
 * run never enters. Reaching the throw below is the test failing, which is the point.
 */
function rejection(call: () => unknown): { kind: PayloadErrorKind; message: string } {
  try {
    call();
  } catch (error) {
    // P6: nothing here may reach the caller as a platform error.
    expect(error).toBeInstanceOf(PayloadError);
    const { kind, message } = error as PayloadError;
    return { kind, message };
  }
  throw new Error("expected a PayloadError; nothing was thrown");
}

/**
 * The fields a rejection names (`PayloadError.fields`), which is how a caller recognises a
 * state §6.4 has its own sentence for without matching on the sentence the codec wrote
 * (F10). Separate from `rejection` above so the `toEqual` assertions there stay exact.
 */
function faultsOf(call: () => unknown): readonly string[] {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(PayloadError);
    return (error as PayloadError).fields;
  }
  throw new Error("expected a PayloadError; nothing was thrown");
}

function fromBase64Url(body: string): string {
  const binary = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function bodyOf(url: string): string {
  const body = new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("d");
  if (body === null) throw new Error(`no payload in ${url}`);
  return body;
}

function record(overrides: Partial<VehicleRecord> = {}): VehicleRecord {
  return {
    vin: VIN,
    structural: buildStructural(VIN, 2026),
    decode: {
      status: "ok",
      source: "nhtsa_vpic",
      fetchedAt: "2026-09-03T14:13:00-08:00",
      attempts: 1,
      lastError: null,
      fields: {
        ModelYear: "2003",
        Make: "HONDA",
        Model: "Accord",
        Trim: "EX",
        BodyClass: "Sedan/Saloon",
        EngineModel: "K24A4",
        FuelTypePrimary: "Gasoline",
        DriveType: "FWD",
        GVWR: "Class 1: 6,000 lb or less",
        PlantCity: "MARYSVILLE",
      },
    },
    unit: "UNIT-42",
    notes: "Rear bumper scuffed",
    firstScannedAt: "2026-09-01T09:00:00-08:00",
    lastScannedAt: "2026-09-03T14:12:00-08:00",
    scanCount: 2,
    origin: "scan",
    metaUpdatedAt: "2026-09-03T14:12:30-08:00",
    deletedAt: null,
    ...overrides,
  };
}

const vinArb = fc
  .array(fc.constantFrom(..."ABCDEFGHJKLMNPRSTUVWXYZ0123456789"), {
    minLength: 17,
    maxLength: 17,
  })
  .map((chars) => chars.join(""));

/** Graphemes cover accents, CJK and emoji — what a note typed on a phone actually holds. */
const textArb = fc.string({ unit: "grapheme", maxLength: 40 });
const longTextArb = fc.string({ unit: "grapheme", maxLength: 300 });
const isoArb = fc
  .date({
    min: new Date("1990-01-01T00:00:00Z"),
    max: new Date("2100-01-01T00:00:00Z"),
    noInvalidDate: true,
  })
  .map((date) => date.toISOString());

/**
 * Carrier-shaped strings, and noise that is nearly one. Assembled from §4.9's parts
 * rather than drawn from an alphabet: a generic string generator produced a carrier
 * 4 times in 5,000, which is a property that tests nothing (A29).
 */
const carrierishArb: fc.Arbitrary<string> = fc.oneof(
  fc
    .tuple(
      fc.constantFrom("", "https://vinrelay.example/", "UNIT B ", "https://h/#/v/X"),
      fc.constantFrom(
        "#/i?",
        "#i?",
        "#/I?",
        "#/i?src=qr&",
        "#/i?a=1&b=2&",
        "#/x?y=1#/i?",
        "#/i?id=7#/i?",
      ),
      fc.constantFrom("d=", "D=", "id=", "xd="),
      fc.oneof(
        fc.constant(encodePayload(MINIMAL)),
        fc.stringMatching(/^[A-Za-z0-9_%&=#+ .-]{0,30}$/),
      ),
    )
    .map(([lead, route, marker, body]) => `${lead}${route}${marker}${body}`),
  fc
    .tuple(
      fc.constantFrom("VINRELAY", "vinrelay", "VINRELAY0", "VINRELAY1", "VINRELAY2", "VINRELAY10"),
      fc.constantFrom(":", ""),
      fc.oneof(
        fc.constant(encodePayload(MINIMAL)),
        fc.stringMatching(/^[A-Za-z0-9_%&=#+ .-]{0,30}$/),
      ),
    )
    .map(([prefix, colon, body]) => `${prefix}${colon}${body}`),
  fc.stringMatching(/^[A-Za-z0-9#?&=:/ _-]{0,40}$/),
);

const payloadArb: fc.Arbitrary<Payload> = fc.record(
  {
    v: fc.constant(PAYLOAD_VERSION),
    vin: vinArb,
    y: textArb,
    mk: textArb,
    md: textArb,
    tr: textArb,
    bc: textArb,
    en: textArb,
    fu: textArb,
    dr: textArb,
    gv: textArb,
    at: isoArb,
    u: textArb,
    n: longTextArb,
    by: textArb,
  },
  { requiredKeys: ["v", "vin"] },
);

describe("encodePayload / decodePayload", () => {
  it("round-trips the §4.9 example, empty `tr` and all", () => {
    expect(decodePayload(encodePayload(EXAMPLE))).toEqual(EXAMPLE);
  });

  it("round-trips any payload, unicode notes and emoji included", () => {
    fc.assert(
      fc.property(payloadArb, (payload) => {
        expect(decodePayload(encodePayload(payload))).toEqual(payload);
      }),
      { seed: 0x4a9_0001, numRuns: 100 },
    );
  });

  it("emits base64url with no padding", () => {
    fc.assert(
      fc.property(payloadArb, (payload) => {
        expect(encodePayload(payload)).toMatch(/^[A-Za-z0-9_-]+$/);
      }),
      { seed: 0x4a9_0002, numRuns: 100 },
    );
  });

  it("emits compact JSON — no space is spent against the §4.9 cap", () => {
    expect(fromBase64Url(encodePayload(MINIMAL))).toBe(
      '{"v":1,"vin":"1HGCM82633A004352","y":"2003","mk":"HONDA","md":"Accord"}',
    );
    expect(fromBase64Url(encodePayload(EXAMPLE))).toBe(JSON.stringify(EXAMPLE));
  });

  it("carries a payload whose text is multi-byte", () => {
    const payload: Payload = { ...EXAMPLE, n: "後部バンパーに傷 🚚", by: "Zach's iPhone" };
    expect(decodePayload(encodePayload(payload))).toEqual(payload);
  });
});

describe("decodePayload rejections", () => {
  const decoding = (encoded: string) => rejection(() => decodePayload(encoded));

  /** §6.4's schema sentence, which every case below is a suffix of. */
  const SCHEMA = "This payload is not a VIN Relay record: ";

  it("rejects empty and whitespace input as `empty`", () => {
    expect(decoding("")).toEqual({ kind: "empty", message: NO_PAYLOAD });
    expect(decoding("   \n\t ")).toEqual({ kind: "empty", message: NO_PAYLOAD });
  });

  it("rejects a body that is not base64url as `encoding`", () => {
    for (const body of ["not base64url!", "eyJ2Ijox+Q", "eyJ2IjoxfQ=="]) {
      expect(decoding(body), body).toEqual({ kind: "encoding", message: NOT_READABLE });
    }
  });

  it("rejects a length of 1 mod 4, which no encoder can produce, as a body cut off", () => {
    const truncated = `${encodePayload(EXAMPLE)}A`.slice(
      0,
      encodePayload(EXAMPLE).length - (encodePayload(EXAMPLE).length % 4) + 1,
    );
    expect(truncated.length % 4).toBe(1);
    // The MESSAGE is what this test is for. Delete the `1 mod 4` guard and `atob` throws
    // instead, the catch below it names that "not readable", and the kind is `"encoding"`
    // either way — so asserting the kind alone left the guard unpinned (M1). §6.4 tells a
    // user whose link was cut in half something they can act on: send it again.
    expect(decoding(truncated)).toEqual({ kind: "encoding", message: CUT_OFF });
    expect(decoding("A")).toEqual({ kind: "encoding", message: CUT_OFF });
  });

  it("rejects bytes that are not UTF-8 as `encoding`", () => {
    // `____` is 0xff 0xff 0xff: never a valid UTF-8 sequence.
    expect(decoding("____")).toEqual({ kind: "encoding", message: NOT_READABLE });
  });

  /**
   * M1, and the reason the habit above matters. `new TextDecoder("utf-8", { fatal: true })`
   * → `{ fatal: false }` survived the mutation run under 33 covering tests, the `____` one
   * included: with `fatal` off those three bytes decode to U+FFFD, `JSON.parse` then fails,
   * the kind is still `"encoding"` and the sentence is still the same one, so nothing goes
   * red. The guard's own comment says it stops a corrupted record being STORED, so the
   * input that pins it is the one where the mojibake is valid JSON — bytes that damage only
   * a field. A 2D read that clips a multi-byte character does exactly that: 0xe6 0xbc is 漢
   * with its third byte lost.
   */
  it("refuses bytes that are not UTF-8 even when the mojibake would have parsed", () => {
    const text = new TextEncoder();
    const bytes = Uint8Array.from([
      ...text.encode(`{"v":1,"vin":"${VIN}","n":"`),
      0xe6,
      0xbc,
      ...text.encode('"}'),
    ]);
    const body = bytesToBase64Url(bytes);
    // Neither of the earlier guards can be what answers: this body is base64url and its
    // length is not 1 mod 4, so it reaches the decoder.
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.length % 4).not.toBe(1);

    // What `fatal` is standing between the app and. The lossy decode is a payload the
    // codec accepts, so with the flag off `decodePayload` returns it, §5.3 keys a record
    // on it and the note renders as a replacement character forever.
    const lossy = JSON.parse(new TextDecoder("utf-8").decode(bytes)) as Payload;
    expect(lossy.n).toBe("\uFFFD");
    expect(decodePayload(toBase64Url(JSON.stringify(lossy)))).toEqual({
      v: 1,
      vin: VIN,
      n: "\uFFFD",
    });

    // And what it does instead.
    expect(decoding(body)).toEqual({ kind: "encoding", message: NOT_READABLE });
  });

  it("rejects valid base64url that is not JSON as `encoding`", () => {
    expect(decoding(toBase64Url("not json at all"))).toEqual({
      kind: "encoding",
      message: NOT_READABLE,
    });
  });

  it("rejects another version as `version`, naming both versions", () => {
    expect(decoding(toBase64Url(JSON.stringify({ ...EXAMPLE, v: 2 })))).toEqual({
      kind: "version",
      message: `This payload is version 2; this app reads version ${PAYLOAD_VERSION}.`,
    });
  });

  it("rejects a version that is not even a number as `version`, quoting what arrived", () => {
    // The quotes are the point: a payload announcing `"1"` is not this app's version 1,
    // and naming it `1` would tell the user their reader is broken (P6, §6.4).
    expect(decoding(toBase64Url(JSON.stringify({ ...EXAMPLE, v: "1" })))).toEqual({
      kind: "version",
      message: `This payload is version "1"; this app reads version ${PAYLOAD_VERSION}.`,
    });
  });

  it("rejects a payload zod refuses as `schema`, naming the field at fault", () => {
    const cases: [unknown, string][] = [
      [{ v: 1 }, "vin"],
      [{ v: 1, vin: "NOT A VIN" }, "vin"],
      // I, O and Q are outside the §4.1 alphabet.
      [{ v: 1, vin: "1HGCM8263IA004352" }, "vin"],
      [{ v: 1, vin: VIN, at: "yesterday" }, "at"],
      [{ v: 1, vin: VIN, mk: 42 }, "mk"],
    ];
    for (const [payload, field] of cases) {
      const json = JSON.stringify(payload);
      const { kind, message } = decoding(toBase64Url(json));
      expect(kind, json).toBe("schema");
      // zod's own wording is not this file's to pin — which field it named is.
      expect(message, json).toContain(`${SCHEMA}${field} `);
    }
  });

  /**
   * §6.4 gives one rejection a line of its own — "That payload's VIN isn't 17 valid
   * characters, so there is nothing to save." — and the screen that renders it has to know
   * it is in that state. `message` names the field inside a sentence, which a caller cannot
   * read; `fields` is the same fact as data. Before this, the Import screen guarded that
   * sentence with its own grammar check *after* this function had already run the same
   * regex, so the sentence was unreachable and zod's wording rendered instead (F10).
   */
  it("names the fields it refused, in schema order, as data", () => {
    const faults = (payload: unknown) =>
      faultsOf(() => decodePayload(toBase64Url(JSON.stringify(payload))));

    expect(faults({ v: 1, vin: "123" })).toEqual(["vin"]);
    expect(faults({ v: 1 })).toEqual(["vin"]);
    expect(faults({ v: 1, vin: "1HGCM8263IA004352" })).toEqual(["vin"]);
    // Every fault, not the three `message` prints, and in the schema's own order.
    expect(faults({ v: 1, vin: "NOT A VIN", mk: 42, at: "yesterday", u: 7 })).toEqual([
      "vin",
      "mk",
      "at",
      "u",
    ]);
    // A VIN that is a VIN is never named, whatever else is wrong.
    expect(faults({ v: 1, vin: VIN, at: "yesterday" })).toEqual(["at"]);
    // A fault with no path is the payload itself.
    expect(faultsOf(() => decodePayload(toBase64Url("[1,2,3]")))).toEqual(["payload"]);
    // Nothing to name: the other three kinds carry no fields.
    expect(faultsOf(() => decodePayload(""))).toEqual([]);
    expect(faultsOf(() => decodePayload("____"))).toEqual([]);
    expect(faultsOf(() => decodePayload(toBase64Url(JSON.stringify({ v: 2, vin: VIN }))))).toEqual(
      [],
    );
  });

  it("rejects JSON that is not an object as `schema`, naming the payload itself", () => {
    for (const json of ["[1,2,3]", '"just a string"', "null"]) {
      const { kind, message } = decoding(toBase64Url(json));
      expect(kind, json).toBe("schema");
      // A fault with no path is the payload, not a field whose name came out empty.
      expect(message, json).toContain(`${SCHEMA}payload `);
    }
  });

  it("names at most three faults, so a bad payload is not a wall of zod (§6.4)", () => {
    const { message } = decoding(
      toBase64Url(JSON.stringify({ v: 1, vin: "NOT A VIN", mk: 42, at: "yesterday", u: 7 })),
    );
    expect(message.startsWith(SCHEMA)).toBe(true);
    // Asserted as structure rather than as a zod snapshot: three faults, in schema order,
    // joined by "; ". Both the cap and the separator survived the mutation run.
    const named = message.slice(SCHEMA.length).split("; ");
    expect(named.map((fault) => fault.split(" ")[0])).toEqual(["vin", "mk", "at"]);
    // `u` is the fourth fault of that payload and is left out — not absent because zod
    // ignored it, which is what this second decode establishes.
    expect(decoding(toBase64Url(JSON.stringify({ v: 1, vin: VIN, u: 7 }))).message).toContain(
      `${SCHEMA}u `,
    );
  });
});

describe("payloadFromRecord", () => {
  it("maps the §4.8 summary fields, the timestamp, the unit, the notes and the device", () => {
    expect(payloadFromRecord(record(), "Zach's iPhone")).toEqual({
      v: PAYLOAD_VERSION,
      vin: VIN,
      y: "2003",
      mk: "HONDA",
      md: "Accord",
      tr: "EX",
      bc: "Sedan/Saloon",
      en: "K24A4",
      fu: "Gasoline",
      dr: "FWD",
      gv: "Class 1: 6,000 lb or less",
      at: "2026-09-03T14:12:00-08:00",
      u: "UNIT-42",
      n: "Rear bumper scuffed",
      by: "Zach's iPhone",
    });
  });

  it("omits every field with nothing in it rather than sending an empty string", () => {
    const payload = payloadFromRecord(
      record({
        decode: { ...record().decode, fields: { Make: "HONDA", Model: "Accord", Trim: "   " } },
        unit: null,
        notes: null,
      }),
      null,
    );
    // §4.9 shows an empty `"tr"`, but an empty value costs bytes and renders as nothing.
    expect(payload).toEqual({
      v: 1,
      vin: VIN,
      y: "2003",
      mk: "HONDA",
      md: "Accord",
      at: "2026-09-03T14:12:00-08:00",
    });
    expect(Object.keys(payload)).not.toContain("tr");
    expect(Object.keys(payload)).not.toContain("by");
  });

  it("falls back to the structural year when vPIC has not answered yet", () => {
    const pending = record({
      decode: { ...record().decode, status: "pending", fields: {} },
    });
    expect(payloadFromRecord(pending, null).y).toBe("2003");
  });

  it("omits the year while two candidates survive (N2)", () => {
    const ambiguous = record({
      decode: { ...record().decode, status: "pending", fields: {} },
      structural: {
        ...buildStructural(VIN, 2026),
        yearCode: "T",
        modelYear: { candidates: [1996, 2026], resolved: null },
      },
    });
    expect(payloadFromRecord(ambiguous, null).y).toBeUndefined();
  });

  it("trims what it carries", () => {
    const padded = record({ unit: "  UNIT-42  ", notes: "  scuffed  " });
    const payload = payloadFromRecord(padded, "  Zach's iPhone  ");
    expect(payload.u).toBe("UNIT-42");
    expect(payload.n).toBe("scuffed");
    expect(payload.by).toBe("Zach's iPhone");
  });

  it("produces a payload its own decoder accepts", () => {
    expect(decodePayload(encodePayload(payloadFromRecord(record(), "Zach's iPhone")))).toEqual(
      payloadFromRecord(record(), "Zach's iPhone"),
    );
  });
});

describe("buildPayloadUrl", () => {
  it("builds the §4.9 URL carrier, which `isPayloadCarrier` recognizes", () => {
    const { url, dropped } = buildPayloadUrl(MINIMAL, ORIGIN);
    expect(url.startsWith(`https://${ORIGIN}/#/i?d=`)).toBe(true);
    expect(dropped).toEqual([]);
    expect(isPayloadCarrier(url)).toBe(true);
    expect(decodePayload(bodyOf(url))).toEqual(MINIMAL);
  });

  it("takes the host as it comes: with a scheme, on a port, under a sub-path", () => {
    expect(buildPayloadUrl(MINIMAL, "https://vinrelay.example").url).toContain(
      "https://vinrelay.example/#/i?d=",
    );
    expect(buildPayloadUrl(MINIMAL, "http://192.168.1.9:5173").url).toContain(
      "http://192.168.1.9:5173/#/i?d=",
    );
    expect(buildPayloadUrl(MINIMAL, "https://vin.relay.test/app/").url).toContain(
      "https://vin.relay.test/app/#/i?d=",
    );
  });

  it("drops `n` first and stops there once it fits", () => {
    const wordy: Payload = { ...EXAMPLE, n: "N".repeat(500) };
    const { url, dropped } = buildPayloadUrl(wordy, ORIGIN);
    expect(dropped).toEqual(["n"]);
    expect(byteLength(url)).toBeLessThanOrEqual(MAX_URL_BYTES);
    const decoded = decodePayload(bodyOf(url));
    expect(decoded.n).toBeUndefined();
    expect(decoded).toMatchObject({ vin: VIN, y: "2003", mk: "HONDA", md: "Accord", en: "K24A4" });
  });

  it("drops one field at a time in §4.9 order, stopping at the second", () => {
    const heavy: Payload = { ...EXAMPLE, n: "N".repeat(100), en: "E".repeat(320) };
    const { url, dropped } = buildPayloadUrl(heavy, ORIGIN);
    expect(dropped).toEqual(["n", "en"]);
    expect(byteLength(url)).toBeLessThanOrEqual(MAX_URL_BYTES);
    const decoded = decodePayload(bodyOf(url));
    // `dr` is next in the order and must still be there.
    expect(decoded).toMatchObject({
      vin: VIN,
      y: "2003",
      mk: "HONDA",
      md: "Accord",
      dr: "FWD",
      fu: "Gasoline",
      bc: "Sedan/Saloon",
      tr: "",
      gv: "Class 1: 6,000 lb or less",
    });
  });

  it("drops the whole §4.9 order when it has to, and never a protected field", () => {
    const huge: Payload = {
      ...EXAMPLE,
      n: "N".repeat(100),
      en: "E".repeat(100),
      dr: "D".repeat(100),
      fu: "F".repeat(100),
      bc: "B".repeat(100),
      tr: "T".repeat(100),
      gv: "G".repeat(600),
    };
    const { url, dropped } = buildPayloadUrl(huge, ORIGIN);
    expect(dropped).toEqual([...DROP_ORDER]);
    expect(byteLength(url)).toBeLessThanOrEqual(MAX_URL_BYTES);
    expect(decodePayload(bodyOf(url))).toEqual({
      v: 1,
      vin: VIN,
      y: "2003",
      mk: "HONDA",
      md: "Accord",
      at: "2026-09-03T14:12:00-08:00",
      u: "UNIT-42",
      by: "Zach's iPhone",
    });
  });

  it("never records a drop for a field the payload did not carry", () => {
    const { dropped } = buildPayloadUrl({ ...MINIMAL, u: "U".repeat(600) }, ORIGIN);
    expect(dropped).toEqual([]);
  });

  it("returns a URL over the cap rather than touching `vin`, `v`, `y`, `mk` or `md`", () => {
    // §4.9 leaves this open: nothing droppable is left, so the long URL stands.
    const stubborn: Payload = { ...MINIMAL, u: "U".repeat(2000) };
    const { url, dropped } = buildPayloadUrl(stubborn, ORIGIN);
    expect(dropped).toEqual([]);
    expect(byteLength(url)).toBeGreaterThan(MAX_URL_BYTES);
    expect(decodePayload(bodyOf(url))).toEqual(stubborn);
  });

  it("measures a note in UTF-8 bytes, not characters", () => {
    // 180 characters either way; 漢 is three bytes, so only one of them blows the cap.
    const ascii = buildPayloadUrl({ ...MINIMAL, n: "N".repeat(180) }, ORIGIN);
    const wide = buildPayloadUrl({ ...MINIMAL, n: "漢".repeat(180) }, ORIGIN);
    expect(ascii.dropped).toEqual([]);
    expect(wide.dropped).toEqual(["n"]);
  });

  it("measures the URL in bytes, not characters", () => {
    // Tuned so the URL is exactly 700 characters on both hosts: 700 bytes on the ASCII
    // host, 701 on the accented one, where é costs two. A `.length` check would keep
    // the note on both.
    const payload: Payload = { ...MINIMAL, n: "N".repeat(420) };
    const accented = buildPayloadUrl(payload, "vinrelay-café.example");
    const plain = buildPayloadUrl(payload, "vinrelay-cafe.example");
    expect(plain.url.length).toBe(700);
    expect(byteLength(plain.url)).toBe(700);
    expect(plain.dropped).toEqual([]);
    expect(`https://vinrelay-café.example/#/i?d=${encodePayload(payload)}`.length).toBe(700);
    expect(accented.dropped).toEqual(["n"]);
  });
});

describe("buildTextCarrier", () => {
  it("prefixes the §4.9 text carrier and round-trips through `parseCarrier`", () => {
    const carrier = buildTextCarrier(EXAMPLE);
    expect(carrier.startsWith(TEXT_PREFIX)).toBe(true);
    expect(isPayloadCarrier(carrier)).toBe(true);
    expect(parseCarrier(carrier)).toEqual(EXAMPLE);
  });

  it("is not capped — only the URL is (§4.9)", () => {
    const wordy: Payload = { ...EXAMPLE, n: "N".repeat(2000) };
    expect(parseCarrier(buildTextCarrier(wordy))).toEqual(wordy);
  });
});

describe("parseCarrier", () => {
  it("reads the URL carrier from any deployment", () => {
    const body = encodePayload(EXAMPLE);
    expect(parseCarrier(`https://vinrelay.example/#/i?d=${body}`)).toEqual(EXAMPLE);
    expect(parseCarrier(`http://192.168.1.9:5173/#i?d=${body}`)).toEqual(EXAMPLE);
    expect(parseCarrier(`https://vin.relay.test/app/#/i?src=qr&d=${body}`)).toEqual(EXAMPLE);
  });

  it("reads the text carrier, whatever case it arrives in", () => {
    const body = encodePayload(EXAMPLE);
    expect(parseCarrier(`VINRELAY1:${body}`)).toEqual(EXAMPLE);
    expect(parseCarrier(`vinrelay1:${body}`)).toEqual(EXAMPLE);
    expect(parseCarrier(`\n  VINRELAY1:${body}  \n`)).toEqual(EXAMPLE);
  });

  it("survives a body wrapped across lines by a messaging app", () => {
    const body = encodePayload(EXAMPLE);
    const wrapped = `${body.slice(0, 40)}\n${body.slice(40)}`;
    expect(parseCarrier(`VINRELAY1:${wrapped}`)).toEqual(EXAMPLE);
  });

  it("returns null for anything that is not a carrier", () => {
    expect(parseCarrier(VIN)).toBeNull();
    expect(parseCarrier("1HG CM826 3 3 A 004352")).toBeNull();
    expect(parseCarrier("https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/" + VIN)).toBeNull();
    expect(parseCarrier(`https://vinrelay.example/#/v/${VIN}`)).toBeNull();
    expect(parseCarrier("https://vinrelay.example/#/i?id=7")).toBeNull();
    expect(parseCarrier("")).toBeNull();
    expect(parseCarrier("just some words")).toBeNull();
  });

  it("throws rather than returning null when a carrier's body is bad", () => {
    // A caller shows an error for a broken carrier and moves on for a non-carrier, so
    // the two cases must not look the same.
    expect(() => parseCarrier("VINRELAY1:not base64url!")).toThrow(PayloadError);
    expect(() => parseCarrier(`https://vinrelay.example/#/i?d=${toBase64Url("nope")}`)).toThrow(
      PayloadError,
    );
    // WAS three bare `try { … } catch { expect(kind) }` blocks, which assert nothing on the
    // run where nothing is thrown — and the kind alone did not say which of the three
    // `"encoding"` guards answered (M1). A carrier with a one-character body is a link cut
    // in transit, and §6.4 says so rather than calling it unreadable.
    expect(rejection(() => parseCarrier("VINRELAY1:A"))).toEqual({
      kind: "encoding",
      message: CUT_OFF,
    });
    // A carrier the user recognises with nothing behind the `=`: §6.4's empty state, not
    // an encoding fault, because there is nothing to fail to decode.
    expect(rejection(() => parseCarrier("https://vinrelay.example/#/i?d="))).toEqual({
      kind: "empty",
      message: NO_PAYLOAD,
    });
    expect(rejection(() => parseCarrier("VINRELAY1:"))).toEqual({
      kind: "empty",
      message: NO_PAYLOAD,
    });
  });

  it("reads back everything `buildPayloadUrl` and `buildTextCarrier` produce", () => {
    fc.assert(
      fc.property(payloadArb, (payload) => {
        const { url, dropped } = buildPayloadUrl(payload, ORIGIN);
        const fromUrl = parseCarrier(url);
        expect(fromUrl).not.toBeNull();
        expect(fromUrl?.vin).toBe(payload.vin);
        for (const key of dropped) expect(DROP_ORDER).toContain(key);
        expect(parseCarrier(buildTextCarrier(payload))).toEqual(payload);
      }),
      { seed: 0x4a9_0003, numRuns: 100 },
    );
  });

  it("reads the body out of the very match the D14 guard made", () => {
    // R3-F. Both functions ask `matchCarrier`, so the answers cannot drift apart. These
    // three were recognised by the guard and answered with null by the parser, and
    // `ScanScreen.handleCarrier` drops a null without a word.
    const body = encodePayload(EXAMPLE);
    for (const carrier of [
      `https://vinrelay.example/#/I?D=${body}`,
      `https://vinrelay.example/#/i?src=qr#/i?d=${body}`,
      `VINRELAY2:${body}`,
    ]) {
      expect(isPayloadCarrier(carrier)).toBe(true);
      expect(() => parseCarrier(carrier)).not.toThrow();
      expect(parseCarrier(carrier)).toEqual(EXAMPLE);
    }
  });

  it("takes the first `d` when a query repeats it, as a query string does", () => {
    const body = encodePayload(EXAMPLE);
    const other = encodePayload(MINIMAL);
    expect(parseCarrier(`https://vinrelay.example/#/i?d=${body}&d=${other}`)).toEqual(EXAMPLE);
  });

  it("undoes percent-escapes in a URL body, and names one that will not decode", () => {
    // A carrier that travelled as a link can arrive escaped. base64url contains none of
    // the characters that need escaping, so undoing them is safe...
    const body = encodePayload(EXAMPLE);
    const escaped = `%${body.charCodeAt(0).toString(16).padStart(2, "0")}${body.slice(1)}`;
    expect(parseCarrier(`https://vinrelay.example/#/i?d=${escaped}`)).toEqual(EXAMPLE);

    // ...and a `%` that is not an escape is a damaged body, not another encoding: it is
    // named by the base64url guard rather than swallowed (P7). The `%` is what that guard
    // rejects, so the sentence is the unreadable one and not the cut-off one.
    expect(rejection(() => parseCarrier(`https://vinrelay.example/#/i?d=%zz${body}`))).toEqual({
      kind: "encoding",
      message: NOT_READABLE,
    });
  });

  it("answers every string the D14 guard accepts, and parses nothing it refuses", () => {
    // R3-F stated as a property rather than as a comment claiming the two are "kept in
    // step". A silent null is the failure that matters: `ScanScreen.handleCarrier` drops
    // one without a word while the camera keeps running at a code it will never resolve,
    // and the other direction would hand a base64url body to `extractVin` (D14, N2).
    //
    // Not vacuous: 28% of the generated strings are carriers, split about evenly between
    // ones that import and ones that raise a PayloadError. Run against the two
    // recognisers as they stood before this fix it shrinks to `#/i?id=7#/i?d=<body>` in
    // under twenty cases — the guard matched the second fragment, the parser the first.
    fc.assert(
      fc.property(carrierishArb, (raw) => {
        const recognized = isPayloadCarrier(raw);
        let parsed: Payload | null;
        try {
          parsed = parseCarrier(raw);
        } catch (error) {
          expect(error).toBeInstanceOf(PayloadError);
          expect(recognized).toBe(true);
          return;
        }
        if (recognized) expect(parsed).not.toBeNull();
        else expect(parsed).toBeNull();
      }),
      { seed: 0x4a9_0004, numRuns: 100 },
    );
  });
});
