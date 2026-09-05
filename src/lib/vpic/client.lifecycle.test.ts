/**
 * [M7] The parts of §4.7's client that leave no trace in the returned result: the abort
 * timer behind every attempt, and which failure a malformed body is reported as.
 *
 * `bun run mutate` removes `finally { clearTimeout(timer) }` and nothing notices, because
 * a leaked timer changes no field of `VpicResult`. It is still a defect on this path: the
 * timeout is armed per attempt and §4.7 allows three, so a decode of n rows leaves 3n live
 * timers, each holding an `AbortController` for a request that already landed, each firing
 * `controller.abort()` ten seconds later. The queue in §5.4 runs for the lifetime of the
 * app.
 *
 * The same run removes the `catch` around `response.json()`. That one is invisible for a
 * different reason: with the catch gone, `body` stays `undefined`, the guard below reports
 * "no Results[0]", and the existing test asserts only `/^Malformed response: /`, which both
 * strings satisfy. §5.1 stores `lastError` and the sheet shows it, so the difference is the
 * difference between "vPIC sent something that is not JSON" and "vPIC sent JSON with no
 * results" — two different things to tell a user, and two different things to debug.
 *
 * Nothing here contacts the network: every response is hand-built to §4.7's documented
 * shape.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeVin, VPIC_BACKOFF_MS } from "./client";

const VIN = "1HGCM82633A004352";
const noSleep = async (): Promise<void> => {};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function okBody(): unknown {
  return {
    Count: 1,
    Message: "synthetic",
    SearchCriteria: null,
    Results: [{ ErrorCode: "0", Make: "HONDA", Model: "Accord" }],
  };
}

afterEach(() => vi.useRealTimers());

describe("[M7] §4.7's per-attempt timeout is disarmed when the attempt ends", () => {
  it("leaves no timer behind after a request that succeeded", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchImpl = (async () => jsonResponse(okBody())) as typeof fetch;

    const result = await decodeVin(VIN, { fetchImpl, sleep: noSleep });

    expect(result.status).toBe("ok");
    // One `setTimeout(abort, 10000)` was armed for the attempt. It must not outlive it:
    // ten seconds later it would abort a controller for a request that already landed.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timer behind after a 4xx, which §4.7 does not retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchImpl = (async () => new Response("", { status: 404 })) as typeof fetch;

    const result = await decodeVin(VIN, { fetchImpl, sleep: noSleep });

    expect(result.status).toBe("pending");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timer behind after the whole three-attempt ladder has failed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchImpl = (async () => {
      throw new Error("Failed to fetch");
    }) as typeof fetch;

    const result = await decodeVin(VIN, { fetchImpl, sleep: noSleep });

    expect(result.status).toBe("pending");
    // Three attempts, three armed timeouts, and none of them still holding a controller.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits §4.7's own 2 s and 6 s when no sleep is injected, rather than not waiting", async () => {
    // The retry ladder is a real wait in the app: every other test injects `sleep`, so
    // this is the only place the default is exercised as a *duration* rather than as a
    // function that resolves. §4.7 gives 2 s then 6 s.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const calls: number[] = [];
    const fetchImpl = (async () => {
      calls.push(Date.now());
      throw new Error("Failed to fetch");
    }) as typeof fetch;

    let settled = false;
    const pending = decodeVin(VIN, { fetchImpl }).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(VPIC_BACKOFF_MS[0]! - 1);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(VPIC_BACKOFF_MS[1]! - 1);
    expect(calls).toHaveLength(2);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toMatchObject({ status: "pending" });
    expect(calls).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("[M7] a malformed body is reported as the failure it actually was", () => {
  it("names the parse failure when the body is not JSON, not a missing Results[0]", async () => {
    const fetchImpl = (async () =>
      new Response("<html>503 upstream</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as typeof fetch;

    const result = await decodeVin(VIN, { fetchImpl, sleep: noSleep });

    expect(result.status).toBe("pending");
    expect(result.lastError).toMatch(/^Malformed response: /);
    // The other malformed-body message, which is what this becomes if the `catch` around
    // `response.json()` stops running: vPIC did not send an envelope without results, it
    // sent a captive-portal page.
    expect(result.lastError).not.toBe("Malformed response: no Results[0]");
    expect(result.lastError).toMatch(/JSON|Unexpected|token/i);
  });

  it("still names the missing Results[0] when the body is JSON, so the two stay distinct", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ Count: 0, Message: "", SearchCriteria: null, Results: [] })) as typeof fetch;

    const result = await decodeVin(VIN, { fetchImpl, sleep: noSleep });

    expect(result.lastError).toBe("Malformed response: no Results[0]");
  });
});
