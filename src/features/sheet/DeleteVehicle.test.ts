/**
 * The delete path's copy and its two-step shape, rendered to a string the way
 * `StructuralBlock.test.ts` does — vitest runs with `environment: "node"`, so this is the
 * whole of what can be checked here. What is left to the §7 item 4 device matrix and to
 * e2e: the taps themselves, the Dexie write behind them, and the live query swapping the
 * sheet for `DeletedNotice`.
 *
 * The claims below are the ones that would be wrong in a way nobody notices:
 * - the destructive button is **not** armed on arrival (Settings' "Clear all data" earns
 *   its confirmation the same way, and a delete that fires on the first tap of a scrolled
 *   sheet is the field failure this is guarding),
 * - nothing here says the delete is permanent, because §4.12 says it is not, and
 * - the confirmation names the vehicle it would delete.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  DELETED_BACK,
  DELETED_BODY,
  DELETED_TITLE,
  DELETE_ACTION,
  DELETE_BODY,
  DELETE_CANCEL,
  DELETE_CONFIRM_TITLE,
  DELETE_TITLE,
  DeleteConfirm,
  DeleteVehicle,
  DeletedNotice,
} from "./DeleteVehicle";

/** §4.11's fixture VIN, and its §4.1 display grouping. */
const VIN = "1HGCM82633A004352";
const GROUPED = "1HG CM826 3 3 A 004352";

/** What `textContent` would read: tags dropped, React's five escapes undone. */
function text(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

describe("the resting state", () => {
  const markup = renderToStaticMarkup(createElement(DeleteVehicle, { vin: VIN }));

  it("offers Delete without arming it", () => {
    expect(text(markup)).toContain(DELETE_TITLE);
    expect(text(markup)).toContain(DELETE_ACTION);
    expect(text(markup)).not.toContain(DELETE_CONFIRM_TITLE);
    expect(text(markup)).not.toContain(DELETE_CANCEL);
  });

  it("says where the vehicle goes and that a rescan brings it back (§4.12)", () => {
    expect(text(markup)).toContain(DELETE_BODY);
    expect(DELETE_BODY).toContain("brings it back");
  });

  it("never claims the delete is permanent", () => {
    // §6.4 gives "It can't be undone" and the typed DELETE to the cloud deletes. A
    // tombstone any later scan event clears is not either of those (§4.12).
    const words = text(markup).toLowerCase();
    expect(words).not.toContain("undone");
    expect(words).not.toContain("permanent");
    expect(words).not.toContain("forever");
    // And no typed confirmation: that is Settings' and the Account screen's marker for the
    // deletes that really are irreversible, and it means nothing once it is everywhere.
    expect(markup).not.toContain("<input");
    expect(words).not.toContain("delete to turn on");
  });
});

describe("the armed confirmation", () => {
  const markup = renderToStaticMarkup(
    createElement(DeleteConfirm, {
      vin: VIN,
      busy: false,
      onConfirm: () => {},
      onCancel: () => {},
    }),
  );

  it("asks, names the vehicle, and offers both ways out", () => {
    expect(text(markup)).toContain(DELETE_CONFIRM_TITLE);
    // §4.1 grouping: the sheet's own VIN heading can be scrolled far off screen by here.
    expect(text(markup)).toContain(GROUPED);
    expect(text(markup)).toContain(DELETE_ACTION);
    expect(text(markup)).toContain(DELETE_CANCEL);
  });

  it("announces itself, since it appears where a button was", () => {
    expect(markup).toContain('role="alert"');
  });

  it("disables both buttons while the delete is in flight, not just the destructive one", () => {
    const busy = renderToStaticMarkup(
      createElement(DeleteConfirm, {
        vin: VIN,
        busy: true,
        onConfirm: () => {},
        onCancel: () => {},
      }),
    );
    expect([...busy.matchAll(/disabled=""/g)]).toHaveLength(2);
  });
});

describe("the deleted state", () => {
  it("says the vehicle is gone from history and how to get it back", () => {
    const markup = renderToStaticMarkup(
      createElement(DeletedNotice, { vin: VIN, onBack: () => {} }),
    );
    expect(text(markup)).toContain(DELETED_TITLE);
    expect(text(markup)).toContain(DELETED_BODY);
    expect(text(markup)).toContain(GROUPED);
    expect(text(markup)).toContain(DELETED_BACK);
  });

  it("is not the same screen as a VIN this device never had", () => {
    const markup = renderToStaticMarkup(createElement(DeletedNotice, { vin: VIN }));
    expect(text(markup)).not.toContain("No record for this VIN.");
  });

  it("drops the route-only way out inside §6.6's pane, which has its own Close", () => {
    const markup = renderToStaticMarkup(createElement(DeletedNotice, { vin: VIN }));
    expect(text(markup)).not.toContain(DELETED_BACK);
    expect(text(markup)).toContain(DELETED_TITLE);
  });
});
