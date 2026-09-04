/**
 * The scan surface, rendered. `CameraView` is presentational — it takes a §6.3 machine state
 * and returns markup — so it renders to a string with no DOM, no camera and no React DOM
 * environment, and every §6.4 line, every §6.1 rule about the scan screen and the round-1
 * layout and tone fixes become ordinary assertions.
 *
 * Why it is worth doing: §6.4's strings were pinned by nothing (round-1 A-24). They can be
 * reworded, truncated, or swapped between states with the whole gate green, and the state
 * they are attached to is the difference between a user who saves a bad read and one who
 * checks it. The tone and the layout are here for the same reason: "Got it ✓" in success
 * green beside a mismatch banner (A-05) and a decision pushed below the fold (A-08) were both
 * shipped, both found by hand, and neither is caught by anything that runs in the gate.
 *
 * Coupling, stated: three assertions read Tailwind class names out of the markup, because
 * that is how §6.1's tone and size rules are expressed in this codebase. They are confined to
 * the helpers below, so a restyle touches one place.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { checkDigitApplies } from "../../lib/vin/checkDigit";
import { CameraView } from "./CameraView";
import type { ScanMachineState } from "./scanMachine";
import type { ScanError } from "../../lib/vin/types";

/** §4.11. The check digit is deliberately wrong on the second, and absent on the third. */
const VIN_A = "1HGCM82633A004352";
const VIN_BAD = "1HGCM82653A004352";
/** §4.3 / D17: a letter other than X at position 9 means no ISO 3779 check digit applies. */
const VIN_NO_CHECK = "1HGCM826A3A004352";

function state(kind: "idle", lost: boolean): ScanMachineState;
function state(kind: "requesting" | "streaming"): ScanMachineState;
function state(kind: string, arg?: unknown): ScanMachineState {
  if (kind === "idle") return { kind: "idle", lost: arg === true };
  return { kind: kind as "requesting" | "streaming" };
}

function sighting(vin: string, checkDigitValid: boolean): ScanMachineState {
  return {
    kind: "confirmed",
    sighting: { vin, raw: vin, checkDigitValid, symbology: "code_39", atMs: 0 },
  };
}

function candidate(vin: string): ScanMachineState {
  return {
    kind: "candidate",
    sighting: { vin, raw: vin, checkDigitValid: true, symbology: "code_39", atMs: 0 },
  };
}

interface Options {
  torch?: { available: boolean; on: boolean };
}

function render(machineState: ScanMachineState, options: Options = {}): string {
  const torch = options.torch ?? { available: false, on: false };
  return renderToStaticMarkup(
    createElement(CameraView, {
      state: machineState,
      videoRef: { current: null },
      torch: { ...torch, toggle: () => undefined },
      onRetry: () => undefined,
      onTypeInstead: () => undefined,
    }),
  );
}

/** The §6.4 line and the tone it is painted in. `null` when the screen shows no status. */
function status(html: string): { text: string; tone: string } | null {
  const match = /<p class="text-lg leading-snug font-bold ([^"]*)">([^<]*)<\/p>/.exec(html);
  return match === null ? null : { tone: match[1]!, text: match[2]! };
}

/** The Banner's title line, which carries every §6.4 error string. */
function notice(html: string): string | null {
  const match = /<p class="text-lg leading-tight font-bold [^"]*">([^<]*)<\/p>/.exec(html);
  return match === null ? null : match[1]!;
}

function buttons(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]!);
}

/** §6.1: primary is the 56 px target (`--tap-lg`), everything else 48 px (`--tap`). */
function isPrimary(html: string, label: string): boolean {
  const match = new RegExp(`<button[^>]*class="([^"]*)"[^>]*>${label}</button>`).exec(html);
  return match !== null && match[1]!.includes("min-h-[var(--tap-lg)]");
}

/** Whether the camera preview is collapsed. A whole class token, not a substring of one. */
function previewIsHidden(html: string): boolean {
  const match = /<div class="(relative[^"]*)">/.exec(html);
  return match !== null && match[1]!.split(" ").includes("hidden");
}

function vinDisplay(html: string): { text: string; classes: string } | null {
  const match = /<span class="font-vin ([^"]*)">([^<]*)<\/span>/.exec(html);
  return match === null ? null : { classes: match[1]!, text: match[2]! };
}

describe("§6.4 microcopy on the scan screen", () => {
  it("shows the §6.4 scan prompt while streaming", () => {
    expect(status(render(state("streaming")))).toEqual({
      text: "Point at the barcode on the door-jamb sticker.",
      tone: "text-fg-muted",
    });
  });

  it("shows the §6.4 candidate line while a read is being confirmed", () => {
    expect(status(render(candidate(VIN_A)))).toEqual({
      text: "Reading… hold steady.",
      tone: "text-accent",
    });
  });

  it("shows the §6.4 confirmed line, in the success tone, on a clean read", () => {
    expect(status(render(sighting(VIN_A, true)))).toEqual({ text: "Got it ✓", tone: "text-ok" });
    expect(notice(render(sighting(VIN_A, true)))).toBeNull();
  });

  it("says nothing at all while the camera is still coming up, beyond that it is", () => {
    // §6.4 has no line for the black frame iOS shows for 1–3 s; this one is supplied (§0
    // rule 4) and is pinned so it cannot drift into one of the §6.4 lines above.
    expect(status(render(state("requesting")))).toEqual({
      text: "Starting camera…",
      tone: "text-fg-muted",
    });
  });

  it("shows no status line and no notice on a clean idle screen", () => {
    const html = render(state("idle", false));
    expect(status(html)).toBeNull();
    expect(notice(html)).toBeNull();
    expect(buttons(html)).toEqual(["Type VIN instead"]);
  });
});

describe("§6.3 — a confirmed read the check digit is holding", () => {
  it("never celebrates a mismatch", () => {
    // §6.3: "Success feedback never fires on a mismatch", and §6.1 makes the screen change
    // the *primary* feedback — so the success line and the success green are feedback, not
    // decoration (A-05). The §6.4 check-digit wording belongs to the banner ScanScreen puts
    // up; this line only has to stop contradicting it.
    expect(checkDigitApplies(VIN_BAD)).toBe(true);
    const shown = status(render(sighting(VIN_BAD, false)));
    expect(shown?.text).not.toBe("Got it ✓");
    expect(shown?.tone).not.toBe("text-ok");
    expect(shown).toEqual({ text: "Check this read.", tone: "text-warn" });
  });

  it("still confirms an identifier that carries no check digit at all", () => {
    // §4.3 / D17: a letter other than X at position 9 means the mismatch says nothing, so the
    // read is a success and gets the §6.4 line. Gating on `checkDigitValid` alone would hold
    // every off-highway PIN back behind a warning it can never satisfy.
    expect(checkDigitApplies(VIN_NO_CHECK)).toBe(false);
    expect(status(render(sighting(VIN_NO_CHECK, false)))).toEqual({
      text: "Got it ✓",
      tone: "text-ok",
    });
  });

  it("hides the dead preview so the Rescan / Use as-is decision is not pushed off-screen", () => {
    // §6.3 stops the stream on `confirmed`, leaving a ~470 px black box above the decision
    // (A-08). The element stays mounted — `videoRef` still has to point at it when Rescan
    // returns the machine to `streaming` — so "hidden" is the assertion, not "absent".
    const held = render(sighting(VIN_BAD, false));
    expect(previewIsHidden(held)).toBe(true);
    expect(held).toContain("<video");
    expect(previewIsHidden(render(state("streaming")))).toBe(false);
    expect(previewIsHidden(render(candidate(VIN_A)))).toBe(false);
  });
});

describe("§6.1 — the VIN under the camera", () => {
  it("renders the candidate at the §6.1 floor of 28 px, grouped", () => {
    // §6.1: "VIN display: monospace, ≥ 28 px on phone". The candidate is exactly the moment
    // the number is being read back against the sticker at arm's length (A-12).
    const shown = vinDisplay(render(candidate(VIN_A)));
    expect(shown?.text).toBe("1HG CM826 3 3 A 004352");
    expect(shown?.classes).toContain("text-[28px]");
    expect(shown?.classes).not.toContain("text-[18px]");
  });

  it("renders the confirmed read at the same size", () => {
    expect(vinDisplay(render(sighting(VIN_A, true)))?.classes).toContain("text-[28px]");
  });

  it("shows no VIN before there is one to show", () => {
    for (const machineState of [state("requesting"), state("streaming"), state("idle", true)]) {
      expect(vinDisplay(render(machineState))).toBeNull();
    }
  });
});

describe("§6.4 error copy and the route out of each error (P7)", () => {
  const cases: Array<[ScanError, string, boolean]> = [
    [
      "permission_denied",
      "Camera is blocked. Allow camera for this site in your browser settings, or type the VIN.",
      true,
    ],
    ["insecure_context", "Camera needs a secure (https) connection.", false],
    // §6.4 has no line for these two; both are supplied (§0 rule 4) and pinned here so they
    // stay blaming the device rather than the user.
    ["no_camera", "No camera is available on this device.", true],
    ["stream_lost", "Camera stopped. It starts again when this screen is active.", true],
  ];

  it.each(cases)("renders the %s notice with the right way forward", (error, message, retry) => {
    const html = render({ kind: "error", error });
    expect(notice(html)).toBe(message);
    expect(status(html)).toBeNull();
    expect(buttons(html).includes("Retry")).toBe(retry);
    // §6.1 gives the screen's one primary action the 56 px target. An insecure context has no
    // Retry — retrying it can only fail — so typing becomes the way forward and takes it.
    expect(isPrimary(html, "Type VIN instead")).toBe(!retry);
    expect(buttons(html)).toContain("Type VIN instead");
  });

  it("gives a stream that died under the user the same notice and the same Retry", () => {
    // §6.3 routes a dead track to `idle.lost` rather than to an error, so this state carries
    // the copy; leaving it passive would strand the user on a dead preview.
    const html = render(state("idle", true));
    expect(notice(html)).toBe("Camera stopped. It starts again when this screen is active.");
    expect(buttons(html)).toEqual(["Retry", "Type VIN instead"]);
    expect(isPrimary(html, "Retry")).toBe(true);
  });
});

describe("§6.1 — the aim box and the torch", () => {
  it("draws the aim box only while aiming, and never lets it take a tap", () => {
    for (const machineState of [state("streaming"), candidate(VIN_A)]) {
      const html = render(machineState);
      expect(html).toContain("pointer-events-none");
      expect(html).toContain('aria-hidden="true"');
    }
    for (const machineState of [state("requesting"), sighting(VIN_A, true), state("idle", true)]) {
      expect(render(machineState)).not.toContain("pointer-events-none");
    }
  });

  it("shows the torch only when the track reported one", () => {
    // A-10: the button is gated on the capability's *value* in `useScanner`; this is the
    // other half — a view that rendered it regardless would put a dead control on every
    // phone whose camera has no lamp.
    expect(buttons(render(state("streaming")))).toEqual(["Type VIN instead"]);
    const off = render(state("streaming"), { torch: { available: true, on: false } });
    expect(buttons(off)).toContain("Torch off");
    expect(off).toContain('aria-pressed="false"');
    const on = render(state("streaming"), { torch: { available: true, on: true } });
    expect(buttons(on)).toContain("Torch on");
    expect(on).toContain('aria-pressed="true"');
  });
});

describe("the status region is announced, whatever it says", () => {
  it("keeps one polite live region across every state", () => {
    // The status line is how §6.1's "primary feedback is the screen change" reaches a user
    // who is not looking at the screen. It has to be the same region every time, or a screen
    // reader announces nothing when the text is replaced.
    const states: ScanMachineState[] = [
      state("requesting"),
      state("streaming"),
      candidate(VIN_A),
      sighting(VIN_A, true),
      sighting(VIN_BAD, false),
      state("idle", false),
      state("idle", true),
      { kind: "error", error: "permission_denied" },
    ];
    for (const machineState of states) {
      const html = render(machineState);
      expect(html).toContain('role="status" aria-live="polite"');
    }
  });
});
