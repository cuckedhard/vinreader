/**
 * What Settings decides, minus the pixels.
 *
 * vitest runs with `environment: "node"` and no DOM, so nothing here renders the screen;
 * the parts of it that *can* be wrong without a browser are the ones that map state onto
 * copy, and this is that map. Everything else Settings does for S4 — the Account link's
 * target, the 56 px target, the confirmation gate, the wipe's ordering against the sync
 * engine, and the 7:1 floor in both themes — is Playwright's, and the session report says
 * so rather than pretending a node runner checked it.
 */
import { describe, expect, it } from "vitest";

import type { SyncStatus } from "../../lib/vin/types";
import { accountIsLinked } from "./SettingsScreen";

/** §4.10, locked. Written out so a member added upstream fails here, not in a parking lot. */
const ALL_STATUSES: SyncStatus[] = [
  "signed_out",
  "synced",
  "pending",
  "syncing",
  "offline",
  "error",
];

describe("does this device have an account", () => {
  it("is false only when signed out", () => {
    expect(accountIsLinked("signed_out")).toBe(false);
    for (const status of ALL_STATUSES.filter((value) => value !== "signed_out")) {
      expect(accountIsLinked(status), status).toBe(true);
    }
  });

  it("counts an offline or failing device as having one", () => {
    // The warning this drives is that the account will refill this phone after "Clear all
    // data". A phone with no signal, or one whose last push failed, still has an account
    // that does exactly that — saying otherwise would be a guess presented as a fact (N2).
    expect(accountIsLinked("offline")).toBe(true);
    expect(accountIsLinked("error")).toBe(true);
  });
});
