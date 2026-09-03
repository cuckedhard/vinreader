import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeVin } from "./client";

const VIN = "1HGCM82633A004352";
const ok = (body: unknown) =>
  ({ ok: true, status: 200, statusText: "OK", json: async () => body }) as unknown as Response;

/**
 * The defensive paths in client.ts: the real timer used when no sleep is injected,
 * a rejection that is not an Error, and response bodies whose Results[0] is not an
 * object. §13.5 gates branches, and these are branches.
 */
afterEach(() => vi.useRealTimers());

describe("client environment fallbacks", () => {
  it("sleeps on real timers when no sleep is injected", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    const pending = decodeVin(VIN, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pending;
    expect(result.status).toBe("pending");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("describes a rejection that is not an Error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue("socket vanished");
    const result = await decodeVin(VIN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    });
    expect(result.status).toBe("pending");
    expect(result.lastError).toContain("socket vanished");
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "nope"],
  ])("treats Results[0] being %s as malformed", async (_label, first) => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ Count: 1, Results: [first] }));
    const result = await decodeVin(VIN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    });
    expect(result.status).toBe("pending");
    expect(result.fields).toEqual({});
  });
});

describe("client transport edges", () => {
  it("reports a status with no statusText", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "",
      json: async () => ({}),
    } as unknown as Response);
    const result = await decodeVin(VIN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    });
    expect(result.lastError).toBe("HTTP 503");
  });

  it("treats a body that is not an object as malformed", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok("not an object"));
    const result = await decodeVin(VIN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    });
    expect(result.status).toBe("pending");
  });

  it("falls back to the error name when the message is empty", async () => {
    const bare = new Error("");
    bare.name = "AbortError";
    const fetchImpl = vi.fn().mockRejectedValue(bare);
    const result = await decodeVin(VIN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    });
    expect(result.lastError).toContain("AbortError");
  });

  it("uses the global fetch when none is injected", async () => {
    const globalFetch = vi
      .fn()
      .mockResolvedValue(
        ok({ Count: 1, Results: [{ ErrorCode: "0", Make: "HONDA", Model: "Accord" }] }),
      );
    vi.stubGlobal("fetch", globalFetch);
    const result = await decodeVin(VIN, { sleep: async () => {} });
    vi.unstubAllGlobals();
    expect(globalFetch).toHaveBeenCalledOnce();
    expect(result.status).toBe("ok");
  });
});
