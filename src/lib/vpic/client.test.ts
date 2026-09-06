/**
 * §4.7 client tests.
 *
 * Every response here is SYNTHETIC: it is constructed from the field shape §4.7
 * documents, not captured from vpic.nhtsa.dot.gov. The network is unavailable in this
 * environment, so no live response was ever seen. Field values are plausible fillers.
 */
import { describe, expect, it } from "vitest";
import { VPIC_BACKOFF_MS, VPIC_ENDPOINT, VPIC_TIMEOUT_MS, decodeVin } from "./client";
import type { VpicRawResponse } from "./types";

const VIN = "1HGCM82633A004352"; // §4.11 fixture: grammar ok, check digit valid.

type Step = (init?: RequestInit) => Promise<Response>;

function envelope(results: Array<Record<string, string>>): VpicRawResponse {
  return {
    Count: results.length,
    Message: "Results returned successfully. NOTE: ...",
    SearchCriteria: `VIN:${VIN}`,
    Results: results,
  };
}

const OK_RESULT: Record<string, string> = {
  ErrorCode: "0",
  ErrorText: "0 - VIN decoded clean. Check Digit (9th position) is correct",
  Make: "HONDA",
  Model: "Accord",
  ModelYear: "2003",
  Manufacturer: "HONDA OF AMERICA MFG., INC.",
  VehicleType: "PASSENGER CAR",
  BodyClass: "Coupe",
  PlantCity: "MARYSVILLE",
  PlantCountry: "UNITED STATES (USA)",
};

function json(body: unknown, status = 200): Step {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
}

function raw(text: string, status = 200, statusText?: string): Step {
  return () => Promise.resolve(new Response(text, { status, statusText }));
}

function throws(message: string): Step {
  return () => Promise.reject(new TypeError(message));
}

/** A request that never settles on its own — only the client's AbortController ends it. */
function hangs(): Step {
  return (init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted.", "AbortError")),
      );
    });
}

/** Replays `steps` in order; the last step repeats for any further call. */
function fakeFetch(...steps: Step[]) {
  const calls: string[] = [];
  const impl: typeof fetch = (input, init) => {
    calls.push(String(input));
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    return step(init);
  };
  return { impl, calls };
}

function recorder() {
  const sleeps: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    sleeps.push(ms);
    return Promise.resolve();
  };
  return { sleeps, sleep };
}

describe("§4.7 constants", () => {
  it("pins the endpoint, timeout and backoff ladder", () => {
    expect(VPIC_ENDPOINT).toBe("https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues");
    expect(VPIC_TIMEOUT_MS).toBe(10000);
    expect(VPIC_BACKOFF_MS).toEqual([2000, 6000]);
  });
});

describe("decodeVin — request", () => {
  it("calls the §4.7 URL once for a VIN that decodes", async () => {
    const fake = fakeFetch(json(envelope([OK_RESULT])));
    const { sleep } = recorder();

    await decodeVin(VIN, { fetchImpl: fake.impl, sleep });

    expect(fake.calls).toEqual([
      "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/1HGCM82633A004352?format=json",
    ]);
  });
});

describe("decodeVin — status", () => {
  it("maps ErrorCode 0 to ok", async () => {
    const fake = fakeFetch(json(envelope([OK_RESULT])));
    const { sleep, sleeps } = recorder();

    const result = await decodeVin(VIN, { fetchImpl: fake.impl, sleep });

    expect(result.status).toBe("ok");
    expect(result.fields.Make).toBe("HONDA");
    expect(result.fields.Model).toBe("Accord");
    expect(result.fields.ModelYear).toBe("2003");
    expect(result.lastError).toBeNull();
    expect(sleeps).toEqual([]);
  });

  it("maps any other ErrorCode to partial and surfaces ErrorText", async () => {
    const fake = fakeFetch(
      json(
        envelope([
          {
            ErrorCode: "1",
            ErrorText: "1 - Check Digit (9th position) does not calculate properly",
            Make: "HONDA",
            Model: "Accord",
            ModelYear: "",
          },
        ]),
      ),
    );
    const { sleep } = recorder();

    const result = await decodeVin(VIN, { fetchImpl: fake.impl, sleep });

    expect(result.status).toBe("partial");
    expect(result.errorText).toBe("1 - Check Digit (9th position) does not calculate properly");
    expect(result.fields.Make).toBe("HONDA");
    expect(result.lastError).toBeNull();
  });

  it("keeps errorText null when ErrorText is absent or empty", async () => {
    const fake = fakeFetch(
      json(envelope([{ ErrorCode: "0", ErrorText: "", Make: "DEERE", Model: "310SL" }])),
    );
    const { sleep } = recorder();

    const result = await decodeVin(VIN, { fetchImpl: fake.impl, sleep });

    expect(result.status).toBe("ok");
    expect(result.errorText).toBeNull();
  });

  // §4.7 off-highway rule. It is the more specific of the two status rules, so it wins
  // over ErrorCode in both directions.
  it("is unsupported when Make and Model are empty even with ErrorCode 0", async () => {
    const fake = fakeFetch(
      json(
        envelope([
          {
            ErrorCode: "0",
            ErrorText: "0 - VIN decoded clean. Check Digit (9th position) is correct",
            Make: "",
            Model: "",
            ManufacturerId: "",
            VehicleType: "",
          },
        ]),
      ),
    );
    const { sleep } = recorder();

    const result = await decodeVin(VIN, { fetchImpl: fake.impl, sleep });

    expect(result.status).toBe("unsupported");
  });

  it("is unsupported when Make and Model are absent and ErrorCode is not 0", async () => {
    const fake = fakeFetch(
      json(envelope([{ ErrorCode: "6", ErrorText: "6 - Incomplete VIN", VehicleType: "" }])),
    );
    const { sleep } = recorder();

    const result = await decodeVin(VIN, { fetchImpl: fake.impl, sleep });

    expect(result.status).toBe("unsupported");
    expect(result.errorText).toBe("6 - Incomplete VIN");
  });

  it("stays partial when only one of Make and Model is missing", async () => {
    const fake = fakeFetch(
      json(envelope([{ ErrorCode: "1", ErrorText: "1 - Check Digit", Make: "", Model: "Accord" }])),
    );
    const { sleep } = recorder();

    const result = await decodeVin(VIN, { fetchImpl: fake.impl, sleep });

    expect(result.status).toBe("partial");
  });
});

describe("decodeVin — fields", () => {
  it("strips empty-string values so unknowns never reach the record", async () => {
    const fake = fakeFetch(
      json(
        envelope([
          {
            ErrorCode: "0",
            Make: "HONDA",
            Model: "Accord",
            Trim: "",
            Series: "",
            EngineCylinders: "4",
          },
        ]),
      ),
    );
    const { sleep } = recorder();

    const result = await decodeVin(VIN, { fetchImpl: fake.impl, sleep });

    expect(result.fields).toEqual({
      ErrorCode: "0",
      Make: "HONDA",
      Model: "Accord",
      EngineCylinders: "4",
    });
    expect(result.fields).not.toHaveProperty("Trim");
    expect(result.fields).not.toHaveProperty("Series");
  });

  it("[M7] keeps a value that is not a string out of the record at all", async () => {
    // §4.7: "every field is a string, and an empty one means unknown". Both halves of that
    // sentence are one guard — `typeof value === "string" && value !== ""` — and only the
    // second half was measured, because every synthetic response in this file is already
    // all strings. `bun run mutate` forces the first half to `true` and survives.
    //
    // What the mutant admits is not cosmetic. `VpicResult.fields` is typed
    // `Record<string, string>`, `applyDecodeResult` writes it onto the §5.1 record and the
    // §4.8 sheet renders each value as it stands, so a JSON number under a §4.8 key would
    // be shown as a fact of the vehicle and a `null` would render as the word "null" —
    // N2, from the one source §4.7 calls authoritative. The type says it cannot happen;
    // this is the boundary where the type stops being true, so the check belongs here and
    // the test with it.
    const fake = fakeFetch(
      json({
        Count: 1,
        Message: "synthetic",
        SearchCriteria: `VIN:${VIN}`,
        // Deliberately off-contract, which is the whole point: a number, a null and a
        // nested object where §4.7 promises strings.
        Results: [{ ErrorCode: "0", Make: "HONDA", Model: "Accord", Doors: 4, Trim: null }],
      }),
    );
    const { sleep } = recorder();

    const result = await decodeVin(VIN, { fetchImpl: fake.impl, sleep });

    expect(result.fields).toEqual({ ErrorCode: "0", Make: "HONDA", Model: "Accord" });
    for (const value of Object.values(result.fields)) expect(typeof value).toBe("string");
  });
});

describe("decodeVin — malformed responses", () => {
  it("returns pending when Results is an empty array", async () => {
    const fake = fakeFetch(json(envelope([])));
    const { sleep } = recorder();

    const result = await decodeVin(VIN, { fetchImpl: fake.impl, sleep });

    expect(result.status).toBe("pending");
    expect(result.fields).toEqual({});
    expect(result.errorText).toBeNull();
    expect(result.lastError).toBe("Malformed response: no Results[0]");
    expect(fake.calls).toHaveLength(1);
  });

  it("returns pending when Results is missing", async () => {
    const fake = fakeFetch(json({ Count: 0, Message: "", SearchCriteria: null }));
    const { sleep } = recorder();

    const result = await decodeVin(VIN, { fetchImpl: fake.impl, sleep });

    expect(result.status).toBe("pending");
    expect(result.lastError).toBe("Malformed response: no Results[0]");
  });

  it("returns pending when the body is not JSON", async () => {
    const fake = fakeFetch(raw("<html>503 upstream</html>"));
    const { sleep } = recorder();

    const result = await decodeVin(VIN, { fetchImpl: fake.impl, sleep });

    expect(result.status).toBe("pending");
    expect(result.lastError).toMatch(/^Malformed response: /);
    expect(fake.calls).toHaveLength(1);
  });
});

describe("decodeVin — retries", () => {
  it("retries a network throw three times, backing off 2 s then 6 s", async () => {
    const fake = fakeFetch(throws("Failed to fetch"));
    const { sleep, sleeps } = recorder();

    const result = await decodeVin(VIN, { fetchImpl: fake.impl, sleep });

    expect(fake.calls).toHaveLength(3);
    expect(sleeps).toEqual([2000, 6000]);
    expect(result.status).toBe("pending");
    expect(result.fields).toEqual({});
    expect(result.lastError).toBe("Network error: Failed to fetch");
  });

  it("retries a 5xx", async () => {
    const fake = fakeFetch(raw("", 500, "Internal Server Error"));
    const { sleep, sleeps } = recorder();

    const result = await decodeVin(VIN, { fetchImpl: fake.impl, sleep });

    expect(fake.calls).toHaveLength(3);
    expect(sleeps).toEqual([2000, 6000]);
    expect(result.status).toBe("pending");
    expect(result.lastError).toBe("HTTP 500 Internal Server Error");
  });

  it("does not retry a 4xx", async () => {
    const fake = fakeFetch(raw("", 404, "Not Found"));
    const { sleep, sleeps } = recorder();

    const result = await decodeVin(VIN, { fetchImpl: fake.impl, sleep });

    expect(fake.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(result.status).toBe("pending");
    expect(result.lastError).toBe("HTTP 404 Not Found");
  });

  it("aborts a hung request at the timeout and retries it", async () => {
    const fake = fakeFetch(hangs());
    const { sleep, sleeps } = recorder();

    const result = await decodeVin(VIN, { fetchImpl: fake.impl, sleep, timeoutMs: 5 });

    expect(fake.calls).toHaveLength(3);
    expect(sleeps).toEqual([2000, 6000]);
    expect(result.status).toBe("pending");
    expect(result.lastError).toBe("Timed out after 5 ms");
  });

  it("stops as soon as an attempt succeeds", async () => {
    const fake = fakeFetch(throws("Failed to fetch"), json(envelope([OK_RESULT])));
    const { sleep, sleeps } = recorder();

    const result = await decodeVin(VIN, { fetchImpl: fake.impl, sleep });

    expect(fake.calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
    expect(result.status).toBe("ok");
    expect(result.lastError).toBeNull();
  });
});
