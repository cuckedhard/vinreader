import type { JSX } from "react";
import { refusalRead, refusalReason } from "./refusalText";
import { VIN_TEXT_SIZES } from "../ui/VinDisplay";
import type { NoVin } from "../lib/vin/types";

/**
 * The two lines every refusal shows: **what was read**, then **why it is not a VIN**.
 *
 * One component rather than three copies, because all three surfaces owe the same answer —
 * the camera, the typed field and the Import paste box — and the finding behind it is that
 * a refusal said nothing anywhere. The wrapper is the surface's (a banner on the scan and
 * Import screens, the feedback panel under the field), and so is the remedy underneath;
 * what is here is the part that must not drift between them (§7 item 5).
 *
 * **The read is set like a VIN and not grouped like one.** §6.1 puts the VIN in monospace
 * at ≥ 28 px because it is read off a sticker at arm's length in bad light, and this text
 * is read in exactly that position — it is the string the user is comparing against the
 * label in front of them, which is the whole point of showing it. `VIN_TEXT_SIZES` is
 * imported rather than restated, for the reason `VinDisplay` names on the way out: a paint
 * code borrows the size the same way. What it does *not* borrow is `groupVin` — §4.1's
 * 3-6-1-1-1-6 grouping is a claim about a VIN's structure, and printing an arbitrary read
 * in a VIN's groups would say something about it that nothing knows (N2).
 */
export function RefusedRead({ refusal }: { refusal: NoVin }): JSX.Element {
  return (
    <>
      <p className={`font-vin font-semibold break-words text-fg ${VIN_TEXT_SIZES.lg}`}>
        {refusalRead(refusal)}
      </p>
      <p className="mt-2 text-base leading-snug text-fg-muted">{refusalReason(refusal)}</p>
    </>
  );
}
