/**
 * [F1-b] The storage-availability signal, on the path that can actually report.
 *
 * `liveQuery` cannot: Dexie filters `DatabaseClosedError` before `observer.error`, so a
 * database that never opens produces no value and no error, and every screen that reads
 * `undefined` as "still loading" waits forever. These tests are about `probeStorage`
 * answering instead of hanging or throwing; the rendering half is
 * `tests/e2e/storage-never-opens.spec.ts`, which breaks IndexedDB in a real browser.
 */
import Dexie from "dexie";
import { describe, expect, it, vi } from "vitest";

import { probeStorage } from "./availability";

/** P7 keeps the reason in the console too, and a spy keeps the suite's output readable. */
function quiet(): { restore: () => void; calls: () => number } {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return { restore: () => spy.mockRestore(), calls: () => spy.mock.calls.length };
}

describe("[F1-b] probeStorage", () => {
  it("reports ok when the database opens", async () => {
    // The suite's own database (fake-indexeddb, src/lib/storage/test-setup.ts).
    await expect(probeStorage()).resolves.toEqual({ ok: true });
  });

  it("answers with the reason rather than throwing it", async () => {
    // A caller that has to try/catch is a caller that can forget to, and this one is a
    // screen deciding what to render.
    const cause = new Dexie.DexieError("MissingAPIError", "indexedDB API missing");
    const log = quiet();
    await expect(probeStorage(() => Promise.reject(cause))).resolves.toEqual({ ok: false, cause });
    // P7: quietly in the log as well as loudly on screen.
    expect(log.calls()).toBe(1);
    log.restore();
  });

  it("answers for a rejection that is not a Dexie error at all", async () => {
    // `indexedDB.open` throwing outright — an enterprise policy, an opaque-origin frame —
    // rejects with a bare DOMException, which is why the notice is told `fromStorage`
    // rather than left to infer it (N2, `FailureNotice`).
    const cause = new DOMException("The user denied permission…", "SecurityError");
    const log = quiet();
    await expect(probeStorage(() => Promise.reject(cause))).resolves.toEqual({ ok: false, cause });
    log.restore();
  });

  it("stays a failure when the rejection carries no reason at all", async () => {
    // Why the answer is a union and not "the reason, or null": a screen that read a missing
    // reason as "storage is fine" would go back to waiting for a row that is not coming,
    // which is F1-b exactly.
    const log = quiet();
    for (const thrown of [undefined, null, "boom", 0]) {
      await expect(probeStorage(() => Promise.reject(thrown))).resolves.toEqual({
        ok: false,
        cause: thrown,
      });
    }
    log.restore();
  });
});
