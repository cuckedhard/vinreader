/**
 * §4.10's `SyncStatus` and the order the six values are decided in. The chip copy (§6.4)
 * hangs off this one function, so the precedence is pinned rather than left to whoever
 * edits the branches next.
 */
import { describe, expect, it } from "vitest";

import { IDLE_SNAPSHOT, computeSyncStatus, sameSnapshot } from "./status";

const base = { signedIn: true, online: true, syncing: false, pending: 0, lastError: null };

describe("computeSyncStatus", () => {
  it("reports signed out before anything else, however many rows are queued", () => {
    expect(computeSyncStatus({ ...base, signedIn: false, pending: 14 })).toBe("signed_out");
    expect(computeSyncStatus({ ...base, signedIn: false, lastError: "x", syncing: true })).toBe(
      "signed_out",
    );
  });

  it("reports syncing while a request is out", () => {
    expect(computeSyncStatus({ ...base, syncing: true, pending: 3 })).toBe("syncing");
  });

  it("lets the radio outrank a stale error and a queue that cannot move", () => {
    expect(computeSyncStatus({ ...base, online: false, pending: 3, lastError: "x" })).toBe(
      "offline",
    );
    // Even with nothing queued: an offline device cannot know what another phone did, and
    // *"Synced"* would be a claim it has no way to check (N2).
    expect(computeSyncStatus({ ...base, online: false })).toBe("offline");
  });

  it("reports an error before a count, because a failing queue is not waiting", () => {
    expect(computeSyncStatus({ ...base, pending: 3, lastError: "denied" })).toBe("error");
  });

  it("reports the count, then Synced", () => {
    expect(computeSyncStatus({ ...base, pending: 3 })).toBe("pending");
    expect(computeSyncStatus(base)).toBe("synced");
  });
});

describe("sameSnapshot", () => {
  it("compares every field the chip renders", () => {
    expect(sameSnapshot(IDLE_SNAPSHOT, { ...IDLE_SNAPSHOT })).toBe(true);
    expect(sameSnapshot(IDLE_SNAPSHOT, { ...IDLE_SNAPSHOT, status: "synced" })).toBe(false);
    expect(sameSnapshot(IDLE_SNAPSHOT, { ...IDLE_SNAPSHOT, pending: 1 })).toBe(false);
    expect(sameSnapshot(IDLE_SNAPSHOT, { ...IDLE_SNAPSHOT, lastError: "x" })).toBe(false);
    expect(sameSnapshot(IDLE_SNAPSHOT, { ...IDLE_SNAPSHOT, lastPushAt: "x" })).toBe(false);
    expect(sameSnapshot(IDLE_SNAPSHOT, { ...IDLE_SNAPSHOT, lastPullAt: "x" })).toBe(false);
  });
});
