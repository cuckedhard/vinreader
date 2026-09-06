import { describe, expect, it } from "vitest";
import { errorLine } from "./errorLine";

/**
 * [F12, R3-F4] The two strings the ledger measured, and the rule that shapes them.
 *
 * Both were rendered to a field user: the boundary printed `${name}: ${message}` where
 * Dexie had already put the name inside the message, and the write path printed the same
 * doubled message without a name. §6.4 wants the underlying error shown and wants it terse.
 */
describe("errorLine (§6.4 tone, P7)", () => {
  function dexie(name: string, message: string): Error {
    const error = new Error(message);
    error.name = name;
    return error;
  }

  it("prints the fault once when Dexie has already named it inside the message", () => {
    // F12, verbatim: the rejected live query, measured in Chromium at 390x844.
    const lost = "Connection to Indexed Database server lost";
    expect(errorLine(dexie("UnknownError", `${lost}\n ${lost}`))).toBe(`UnknownError: ${lost}`);
    expect(errorLine(dexie("UnknownError", `${lost}\n UnknownError: ${lost}`))).toBe(
      `UnknownError: ${lost}`,
    );
  });

  it("prints the write failure once, with the name the message only implied", () => {
    // R3-F4, verbatim: `IDBObjectStore.put` throwing QuotaExceededError under Dexie.
    expect(
      errorLine(dexie("QuotaExceededError", "storage full\n QuotaExceededError: storage full")),
    ).toBe("QuotaExceededError: storage full");
  });

  it("keeps a cause that says something new", () => {
    // The other half of P7: a second line that is not a restatement is information, and
    // dropping it would be the silence this rule exists to avoid.
    expect(
      errorLine(dexie("DexieError", "Transaction aborted\n TypeError: x is not a function")),
    ).toBe("DexieError: Transaction aborted TypeError: x is not a function");
  });

  it("is one line whatever the engine put in the message", () => {
    const line = errorLine(dexie("UnknownError", "first\n\tsecond   fault\r\n third"));
    expect(line).toBe("UnknownError: first second fault third");
    expect(line).not.toMatch(/\s\s|\n|\r|\t/);
  });

  it("does not repeat a name the message already opens with", () => {
    expect(errorLine(dexie("AbortError", "AbortError: the tab went away"))).toBe(
      "AbortError: the tab went away",
    );
    // The name on its own is not repeated either.
    expect(errorLine(dexie("AbortError", "AbortError"))).toBe("AbortError");
  });

  it("falls back to whichever half exists", () => {
    expect(errorLine(dexie("QuotaExceededError", ""))).toBe("QuotaExceededError");
    expect(errorLine(dexie("QuotaExceededError", "   \n  "))).toBe("QuotaExceededError");
    const nameless = new Error("no name");
    nameless.name = "";
    expect(errorLine(nameless)).toBe("no name");
  });

  it("still prints a thrown non-error, on one line", () => {
    expect(errorLine("boom")).toBe("boom");
    expect(errorLine("boom\n boom")).toBe("boom");
    expect(errorLine(42)).toBe("42");
    expect(errorLine(null)).toBe("null");
    expect(errorLine(undefined)).toBe("undefined");
    expect(errorLine({ toString: () => "odd\nthing" })).toBe("odd thing");
  });

  it("never returns a string a screen would have to shape again", () => {
    for (const value of [
      dexie("UnknownError", "a\nb"),
      dexie("", ""),
      "  spaced  out  ",
      new Error("plain"),
    ]) {
      const line = errorLine(value);
      expect(line).toBe(line.trim());
      expect(line).not.toMatch(/[\n\r\t]|\s{2}/);
    }
  });
});
