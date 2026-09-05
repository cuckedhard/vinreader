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
 * Coupling, stated: a handful of assertions read Tailwind class names out of the markup,
 * because that is how §6.1's tone, size and contrast rules are expressed in this codebase.
 * They are confined to the helpers below, so a restyle touches one place. The aim box is the
 * strongest of them — its stroke is the one colour decision in the app that is made against
 * arbitrary live video rather than against a token, so it is asserted rather than left to a
 * palette that can be re-derived under it (Z4).
 *
 * §9-S1's tap-to-refocus is tested here in both halves — `pickFocusMode`, which decides
 * whether the platform has anything to offer, and the tap target the view renders when it
 * does. The probe is a pure function of what `getCapabilities()` returned, so it needs no
 * camera; the two belong together because the whole feature is "a control, or nothing at
 * all" (§11), and neither half states that on its own.
 */

import { createElement, isValidElement } from "react";
import type { ComponentProps, ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { checkDigitApplies } from "../../lib/vin/checkDigit";
import { CameraView } from "./CameraView";
import type { ScanMachineState } from "./scanMachine";
import { pickFocusMode } from "./useScanner";
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
  /** §9-S1: absent means the platform reported no focus mode, which is the iOS case. */
  focus?: { available: boolean; refocus?: () => void };
  unsaved?: boolean;
}

function viewProps(
  machineState: ScanMachineState,
  options: Options,
): ComponentProps<typeof CameraView> {
  const torch = options.torch ?? { available: false, on: false };
  const focus = options.focus ?? { available: false };
  return {
    state: machineState,
    videoRef: { current: null },
    torch: { ...torch, toggle: () => undefined },
    focus: { available: focus.available, refocus: focus.refocus ?? (() => undefined) },
    onRetry: () => undefined,
    onTypeInstead: () => undefined,
    unsaved: options.unsaved ?? false,
  };
}

function render(machineState: ScanMachineState, options: Options = {}): string {
  return renderToStaticMarkup(createElement(CameraView, viewProps(machineState, options)));
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

/** The class list of the button carrying `label` directly, or `null` when there is none. */
function buttonClasses(html: string, label: string): string[] | null {
  const match = new RegExp(`<button[^>]*class="([^"]*)"[^>]*>${label}</button>`).exec(html);
  return match === null ? null : match[1]!.split(" ");
}

/**
 * §6.1: primary is the 56 px target (`--tap-lg`), everything else 48 px (`--tap`).
 *
 * A `Button` declares its target as `--tap-target` and sizes itself from that declaration,
 * so the declaration is what names the variant here (F4). This says which weight the markup
 * asks for; what a browser then computes for it is measured in
 * tests/e2e/banner-targets.spec.ts, because a class list cannot answer that.
 */
function isPrimary(html: string, label: string): boolean {
  return buttonClasses(html, label)?.includes("[--tap-target:var(--tap-lg)]") ?? false;
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

/**
 * The §6.1 aim box's own classes. Identified by the scrim — the 100vmax spread that dims
 * everything outside the box is what makes this element the guide rather than a wrapper.
 */
function guideBox(html: string): string[] | null {
  const match = /<div class="([^"]*100vmax[^"]*)"><\/div>/.exec(html);
  return match === null ? null : match[1]!.split(" ");
}

/** §6.4 has no line for it; this is the one CameraView supplies (§0 rule 4). */
const TAP_TO_FOCUS = "Tap to focus";

/**
 * §9-S1's tap target: the only button on the screen that carries its label in a child, so
 * the whole preview can be the target while the label stays a small visible pill.
 */
function focusTap(html: string): { attributes: string; label: string } | null {
  const match = /<button([^>]*)><span[^>]*>([^<]*)<\/span><\/button>/.exec(html);
  return match === null ? null : { attributes: match[1]!, label: match[2]! };
}

/** The tap target's own class list — its label lives in a child, so `buttonClasses` misses it. */
function focusTapClasses(html: string): string[] | null {
  const match = new RegExp(
    `<button[^>]*class="([^"]*)"[^>]*><span[^>]*>${TAP_TO_FOCUS}</span></button>`,
  ).exec(html);
  return match === null ? null : match[1]!.split(" ");
}

/**
 * The elements `CameraView` returns, depth first. `renderToStaticMarkup` drops every handler
 * it renders and this suite has no DOM to click in (`environment: "node"`), so the one thing
 * the markup cannot show — that the tap is wired to the hook's `refocus` — is read off the
 * element tree instead. `CameraView` is a hook-free function of its props, so calling it is
 * exactly what React does with it.
 */
function* elements(node: unknown): Generator<ReactElement<{ children?: unknown }>> {
  if (Array.isArray(node)) {
    for (const child of node) yield* elements(child);
    return;
  }
  if (!isValidElement(node)) return;
  const element = node as ReactElement<{ children?: unknown }>;
  yield element;
  yield* elements(element.props.children);
}

/** The tap surface itself, or `null` when the screen renders none. */
function tapTarget(
  machineState: ScanMachineState,
  options: Options,
): ReactElement<Record<string, unknown>> | null {
  for (const element of elements(CameraView(viewProps(machineState, options)))) {
    if (element.type !== "button") continue;
    for (const child of elements(element.props.children)) {
      if (child.props.children === TAP_TO_FOCUS) {
        return element as ReactElement<Record<string, unknown>>;
      }
    }
  }
  return null;
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

/**
 * Z4's consequence, measured. The aim box is the one piece of the UI that sits over
 * *arbitrary live video*, so no single palette colour can be guaranteed to contrast with it:
 * `--accent` reads 2.50:1 (dark) and as little as 1.00:1 (light) against the scrimmed
 * surround as the video brightens — snow glare, which is exactly the case §6.1 is written
 * for. The answer is a two-tone stroke, whose ratios live in a comment in `CameraView.tsx`.
 */
describe("§6.1 — the aim box stays legible over video of any luminance, in both themes", () => {
  it("draws the guide as a light stroke and a dark stroke, not one flat colour", () => {
    const classes = guideBox(render(state("streaming")));
    expect(classes).not.toBeNull();
    // The white core reads against the scrimmed surround (≥ 4.76:1) and against the dark
    // stroke (21:1); the dark stroke reads against bright video the white would vanish into.
    expect(classes).toContain("border-white");
    expect(classes!.join(" ")).toContain("inset_0_0_0_2px_#000");
    // The scrim stays: it is what fixes the *outer* neighbour of the stroke at 0.45 × video
    // instead of the video itself, and §6.1 wants everything outside the box dimmed.
    expect(classes!.join(" ")).toContain("100vmax_rgba(0,0,0,0.55)");
  });

  it("takes no colour from the theme palette, so switching theme cannot wash it out", () => {
    // Both strokes are literals, not tokens, so the dark and light themes render the same
    // outline and the same ratios. A palette token here is how Z4's finding happened.
    const classes = guideBox(render(state("streaming")))!;
    for (const token of ["accent", "fg", "fg-muted", "ok", "warn", "danger", "border"]) {
      expect(classes.some((name) => name === `border-${token}` || name === `text-${token}`)).toBe(
        false,
      );
    }
  });
});

/**
 * R3-U, the same defect one element over. §6.6 requires a visible focus ring and the wide
 * layout makes both controls inside the preview Tab-reachable with a desktop webcam, but their
 * ring was `--accent` over the scrimmed video — 2.50:1 at worst in dark, 1.00:1 in light —
 * and on the tap target it was drawn *outside* a box that fills an `overflow-hidden` parent,
 * so it was clipped away and there was no indicator at all. Both now carry `FOCUS_RING`, whose
 * ratios are in `CameraView.tsx`.
 */
describe("§6.6 — the focus ring on the two controls that sit over live video", () => {
  /** The two tones, so whichever the background washes out, the other reads. */
  const RING_SHADOW = "focus-visible:shadow-[inset_0_0_0_2px_#000,inset_0_0_0_5px_#fff]";
  /**
   * An `outline` is unusable on these two whatever its colour: it is drawn outside the box,
   * and the `overflow-hidden` preview clips anything outside the box away. So the indicator
   * is a `box-shadow`, and the app-wide ring is turned off for these two controls only.
   * `outline-none` sets `--tw-outline-style`, which the width utility reads, so it disables
   * the outline regardless of rule order — including `Button`'s own. (Until R3-U-b it could
   * not have worked at all: the `:focus-visible` in `src/index.css` was unlayered and
   * outranked every Tailwind outline utility in the repo. It now lives in `@layer base`.)
   */
  const RING = [RING_SHADOW, "focus-visible:outline-none"];

  it("gives the tap target an inset ring, which is the only kind the preview cannot clip", () => {
    const classes = focusTapClasses(render(state("streaming"), { focus: { available: true } }))!;
    for (const token of RING) expect(classes).toContain(token);
    // The ring it replaces, which never rendered where it claimed to: `outline-offset-[-3px]`
    // lost to the unlayered global rule's `outline-offset: 2px`, putting the ring outside a
    // box that fills the clipping parent — so there was no visible indicator at all.
    expect(classes).not.toContain("focus-visible:outline-accent");
    expect(classes).not.toContain("focus-visible:outline-offset-[-3px]");
  });

  it("gives the torch the same ring, on its own fill where video never reaches it", () => {
    // Passing it through `className` is the point: the Button primitive's ring is drawn at
    // `outline-offset: 2px`, which is 2 px *outside* the solid fill and therefore on the
    // scrim. This one is inset, so it lands on `--bg-elev` — 16.96:1 dark, 19.02:1 light.
    const html = render(state("streaming"), {
      focus: { available: true },
      torch: { available: true, on: false },
    });
    const classes = buttonClasses(html, "Torch off")!;
    for (const token of RING) expect(classes).toContain(token);
    // `Button`'s own `outline-accent` is still in the list and is not this file's to remove;
    // `outline-none` above is what makes it inert. Asserted so a reader is not misled into
    // thinking the accent ring is what renders.
    expect(classes).toContain("focus-visible:outline-accent");
  });

  it("uses one ring for both, so the two controls cannot drift apart", () => {
    const html = render(state("streaming"), {
      focus: { available: true },
      torch: { available: true, on: true },
    });
    for (const classes of [focusTapClasses(html)!, buttonClasses(html, "Torch on")!]) {
      // Every stroke is a literal, so neither control can be re-derived under by a palette
      // change the way the guide box was (Z4), and both themes get the same ring.
      const ring = classes.filter((name) => name.startsWith("focus-visible:shadow-"));
      expect(ring).toEqual([RING_SHADOW]);
    }
  });
});

/**
 * §9-S1: "tap-to-refocus only if the platform supports `focusMode` constraints (otherwise
 * nothing)". §11 is the reason for the second half — focus constraints are inconsistent
 * across browsers and must degrade to a hidden control, never to an error — and P7 is the
 * reason it is nothing rather than a disabled button: a control that cannot work is worse
 * than no control at all in a yard, in the dark, with gloves on.
 */
describe("§9-S1 — tap-to-refocus, where the platform has it", () => {
  it("finds nothing to offer on a track that reports no capabilities at all", () => {
    // iOS Safari: `getCapabilities` is absent, so `useScanner` passes `undefined`. This is
    // the platform the whole "otherwise nothing" clause is written for.
    expect(pickFocusMode(undefined)).toBeNull();
  });

  it("finds nothing to offer when the capabilities name no focus mode", () => {
    // A camera that reports a lamp and nothing else still gets a torch button and no tap
    // target: the two capabilities are read off one call and answered separately.
    expect(pickFocusMode({})).toBeNull();
    expect(pickFocusMode({ torch: true })).toBeNull();
    expect(pickFocusMode({ focusMode: [] })).toBeNull();
    expect(pickFocusMode({ focusMode: ["none"] })).toBeNull();
  });

  it("ignores a focusMode that is not a list of modes", () => {
    // §11: inconsistent across browsers. A key reported as a bare string would throw inside
    // the camera-start path, which would turn a missing feature into a dead scanner.
    expect(pickFocusMode({ focusMode: "continuous" } as unknown as MediaTrackCapabilities)).toBe(
      null,
    );
  });

  it("asks for a single-shot refocus where the track offers one, and takes what it can", () => {
    // Android Chrome reports the list; a tap means "focus on this, now", so a one-shot pass
    // is the first choice, a restart of the continuous loop the second, and pinning focus
    // where it is the most a track offering only `manual` can do with a tap.
    expect(pickFocusMode({ focusMode: ["continuous", "single-shot", "manual"] })).toBe(
      "single-shot",
    );
    expect(pickFocusMode({ focusMode: ["continuous", "manual"] })).toBe("continuous");
    expect(pickFocusMode({ focusMode: ["manual"] })).toBe("manual");
  });

  it("renders no tap target at all when the platform reported no mode", () => {
    // The iOS screen, and the one every other test in this file renders: not a disabled
    // button, not an inert overlay — nothing (P7).
    for (const machineState of [state("streaming"), candidate(VIN_A)]) {
      const html = render(machineState);
      expect(focusTap(html)).toBeNull();
      expect(html).not.toContain(TAP_TO_FOCUS);
    }
  });

  it("makes the whole preview the target while the user is aiming", () => {
    // §6.1 floors a target at 48 px and the tap is aimed at the label the user is already
    // pointing at, so the target is the preview rather than a small button beside it.
    for (const machineState of [state("streaming"), candidate(VIN_A)]) {
      const tap = focusTap(render(machineState, { focus: { available: true } }));
      expect(tap?.label).toBe(TAP_TO_FOCUS);
      expect(tap?.attributes).toContain("inset-0");
    }
  });

  it("takes a tap and nothing else", () => {
    // N5 and §6.1 allow exactly one gesture: no long press, no swipe, no pinch. A handler
    // for any of those renders to markup identical to none, so the element's own props are
    // what is read here.
    const handlers = Object.keys(
      tapTarget(state("streaming"), { focus: { available: true } })!.props,
    )
      .filter((key) => key.startsWith("on"))
      .sort();
    expect(handlers).toEqual(["onClick"]);
  });

  it("wires the tap to the hook, which is the half no markup can show", () => {
    let taps = 0;
    const target = tapTarget(state("streaming"), {
      focus: { available: true, refocus: () => (taps += 1) },
    });
    const onClick = target?.props.onClick;
    expect(onClick).toBeTypeOf("function");
    (onClick as () => void)();
    expect(taps).toBe(1);
  });

  it("refuses to render at all without the focus API (R3-B)", () => {
    // R3-B shipped built and unwired: `focus` was optional, `ScanScreen` never passed it, the
    // default said "unavailable" and no tap target reached the running app on any platform.
    // A required prop is the only guard that catches that, because the bug is an *absence* —
    // there is no markup for a test to look at. `bun run typecheck` covers this file (tsconfig
    // includes `src`), so making `focus` optional again leaves the directive below unused,
    // which is a tsc error and reddens the §13.5 gate.
    const { focus, ...withoutFocus } = viewProps(state("streaming"), {
      focus: { available: true },
    });
    expect(focus.available).toBe(true);
    // @ts-expect-error R3-B: omitting `focus` must not typecheck.
    const props: ComponentProps<typeof CameraView> = withoutFocus;
    expect(props.torch.available).toBe(false);
  });

  it("shows no tap target once there is nothing live to focus", () => {
    // §6.3 stops the stream on `confirmed` and never started one in the other three, so a
    // tap could only apply a constraint to a track that is gone.
    for (const machineState of [
      state("requesting"),
      sighting(VIN_A, true),
      state("idle", true),
      { kind: "error", error: "permission_denied" } as ScanMachineState,
    ]) {
      expect(focusTap(render(machineState, { focus: { available: true } }))).toBeNull();
    }
  });

  it("leaves the aim box inert and the torch its own tap", () => {
    // The guide box is `pointer-events-none` on purpose (§6.1: it must never intercept a
    // tap), and the tap surface sits after it, so neither takes the other's tap.
    const html = render(state("streaming"), {
      focus: { available: true },
      torch: { available: true, on: false },
    });
    expect(html).toContain("pointer-events-none");
    expect(buttons(html)).toContain("Torch off");
    expect(focusTap(html)?.label).toBe(TAP_TO_FOCUS);
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

/**
 * The `unsaved` branch (R2-04). A confirmed read whose write failed must not wear the
 * success line, and must not wear the check-digit wording either: the read was fine, the
 * disk was not, and §6.1 makes this line the primary feedback so it has to point at the
 * right remedy.
 */
describe("a confirmed read that was not stored", () => {
  const VALID = "1HGCM82633A004352";
  const BAD_CHECK = "1HGCM82633A004353";

  it("shows the success line when the write landed", () => {
    expect(status(render(sighting(VALID, true)))).toEqual({
      text: "Got it ✓",
      tone: "text-ok",
    });
  });

  it("drops the success line when nothing was stored", () => {
    const line = status(render(sighting(VALID, true), { unsaved: true }));
    expect(line?.text).toBe("Not saved.");
    expect(line?.tone).toBe("text-warn");
  });

  it("does not blame the read for a storage failure", () => {
    // "Check this read." is the check-digit remedy and would send the user back to the
    // label for a fault that has nothing to do with it.
    expect(status(render(sighting(VALID, true), { unsaved: true }))?.text).not.toBe(
      "Check this read.",
    );
  });

  it("keeps the check-digit wording when that is the actual hold", () => {
    expect(status(render(sighting(BAD_CHECK, false)))).toEqual({
      text: "Check this read.",
      tone: "text-warn",
    });
    // And still does when a write also failed: the read is the thing to fix first.
    expect(status(render(sighting(BAD_CHECK, false), { unsaved: true }))?.text).toBe(
      "Check this read.",
    );
  });
});

/**
 * Round 3. `unsaved` is threaded into both `statusFor` and `statusToneFor`, and every case
 * above passes it only alongside a confirmed read — so the flag is *executed* on the other
 * five states and asserted on none of them. The combination is reachable: when Use as-is
 * fails to write, `ScanScreen` calls `rescan()` (so the machine returns to `streaming`)
 * while `error` is still set (so the failure banner is still up and `unsaved` is still
 * true). The user is then aiming at a live camera, and §6.4 owes them the aiming line.
 */
describe("a failed write says nothing about the state that follows it", () => {
  const VALID = "1HGCM82633A004352";

  it.each([
    ["requesting", state("requesting")],
    ["streaming", state("streaming")],
    ["candidate", candidate(VALID)],
    ["idle", state("idle", false)],
    ["idle.lost", state("idle", true)],
    ["error", { kind: "error", error: "permission_denied" } as ScanMachineState],
  ])("shows the same line and tone on %s whether or not a write failed", (_name, machineState) => {
    // "Not saved." belongs to the read it is about. Left to leak forwards it would sit
    // over a live preview telling the user their *next* scan had failed before they took
    // it, and §6.1 makes this line the primary feedback.
    expect(status(render(machineState, { unsaved: true }))).toEqual(status(render(machineState)));
  });

  it("still aims the user at the label while the failure banner is up", () => {
    // The exact state after Use as-is fails: rescan() returns the machine to streaming and
    // the "Couldn't save this VIN" banner is still on screen below.
    expect(status(render(state("streaming"), { unsaved: true }))).toEqual({
      text: "Point at the barcode on the door-jamb sticker.",
      tone: "text-fg-muted",
    });
  });
});
