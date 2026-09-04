import { describe, expect, it } from "vitest";

import { isPayloadCarrier } from "./carrier";

const VIN = "1HGCM82633A004352";
const BODY = "eyJ2IjoxLCJ2aW4iOiIxSEdDTTgyNjMzQTAwNDM1MiJ9";

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LONG_BODY = Array.from({ length: 300 }, (_, i) => B64URL[(i * 7) % B64URL.length]).join("");

describe("isPayloadCarrier", () => {
  it("recognizes the §4.9 URL carrier", () => {
    expect(isPayloadCarrier(`https://vinrelay.example/#/i?d=${BODY}`)).toBe(true);
  });

  it("recognizes a URL carrier from any deployment, on any scheme", () => {
    // The fragment never reaches a server, so scheme and host carry no meaning here.
    expect(isPayloadCarrier(`http://192.168.1.9:5173/#/i?d=${BODY}`)).toBe(true);
    expect(isPayloadCarrier(`https://vin.relay.test/app/#/i?d=${BODY}`)).toBe(true);
  });

  it("accepts the fragment with or without its leading slash", () => {
    expect(isPayloadCarrier(`https://vinrelay.example/#i?d=${BODY}`)).toBe(true);
  });

  it("accepts `d` after another query parameter", () => {
    expect(isPayloadCarrier(`https://vinrelay.example/#/i?src=qr&d=${BODY}`)).toBe(true);
  });

  it("recognizes the §4.9 text carrier", () => {
    expect(isPayloadCarrier(`VINRELAY1:${BODY}`)).toBe(true);
  });

  it("recognizes a carrier with an empty `d`, which is a carrier by shape", () => {
    expect(isPayloadCarrier("https://vinrelay.example/#/i?d=")).toBe(true);
    expect(isPayloadCarrier("VINRELAY1:")).toBe(true);
  });

  it("ignores surrounding whitespace from a paste", () => {
    expect(isPayloadCarrier(`\n  VINRELAY1:${BODY}\n`)).toBe(true);
  });

  it("rejects a bare VIN", () => {
    expect(isPayloadCarrier(VIN)).toBe(false);
  });

  it("rejects an ordinary URL", () => {
    expect(isPayloadCarrier("https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/" + VIN)).toBe(
      false,
    );
    // `d` in the query rather than the fragment is not the §4.9 shape.
    expect(isPayloadCarrier("https://vinrelay.example/i?d=" + BODY)).toBe(false);
  });

  it("rejects another app route", () => {
    expect(isPayloadCarrier(`https://vinrelay.example/#/v/${VIN}`)).toBe(false);
    expect(isPayloadCarrier("https://vinrelay.example/#/i?id=7")).toBe(false);
  });

  it("rejects the text prefix without its colon", () => {
    expect(isPayloadCarrier(`VINRELAY1 ${VIN}`)).toBe(false);
  });

  it("rejects empty and whitespace input", () => {
    expect(isPayloadCarrier("")).toBe(false);
    expect(isPayloadCarrier("   \n\t ")).toBe(false);
  });

  it("recognizes a long payload, the case this predicate exists for", () => {
    // 300 characters of base64url: uppercased and stripped by extractVin (§4.2) this is a
    // long run of VIN-legal characters, and about one window in eleven passes the check
    // digit by chance. A QR decodes identically every frame, so the §6.3 two-read rule
    // would then confirm a fabricated VIN. extractVin must therefore never see this string.
    expect(isPayloadCarrier(`https://vinrelay.example/#/i?d=${LONG_BODY}`)).toBe(true);
  });

  it("recognizes a text carrier whatever version digit it carries", () => {
    // R3-M. `VINRELAY1:` stays the only prefix this app writes and the only version it
    // decodes; the guard is wider on purpose. A carrier from another version reaches
    // §4.9's version check, which names it, instead of `extractVin`, which mines the
    // base64url body — 8.3% of those bodies yield a VIN and every one is wrong (N2).
    expect(isPayloadCarrier(`VINRELAY2:${BODY}`)).toBe(true);
    expect(isPayloadCarrier(`VINRELAY10:${BODY}`)).toBe(true);
    expect(isPayloadCarrier(`vinrelay2:${BODY}`)).toBe(true);
  });

  it("accepts `d` in any case, as it accepts the route in any case", () => {
    // R3-F. A QR generator that uppercases the URL to reach alphanumeric mode writes
    // this. The fragment is the app's own client-side route, never a server's contract,
    // so the marker is read as loosely as the route around it — and `parseCarrier` reads
    // the body from this same match, so the two can no longer disagree (§7 item 5).
    expect(isPayloadCarrier(`https://vinrelay.example/#/I?D=${BODY}`)).toBe(true);
  });

  it("finds the fragment that carries a body when a decode holds more than one", () => {
    // The guard used to look for the first `#/i?` with a `d`, and `parseCarrier` for the
    // first `#/i?` of any kind, so this string was a carrier to one and an empty query to
    // the other — recognised, then dropped without a word.
    expect(isPayloadCarrier(`https://vinrelay.example/#/i?src=qr#/i?d=${BODY}`)).toBe(true);
  });
});
