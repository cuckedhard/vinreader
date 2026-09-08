import { expect, test } from "@playwright/test";
import { NOTHING, writeQrY4m } from "./qr-video";
import { extractVinExplained } from "../../src/lib/vin/extractVin";

/**
 * [FR-6] The third door onto one defect: a §4.9 carrier's rejection must not come back after
 * the read that replaced it goes away.
 *
 * R3-F5 stopped the rejection outliving its code by *suppressing* it whenever the machine held
 * a read — `state.kind !== "candidate" && state.kind !== "confirmed"` — and FR-4 added the
 * agreed refusal. Neither *ends* it: `carrierError` was `ScanScreen`'s own `useState` and
 * nothing outside the screen's own handlers ever cleared it, so every route back to `streaming`
 * from a state that merely suppressed the banner re-raised it. One frame of a VIN label moves
 * the machine to `candidate`; if no second frame agrees, §6.3's `tick` puts it back to
 * `streaming` 1.5 s later — and the rejection is on screen again, now about a code two codes
 * ago, with nothing at all in front of the camera (N2, P7). `tick` is only the cheapest door;
 * `visible` after a hide past §6.3's window did it too, which is why the fix is in the machine
 * and `scanMachine.carrier.test.ts` holds that half.
 *
 * One video, one scene, in the order a phone would see it: **a label, then a code the app
 * cannot read, then the label again, then nothing.** It asserts the two facts the fix rests on
 * and they are the same fact from two sides — each notice is about the last code the camera
 * read, and no state of the machine hides it or holds it:
 *
 *  1. a rejection raised *while a candidate stands* is on screen, beside "Reading… hold steady."
 *     (the carrier is the newer read of the two, so the state guard was hiding a notice about
 *     the code in the frame — which is why FR-6 removes that term rather than adding a fourth);
 *  2. a rejection whose code has been replaced by a VIN is gone and stays gone through the
 *     candidate lapsing and six-plus seconds of empty frames, which is the finding.
 *
 * The empty frames are what `NOTHING` is for. A QR of an empty string would not do: it is a
 * perfectly readable symbol §4.2 refuses, which raises the *refusal* banner and takes FR-4's
 * path instead of this one.
 *
 * Its own spec file because Playwright will not take `test.use({ launchOptions })` inside a
 * describe.
 */

/** §4.9's URL carrier, declaring a version this app does not read (P6). */
const BODY = Buffer.from(
  JSON.stringify({ v: 2, vin: "1HGCM82633A004352", mk: "HONDA", md: "Accord" }),
  "utf8",
)
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

/**
 * Distinct VINs, each in shot for two frames — 67 ms — and never again in the whole video.
 * §6.3 confirms on "a second identical normalized VIN within 1.5 s", and ZXing is configured to
 * wait 100 ms between attempts (`SCAN_DELAY_MS`), so no two decodes can land inside one VIN's
 * 67 ms window: **the two-read agreement can never be met here**, by construction rather than
 * by timing luck. Every decode replaces the candidate, none confirms, nothing is written and
 * the screen never leaves `/#/scan`. The two runs are disjoint for the same reason — the second
 * starts more than §6.3's window after the first ends, and takes different VINs anyway.
 */
const VINS = Array.from({ length: 36 }, (_, i) => `1HGCM82633A0${10000 + i}`);
const FIRST_LOOK = VINS.slice(0, 6);
const SECOND_LOOK = VINS.slice(6);

/** Two frames each, in the order the camera sees them. */
function segmentsOf(vins: readonly string[]): (readonly [string, number])[] {
  return vins.map((vin) => [vin, 2] as const);
}

const Y4M = writeQrY4m("carrier-then-lapse", [
  // A fifth of a second of label: enough for §6.3 to take a candidate, not enough to confirm.
  ...segmentsOf(FIRST_LOOK),
  // A second and a half of the carrier, landing while that candidate still stands. One frame is
  // enough for §6.4's rejection, because a §4.9 payload identifies itself.
  [`https://vinrelay.example/#/i?d=${BODY}`, 45],
  // Two seconds of labels again — the read that replaces the code the banner is about.
  ...segmentsOf(SECOND_LOOK),
  // Ten seconds of nothing at all. §6.3's window runs out 1.5 s into this, and from there the
  // camera is pointed at no code whatsoever: anything on screen now is about a code the camera
  // has not seen for seconds.
  [NOTHING, 300],
]);

test.use({
  launchOptions: {
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${Y4M}`,
    ],
  },
});

/** §6.4's candidate line, verbatim from §6.4 — the status line is one line per state. */
const READING = "Reading… hold steady.";
/** §6.4's rejection title for one of the app's own codes. */
const REJECTED = "Couldn't read that code";
/** §6.4's `streaming` line, which is how the lapse back out of `candidate` is read. */
const PROMPT = "Point at the barcode on the door-jamb sticker.";

test("[FR-6] a carrier's rejection ends with the read that replaced it, not with the state", async ({
  page,
}) => {
  // The scene's own preconditions, asserted rather than assumed. Every VIN has to be a §4.2
  // *sighting* — a read §4.2 refused would raise the refusal banner and take FR-4's path, not
  // this one — and no VIN may repeat, or §6.3 could confirm one and this would be a different
  // scene entirely.
  for (const vin of VINS) {
    const read = extractVinExplained(vin);
    expect(read.ok, `${vin} must be a sighting, not a refusal`).toBe(true);
  }
  expect(new Set(VINS).size, "a repeated VIN could confirm").toBe(VINS.length);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/scan");

  // A VIN label takes the frame first, so §6.3 is holding a candidate when the code that cannot
  // be read arrives. Both notices are read in one snapshot, because the point is that they are
  // on screen *at the same instant*: the carrier is the newer of the two reads, so the rejection
  // §6.4 owes it may not wait for an unrelated candidate to lapse. `toPass` retries the pair
  // rather than each half, so a run where they merely took turns cannot satisfy it.
  await expect(async () => {
    const seen = await page.evaluate((rejected) => {
      const alerts = Array.from(document.querySelectorAll('[role="alert"]'), (node) =>
        (node.textContent ?? "").trim(),
      );
      return {
        reading: (document.body.textContent ?? "").includes("Reading… hold steady."),
        rejected: alerts.some((text) => text.includes(rejected)),
      };
    }, REJECTED);
    expect(
      seen,
      "§6.4/N2: the rejection for the code in the frame waited for a candidate to lapse",
    ).toEqual({ reading: true, rejected: true });
  }).toPass({ timeout: 20_000, intervals: [100] });

  // The label comes back, and a VIN in the frame is what ends this rejection — not a state that
  // hides it. The read that replaced it is a candidate again, and it can never confirm.
  await expect(page.getByText(READING)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);

  // No second frame ever agrees, so §6.3's window runs out and the machine returns to
  // `streaming` — the door the finding was reproduced through.
  await expect(page.getByText(PROMPT)).toBeVisible({ timeout: 20_000 });

  // The finding. There is nothing in front of the camera at all, and the code that banner
  // describes left the frame two codes ago (N2, P7).
  await expect(
    page.getByText(REJECTED),
    "N2/P7: the carrier's rejection came back when the read that replaced it lapsed",
  ).toHaveCount(0);

  // And it stays gone while the camera keeps decoding nothing. Sampled without auto-waiting,
  // for the reason `scan-not-a-vin.spec.ts` gives at length: a retrying assertion is built to
  // look past exactly the transience being measured, and would report the one instant the
  // banner happened to be down. The ledger's trace was 33 consecutive samples of the rejection
  // over six seconds of blank frames; this is twenty over four, and a failure prints the trace
  // itself — `00000…` is silence and `11111…` is the finding.
  const alerts = page.locator('[role="alert"]');
  const presence: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    presence.push(await alerts.count());
    await page.waitForTimeout(200);
  }
  expect(presence.join("")).toBe("0".repeat(20));

  // N1: nothing here stopped the stream. The camera is still running, still says where to
  // point it, still offers the keyboard, and nothing was written or navigated to.
  await expect(page.getByText(PROMPT)).toBeVisible();
  await expect(page.getByRole("button", { name: "Type VIN instead" })).toBeVisible();
  await expect(page).toHaveURL(/#\/scan$/);
});
