/**
 * [FR-2] The two lines every refused read shows, rendered.
 *
 * `RefusedRead` is presentational, so it renders to a string with no DOM and no camera —
 * the same way `CameraView` is tested. What is asserted is the part that must not drift
 * between the three surfaces that use it: the read is shown, it is shown at §6.1's VIN
 * size in the VIN font, it is shown *ungrouped*, and the reason sits underneath it.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RefusedRead } from "./RefusedRead";
import { refusalRead, refusalReason } from "./refusalText";
import { extractVinExplained } from "../lib/vin/extractVin";
import { groupVin } from "../lib/vin/grammar";
import { VIN_TEXT_SIZES } from "../ui/VinDisplay";
import type { NoVin } from "../lib/vin/types";

const PART_NUMBER = "R25-1251-200622120";

function refusalOf(raw: string): NoVin {
  const outcome = extractVinExplained(raw);
  if (outcome.ok) throw new Error(`expected NO_VIN, got ${outcome.result.vin}`);
  return outcome.refusal;
}

function render(raw: string): string {
  return renderToStaticMarkup(createElement(RefusedRead, { refusal: refusalOf(raw) }));
}

/** The paragraphs, in order, as `{ classes, text }`. */
function paragraphs(html: string): { classes: string; text: string }[] {
  return [...html.matchAll(/<p class="([^"]*)">([^<]*)<\/p>/g)].map((match) => ({
    classes: match[1]!,
    text: match[2]!,
  }));
}

describe("[FR-2] the refused read, rendered", () => {
  it("shows the text that was read and then why it is not a VIN", () => {
    const html = render(PART_NUMBER);
    const [read, why] = paragraphs(html);
    expect(read?.text).toBe(PART_NUMBER);
    expect(why?.text).toBe(refusalReason(refusalOf(PART_NUMBER)));
    // Two lines and no third: a remedy here would be a fourth voice on a screen that
    // already answers the question in §6.4's words.
    expect(paragraphs(html)).toHaveLength(2);
  });

  it("sets the read at §6.1's VIN size, in the VIN font", () => {
    // The string is read off a phone held at arm's length against a sticker, which is the
    // position §6.1 sizes the VIN for. The size is imported from `VinDisplay` rather than
    // restated (§7 item 5), so a change there moves both.
    const [read] = paragraphs(render(PART_NUMBER));
    const classes = read?.classes.split(" ") ?? [];
    expect(classes).toContain("font-vin");
    for (const token of VIN_TEXT_SIZES.lg.split(" ")) expect(classes).toContain(token);
    expect(VIN_TEXT_SIZES.lg).toContain("text-[28px]");
  });

  it("does not group the read the way a VIN is grouped", () => {
    // §4.1's grouping is a claim about a VIN's structure. This text is not a VIN — that
    // is the whole message — so printing it in a VIN's groups would say something about
    // it that nothing knows (N2).
    // Seventeen characters long — `groupVin` passes anything else straight through, so a
    // read of any other length could not tell the two apart — and refused all the same,
    // because two of them are hyphens.
    const seventeen = "R25-1251-20062212";
    expect(seventeen).toHaveLength(17);
    const [read] = paragraphs(render(seventeen));
    expect(read?.text).toBe(seventeen);
    expect(read?.text).not.toBe(groupVin(seventeen));
    expect(read?.text).not.toContain(" ");
  });

  it("shows the cut read, not the whole one", () => {
    const long = `${PART_NUMBER}-${"9".repeat(60)}`;
    const [read] = paragraphs(render(long));
    expect(read?.text).toBe(refusalRead(refusalOf(long)));
    expect(read?.text.endsWith("…")).toBe(true);
    expect(read?.text.length).toBeLessThan(long.length);
  });

  it("wraps rather than overflowing a phone", () => {
    // §6.1: a 360 px phone, an arbitrary read with no spaces in it, and no horizontal
    // scroll to reach the end of it.
    const [read] = paragraphs(render(PART_NUMBER));
    expect(read?.classes.split(" ")).toContain("break-words");
  });
});
