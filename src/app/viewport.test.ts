/**
 * §6.6's breakpoint and the default route it chooses.
 *
 * The rule worth pinning is the one that is invisible when it is right: the default is a
 * function of a width someone *sampled*, not a rule the app keeps enforcing. A laptop user
 * who drags a window narrower mid-session, or a tablet turned to portrait while a scan is on
 * screen, must not be navigated anywhere. Keeping this pure is what makes that true — there
 * is nothing here to subscribe to.
 */
import { describe, expect, it } from "vitest";

import { WIDE_MIN_PX, WIDE_QUERY, defaultRoutePath, isWideViewport } from "./viewport";

describe("§6.6's 900 px", () => {
  it("is one number, in one place", () => {
    expect(WIDE_MIN_PX).toBe(900);
    expect(WIDE_QUERY).toBe("(min-width: 900px)");
  });

  it("sends wide screens to History and everything else to Scan", () => {
    expect(defaultRoutePath(true)).toBe("/history");
    expect(defaultRoutePath(false)).toBe("/scan");
  });
});

describe("isWideViewport", () => {
  it("is false where there is no window at all", () => {
    // vitest runs with `environment: "node"`: no window, and no wide screen either.
    expect(typeof globalThis.window).toBe("undefined");
    expect(isWideViewport()).toBe(false);
  });
});
