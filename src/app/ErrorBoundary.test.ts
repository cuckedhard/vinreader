/**
 * The floor under `createRoot`, minus the pixels.
 *
 * vitest runs with `environment: "node"`, and React's server renderer does not run error
 * boundaries at all — so the *catching* is proven where it can be, in
 * `tests/e2e/storage-unavailable.spec.ts`, which breaks IndexedDB in a real browser and
 * asserts the app is still an app. What is provable here is everything the boundary decides:
 * the state a throw produces, which of the two sentences a given error earns (N2 — the
 * storage line must not be shown for a bug that had nothing to do with storage), and the
 * strings themselves, which §6.4 does not yet carry and which nothing else pins.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Dexie from "dexie";
import { describe, expect, it } from "vitest";

import { ErrorBoundary, FailureNotice, isStorageError } from "./ErrorBoundary";

function render(error: unknown): string {
  return renderToStaticMarkup(createElement(FailureNotice, { error }));
}

/** The same notice, told where the failure came from rather than left to infer it. */
function renderFromStorage(error: unknown): string {
  return renderToStaticMarkup(createElement(FailureNotice, { error, fromStorage: true }));
}

/** What `useLiveQuery` re-throws when a live query rejects: always a Dexie error. */
function dexieError(): Error {
  return new Dexie.DexieError("UnknownError", "Connection to Indexed Database server lost");
}

describe("what a throw does to the boundary", () => {
  it("records the thrown value and switches to the fallback", () => {
    const error = dexieError();
    expect(ErrorBoundary.getDerivedStateFromError(error)).toEqual({ caught: true, error });
  });

  it("treats a thrown null as caught, because React allows one", () => {
    // `caught` is a separate flag for exactly this: `{ error: null }` alone is
    // indistinguishable from "nothing has gone wrong", and the app would render an empty
    // outlet forever instead of a notice.
    expect(ErrorBoundary.getDerivedStateFromError(null)).toEqual({ caught: true, error: null });
  });
});

describe("storage saying no, against a bug", () => {
  it("counts every Dexie failure as storage", () => {
    expect(isStorageError(dexieError())).toBe(true);
    expect(isStorageError(new Dexie.DexieError("DatabaseClosedError", "closed"))).toBe(true);
  });

  it("counts nothing else as storage (N2)", () => {
    expect(isStorageError(new TypeError("x is not a function"))).toBe(false);
    expect(isStorageError(new DOMException("denied", "SecurityError"))).toBe(false);
    expect(isStorageError("boom")).toBe(false);
    expect(isStorageError(null)).toBe(false);
  });
});

describe("what the notice says", () => {
  it("names storage, the retry and what still works, when storage is the fault", () => {
    const markup = render(dexieError());
    expect(markup).toContain("Storage isn&#x27;t available");
    expect(markup).toContain(
      "This device won&#x27;t let VIN Relay read its saved vehicles. Reload to try again — you " +
        "can still scan or type a VIN, but nothing can be saved until storage is back.",
    );
    // P7: the underlying error is on screen, not only in the console.
    expect(markup).toContain("Connection to Indexed Database server lost");
  });

  it("does not blame storage for a fault that was not storage (N2)", () => {
    const markup = render(new TypeError("record.decode is undefined"));
    expect(markup).toContain("This screen didn&#x27;t load");
    expect(markup).toContain(
      "Something on it failed while it was being drawn. Reload to try again.",
    );
    expect(markup).not.toContain("Storage");
    expect(markup).toContain("TypeError: record.decode is undefined");
  });

  it("names storage when the caller knows it was storage, whatever the error type (F1-b)", () => {
    // `indexedDB.open` throwing outright rejects with a bare DOMException, which
    // `isStorageError` refuses to call storage — correctly, for a value caught out of a
    // render (N2, the test above). `probeStorage` is not inferring: it awaited `db.open()`,
    // so it says so, and the screen that waits on a live query that will never emit gets
    // the sentence about storage rather than the one about a screen that did not draw.
    const markup = renderFromStorage(new DOMException("denied", "SecurityError"));
    expect(markup).toContain("Storage isn&#x27;t available");
    expect(markup).toContain("SecurityError: denied");
    // The flag adds a fault to the storage sentence; it never takes one away.
    expect(renderFromStorage(dexieError())).toContain("Storage isn&#x27;t available");
    expect(render(new DOMException("denied", "SecurityError"))).toContain(
      "This screen didn&#x27;t load",
    );
  });

  it("still prints a thrown non-error", () => {
    expect(render("boom")).toContain("boom");
  });

  it("is an alert whose only action is Reload (§6.1, P7)", () => {
    const markup = render(dexieError());
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Reload");
    // The *size* of that action is deliberately not asserted here. A class token in static
    // markup says nothing about the rendered box: `Banner`'s action row carries
    // `[&>*]:min-h-[var(--tap)]` at (0,1,1), which outranks the primary variant's own
    // `min-h-[var(--tap-lg)]` at (0,1,0), so this markup can contain the 56 px class while
    // the pixels are 48 — which is exactly what it did. That is the dead-guard class the
    // ledger records at R4-H' and R4-B: an assurance whose instrument could not fail.
    // The 56 px is measured in a real cascade, in Chromium, by
    // `tests/e2e/storage-unavailable.spec.ts` ("the Reload out of the notice is a 56 px
    // target"), which measures the box and goes red at 48.
  });
});
