/**
 * The §5.1 structural block, rendered. It is presentational — it takes a `VinStructural` and
 * returns markup — so it renders to a string with no DOM, the way `CameraView` does, and the
 * §6.4 lines it carries become ordinary assertions.
 *
 * Why this file exists at all: both of the §6.4 strings below were reported as defects in
 * round 3 (R3-I, R3-F7), survived every round since, and were reported again in round 5. They
 * are the two microcopy strings in the app that nothing could see. §6.4 is authoritative for
 * them, so they are asserted **verbatim, in full, including punctuation** rather than by
 * substring — a substring match is exactly what let a missing full stop and a missing em dash
 * live through three rounds of a green gate.
 *
 * The last test reads a Tailwind class name out of the markup, which is what round 3's own
 * notes warn about. It is here because the alternative is worse: the rule it pins cannot be
 * expressed any other way in this codebase, and getting it wrong is silent — see the comment
 * above `WrappingChipText`.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StructuralBlock } from "./StructuralBlock";
import type { ModelYear, VinStructural } from "../../lib/vin/types";

/** §4.11: a North-American VIN whose check digit is defined and correct. */
const VIN_OK = "1HGCM82633A004352";
/** The same VIN with position 9 wrong: §4.3 applies here, so a mismatch is a mismatch. */
const VIN_MISMATCH = "1HGCM82653A004352";
/** §4.3 / D17: a letter other than X at position 9 means no ISO 3779 check digit applies. */
const VIN_NO_CHECK = "WVWZZZ1JZPW123456";

const YEAR_RESOLVED: ModelYear = { candidates: [2003], resolved: 2003 };
const YEAR_AMBIGUOUS: ModelYear = { candidates: [1993, 2023], resolved: null };

function structural(overrides: Partial<VinStructural> = {}): VinStructural {
  return {
    wmi: "1HG",
    vds: "CM826",
    checkDigit: "3",
    checkDigitValid: true,
    yearCode: "3",
    modelYear: YEAR_RESOLVED,
    plantCode: "A",
    serial: "004352",
    region: "North America",
    country: "United States",
    manufacturerFromWmi: null,
    ...overrides,
  };
}

function render(vin: string, overrides: Partial<VinStructural> = {}): string {
  return renderToStaticMarkup(
    createElement(StructuralBlock, { vin, structural: structural(overrides) }),
  );
}

/**
 * What `textContent` would read in a browser: tags dropped, React's five escapes undone.
 * The apostrophe matters — React writes `'` as `&#x27;`, and §6.4 spells these lines with the
 * ASCII apostrophe (A27), so a curly one would fail here rather than pass by looking similar.
 */
function text(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The one `<dd>` whose text contains `needle`, as `textContent` would read it. */
function cell(markup: string, needle: string): string {
  const cells = [...markup.matchAll(/<dd[^>]*>(.*?)<\/dd>/g)].map((m) => text(m[1]));
  const found = cells.filter((value) => value.includes(needle));
  expect(found).toHaveLength(1);
  return found[0];
}

describe("§6.4 check-digit note", () => {
  it("renders the not-applicable line exactly as §6.4 writes it, full stop included", () => {
    // R3-I, reported again in round 5. §6.4: "This number doesn't use a check digit."
    expect(cell(render(VIN_NO_CHECK, { checkDigitValid: false }), "check digit")).toBe(
      "This number doesn't use a check digit.",
    );
  });

  it("says a defined check digit passed, and does not say it about an undefined one", () => {
    expect(cell(render(VIN_OK), "Check digit")).toBe("Check digit ok");
    // D17: no check digit is defined here, so "ok" would be an assertion about nothing (N2).
    expect(render(VIN_NO_CHECK, { checkDigitValid: false })).not.toContain("Check digit ok");
  });

  it("warns only where §4.3 defines a check digit to fail", () => {
    expect(cell(render(VIN_MISMATCH, { checkDigitValid: false }), "Check digit")).toBe(
      "Check digit doesn't match",
    );
  });
});

describe("§6.4 ambiguous year", () => {
  it("joins the candidates and the tail into one §6.4 sentence", () => {
    // R3-F7: this read "1993 or 2023will confirm when details load" — two sentences run
    // together, because the em dash §6.4 puts between them was not rendered at all.
    expect(cell(render(VIN_OK, { modelYear: YEAR_AMBIGUOUS }), "will confirm")).toBe(
      "1993 or 2023 — will confirm when details load",
    );
  });

  it("uses the em dash, not a hyphen or an en dash", () => {
    const markup = render(VIN_OK, { modelYear: YEAR_AMBIGUOUS });
    expect(markup).toContain("— will confirm when details load");
    expect(markup).not.toContain("- will confirm");
    expect(markup).not.toContain("– will confirm");
  });

  it("states a settled year without the tail, so nothing pending is implied (N2)", () => {
    const markup = render(VIN_OK);
    expect(cell(markup, "2003")).toBe("2003");
    expect(markup).not.toContain("will confirm");
  });

  it("states a lone surviving candidate without the tail", () => {
    const markup = render(VIN_OK, { modelYear: { candidates: [2003], resolved: null } });
    expect(cell(markup, "2003")).toBe("2003");
    expect(markup).not.toContain("will confirm");
  });
});

describe("§6.1 the note has to fit the narrowest phone", () => {
  it("lets the pill's text wrap from inside it, where the cascade cannot lose", () => {
    // Measured at 320 px before this: the pill ran 326.20 px against a 288 px row and hung
    // 22.20 px past the viewport, in both themes; after, 288 px and 16 px clear of it, on two
    // lines. `whitespace-normal` passed through `Chip`'s `className` cannot do it — Tailwind
    // emits `whitespace-nowrap` after it in the same layer, so the pill's own rule wins on
    // source order (the R3-U-b trap). Setting the inherited property on the text's own element
    // is what beats it, so that is what is pinned: the wrapping span is the pill's child, not
    // a class on the pill. `ManualEntry` carries the same fix for the same sentence.
    const markup = render(VIN_NO_CHECK, { checkDigitValid: false });
    expect(markup).toMatch(/whitespace-nowrap[^"]*"><span class="whitespace-normal">/);
    expect(markup).not.toMatch(/class="[^"]*whitespace-nowrap[^"]*whitespace-normal/);
  });
});
