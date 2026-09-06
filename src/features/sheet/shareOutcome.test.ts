/**
 * SH-3. Every rejection `navigator.share()` can produce, sorted into the only two answers a
 * user cares about: nothing happened because I said so, or nothing happened and I was not
 * told. Until this existed the handler returned on every `AbortError`, and Chromium sends
 * four different things there (`ShareClientImpl::Callback` special-cases `PERMISSION_DENIED`
 * and nothing else) — so a dropped Mojo pipe, a full disk and an unreadable blob all looked
 * exactly like a deliberate cancel.
 *
 * The strings below are Chromium's own, from `ErrorToString` and `OnConnectionError` in
 * `third_party/blink/renderer/modules/webshare/navigator_share.cc`.
 */
import { describe, expect, it } from "vitest";
import { shareOutcome } from "./shareOutcome";

const abort = (message: string) => new DOMException(message, "AbortError");

describe("SH-3: a cancel says nothing", () => {
  it("stays quiet when the user backs out of the system sheet", () => {
    // ShareError::CANCELED → kAbortError, "Share canceled".
    expect(shareOutcome(abort("Share canceled"))).toBe("cancelled");
  });

  it("stays quiet for an AbortError this app cannot read", () => {
    // Another engine's cancel — WebKit and Gecko word theirs differently, and neither
    // promises a wording at all. Silence is the honest answer for an abort we cannot
    // identify: the record was never at risk, and a banner here would be a guess shown as
    // a fact (N2). What it costs is stated in the module: an internal failure phrased in
    // words that are not Chromium's stays silent too.
    expect(shareOutcome(abort("Abort due to cancellation of share."))).toBe("cancelled");
    expect(shareOutcome(abort(""))).toBe("cancelled");
  });
});

describe("SH-3: a failure is reported", () => {
  it("reports Chromium's INTERNAL_ERROR, which arrives as an AbortError", () => {
    // No window or activity, a temp file that could not be created, a blob that could not
    // be read (ShareServiceImpl.java) — all of them land here.
    expect(shareOutcome(abort("Share failed"))).toBe("failed");
  });

  it("reports a dropped Web Share connection, which also arrives as an AbortError", () => {
    expect(shareOutcome(abort("Internal error: could not connect to Web Share interface."))).toBe(
      "failed",
    );
  });

  it("reports a refused share, which is what SH-1's file produced on every tap", () => {
    expect(shareOutcome(new DOMException("Permission denied", "NotAllowedError"))).toBe("failed");
  });

  it("reports the other DOMExceptions share() throws", () => {
    // A share already in flight, and data this app built wrong. Neither is a user's choice.
    expect(
      shareOutcome(
        new DOMException("An earlier share has not yet completed.", "InvalidStateError"),
      ),
    ).toBe("failed");
    expect(shareOutcome(new TypeError("Invalid URL"))).toBe("failed");
  });

  it("reports anything that is not an exception at all", () => {
    expect(shareOutcome("boom")).toBe("failed");
    expect(shareOutcome(null)).toBe("failed");
    expect(shareOutcome(undefined)).toBe("failed");
  });
});

describe("SH-3: the name and the message are both load-bearing", () => {
  it("does not read a failure message under a different name as a failure of that kind", () => {
    // The message is only ever consulted for an AbortError; the same words under a name that
    // already says "failure" are a failure by the name alone.
    expect(shareOutcome(new DOMException("Share canceled", "NotAllowedError"))).toBe("failed");
  });

  it("matches Chromium's wording exactly, whitespace aside", () => {
    expect(shareOutcome(abort("  Share failed  "))).toBe("failed");
    // Not a substring match: "Share failed to send" is not a string Chromium produces, and
    // guessing at a family of messages is how a cancel starts being reported as a fault.
    expect(shareOutcome(abort("Share failed to send"))).toBe("cancelled");
  });
});
