/**
 * The §9-S3 handoff overlay, rendered. It is a client component — it opens a `<dialog>`,
 * measures a box and draws a canvas — but its *first* render is presentational, so it renders
 * to a string with no DOM the way `CameraView` does, and the decisions that are colours and
 * sizes rather than behaviour become ordinary assertions.
 *
 * What is worth pinning here, and why it is class names again (the coupling round 3 warns
 * about): every colour in this overlay is chosen **against a field that is not the palette**.
 * A scanner reads dark modules on a light field, so the sheet is black on white in both
 * themes — which means `tokens.css` cannot be re-derived under it and, more sharply, that the
 * app-wide `var(--accent)` focus ring lands on white paper here whatever the theme says. That
 * ring measured **1.91:1** against the dialog's own `rgb(255,255,255)` in the dark default,
 * under WCAG's 3:1 floor for a focus indicator, on the single tab stop the focus trap leaves.
 * Nothing in the gate can see a contrast ratio, so what is asserted is the thing that produces
 * it: two literal tones and the palette ring turned off. Same shape as `CameraView`'s
 * `GUIDE_BOX` and `FOCUS_RING` assertions, for the same reason (Z4, R4-C, R4-E).
 *
 * Behaviour — the focus trap, the DPR-sized backing store, the box staying whole on a phone —
 * belongs to the e2e specs, which have a browser. This file does not duplicate them.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QrView } from "./QrView";

const VIN = "1HGCM82633A004352";
const URL_VALUE = "https://vinrelay.example/#/i?d=abc";

/** §4.9's carrier is drawn on a phone, so the component's first read of `window` is stubbed. */
function render(viewport = { innerWidth: 320, innerHeight: 658, devicePixelRatio: 3 }): string {
  vi.stubGlobal("window", viewport);
  return renderToStaticMarkup(
    createElement(QrView, { value: URL_VALUE, vin: VIN, onClose: () => {} }),
  );
}

/** The `<button>` element's own markup — the overlay renders exactly one. */
function closeButton(markup: string): string {
  const buttons = [...markup.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
  expect(buttons).toHaveLength(1);
  return buttons[0];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("§6.1 / §6.6 the focus ring on the way out", () => {
  /**
   * The two tones and the order they sit in, as one string, so a restyle touches one place.
   * White first (0–2 px in from the padding edge, against the button's own black border),
   * black behind it (2–5 px, against the white fill) — the mirror of `CameraView`'s ring,
   * because here it is the *outer* side that faces white rather than the inner one.
   */
  const RING_SHADOW = "focus-visible:shadow-[inset_0_0_0_2px_#fff,inset_0_0_0_5px_#000]";

  it("gives Close a two-tone ring and turns off the palette one", () => {
    const button = closeButton(render());
    expect(button).toContain(RING_SHADOW);
    // Without this the app-wide `:focus-visible { outline: 3px solid var(--accent) }` still
    // paints — `@layer base` beats nothing, it just loses to a stated utility (R3-U-b) — and
    // the control would show two indicators, one of them the 1.91:1 one.
    expect(button).toContain("focus-visible:outline-none");
    expect(button).not.toContain("focus-visible:outline-accent");
  });

  it("takes no colour from the theme palette", () => {
    // The overlay's field is white in both themes, so a token here would be a ratio that
    // changes when the palette does, on the one screen whose ground the palette does not set.
    const button = closeButton(render());
    const ring = button.match(/focus-visible:shadow-\[[^\]]*\]/g) ?? [];
    expect(ring).toHaveLength(1);
    expect(ring[0]).not.toMatch(/var\(--|accent|fg|bg/);
  });

  it("keeps §6.1's 56 px primary target under the ring", () => {
    // The ring is drawn inside the button, so it must not be bought with the target's height.
    expect(closeButton(render())).toContain("min-h-[var(--tap-lg)]");
  });
});

describe("§9-S3 the overlay is a light field, not a themed surface", () => {
  it("paints black on white in its own colours", () => {
    const markup = render();
    expect(markup).toMatch(/<dialog[^>]*style="background-color:#ffffff;color:#000000"/);
    expect(closeButton(markup)).toContain("background-color:#ffffff");
  });

  it("sizes the canvas box in CSS pixels, whatever the device pixel ratio", () => {
    // R4-H': the box is `size` and only the backing store is multiplied. At DPR 3 a 237 px
    // code that took a 711 px box overflowed a 320 px phone on both sides and did not decode.
    const markup = render({ innerWidth: 320, innerHeight: 658, devicePixelRatio: 3 });
    expect(markup).toContain('style="width:237px;height:237px;background-color:#ffffff"');
  });
});
