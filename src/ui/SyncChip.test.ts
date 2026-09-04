/**
 * §6.4's sync chip: four strings, six statuses, and one status that is not a chip at all.
 *
 * The mapping is the whole component — everything else is a `<Chip>` — so it is exported as
 * a pure function and pinned here. Vitest runs with `environment: "node"` and no DOM, so
 * this file imports the module and calls that function; the rendering itself (the link in
 * the error state, the 48 px target on it) is left to the e2e project.
 */
import { describe, expect, it } from "vitest";

import type { SyncSnapshot } from "../lib/sync/status";
import type { SyncStatus } from "../lib/vin/types";
import { SYNC_ERROR, SYNC_OFFLINE, SYNC_SYNCED, syncChipView, syncPendingLabel } from "./SyncChip";

function snapshot(status: SyncStatus, pending = 0, lastError: string | null = null): SyncSnapshot {
  return { status, pending, lastError, lastPushAt: null, lastPullAt: null };
}

describe("§6.4's four strings", () => {
  it("says Synced when there is nothing left to do", () => {
    expect(syncChipView(snapshot("synced"))).toEqual({
      label: SYNC_SYNCED,
      tone: "ok",
      details: false,
    });
  });

  it("counts the queue, in §6.4's shape", () => {
    // §6.4's example is *"3 pending"*, and §5.7 says the count is rows in the outbox.
    expect(syncPendingLabel(3)).toBe("3 pending");
    expect(syncChipView(snapshot("pending", 3))).toEqual({
      label: "3 pending",
      tone: "accent",
      details: false,
    });
  });

  it("says Offline — will sync, with an em dash", () => {
    expect(SYNC_OFFLINE).toBe("Offline — will sync");
    expect(syncChipView(snapshot("offline", 2))).toEqual({
      label: SYNC_OFFLINE,
      tone: "neutral",
      details: false,
    });
  });

  it("offers the details for an error, and is the only state that does", () => {
    expect(SYNC_ERROR).toBe("Sync error — tap for details");
    const view = syncChipView(snapshot("error", 1, "boom"));
    expect(view).toEqual({ label: SYNC_ERROR, tone: "danger", details: true });
  });
});

describe("the two statuses §6.4 has no words for", () => {
  it("renders nothing at all when signed out", () => {
    // N2: every §6.4 string is a claim about an account. A signed-out device — and a build
    // with no Supabase, which arrives here the same way — has none to describe, so the chip
    // is absent rather than reassuring. Signed-out History and Sheet look exactly as they
    // did before S4.
    expect(syncChipView(snapshot("signed_out"))).toBeNull();
    expect(syncChipView(snapshot("signed_out", 4))).toBeNull();
  });

  it("shows what a cycle in flight is moving out of, and invents no fifth string", () => {
    // Rows still queued: the count is true for the whole request, and it is the thing the
    // user acts on. Nothing queued: the account and the device agree, which is "Synced".
    expect(syncChipView(snapshot("syncing", 2))?.label).toBe("2 pending");
    expect(syncChipView(snapshot("syncing", 0))?.label).toBe(SYNC_SYNCED);
  });
});

describe("P7", () => {
  it("shows no chip for a status outside §4.10 rather than throwing", () => {
    const corrupt = { ...snapshot("synced"), status: "half_synced" as SyncStatus };
    expect(syncChipView(corrupt)).toBeNull();
  });

  it("never claims a pending count it was not given", () => {
    expect(syncChipView(snapshot("pending", 1))?.label).toBe("1 pending");
    expect(syncChipView(snapshot("pending", 137))?.label).toBe("137 pending");
  });
});
