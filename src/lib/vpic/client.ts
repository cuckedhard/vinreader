/**
 * §4.7 vPIC client. One request per VIN ever — the cache is permanent and only the
 * sheet's "Refresh details" button re-fetches — so this file spends its budget on
 * getting a single call right: a hard timeout, a bounded retry ladder, and a result
 * that always resolves so the decode queue can never wedge.
 *
 * Not pure: it performs network I/O. Everything non-deterministic (fetch, sleep,
 * timeout) arrives through `VpicDeps`.
 */
import type { VpicDeps, VpicResult } from "./types";

/** §4.7. The VIN and `?format=json` are appended to this base. */
export const VPIC_ENDPOINT = "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues";

export const VPIC_TIMEOUT_MS = 10000;

/** §4.7: wait 2 s before the second attempt, 6 s before the third. */
export const VPIC_BACKOFF_MS: readonly number[] = [2000, 6000];

/** §4.7 allows three attempts total: the first, plus one per backoff step. */
const MAX_ATTEMPTS = VPIC_BACKOFF_MS.length + 1;

/** What one attempt produced: a finished result, or a failure and whether it is worth repeating. */
interface AttemptOutcome {
  result: VpicResult | null;
  lastError: string | null;
  retryable: boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function buildUrl(vin: string): string {
  return `${VPIC_ENDPOINT}/${encodeURIComponent(vin)}?format=json`;
}

/**
 * §4.7 status rules. `ErrorCode === "0"` is "ok" and anything else is "partial", but a
 * result carrying neither Make nor Model is an off-highway PIN and becomes "unsupported"
 * whatever the ErrorCode says. §4.7 states both rules without ordering them; the
 * off-highway rule is the more specific one, so it is applied last and wins.
 */
function toResult(raw: Record<string, unknown>): VpicResult {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    // §4.7: every field is a string, and an empty one means unknown. N2 forbids
    // rendering unknowns as facts, so they never reach the record.
    if (typeof value === "string" && value !== "") fields[key] = value;
  }

  const errorText = fields.ErrorText ?? null;
  let status: VpicResult["status"] = fields.ErrorCode === "0" ? "ok" : "partial";
  if (!fields.Make && !fields.Model) status = "unsupported";

  return { status, fields, errorText, lastError: null };
}

async function attemptOnce(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<AttemptOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, { signal: controller.signal });
  } catch (error) {
    // A network throw or our own timeout firing: both are worth another attempt (§4.7).
    const timedOut = controller.signal.aborted;
    return {
      result: null,
      lastError: timedOut
        ? `Timed out after ${timeoutMs} ms`
        : `Network error: ${messageOf(error)}`,
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // §4.7 retries 5xx only. A 4xx will not become a different answer on the third try.
    const detail = response.statusText
      ? `${response.status} ${response.statusText}`
      : `${response.status}`;
    return { result: null, lastError: `HTTP ${detail}`, retryable: response.status >= 500 };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { result: null, lastError: `Malformed response: ${messageOf(error)}`, retryable: false };
  }

  const results: unknown = isRecord(body) ? body.Results : undefined;
  if (!Array.isArray(results) || results.length === 0 || !isRecord(results[0])) {
    return { result: null, lastError: "Malformed response: no Results[0]", retryable: false };
  }

  return { result: toResult(results[0]), lastError: null, retryable: false };
}

/**
 * Decode one VIN against vPIC. Never throws: a transport, HTTP or parse failure comes
 * back as `status: "pending"` with `lastError` set, which §5.4 leaves retryable.
 */
export async function decodeVin(vin: string, deps: VpicDeps = {}): Promise<VpicResult> {
  // Bound to globalThis so an unbound `fetch` cannot fail with an illegal invocation.
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const sleep = deps.sleep ?? defaultSleep;
  const timeoutMs = deps.timeoutMs ?? VPIC_TIMEOUT_MS;
  const url = buildUrl(vin);

  let lastError = "No attempt was made";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(VPIC_BACKOFF_MS[attempt - 1]);

    const outcome = await attemptOnce(url, fetchImpl, timeoutMs);
    if (outcome.result) return outcome.result;

    lastError = outcome.lastError ?? "Unknown error";
    if (!outcome.retryable) break;
  }

  return { status: "pending", fields: {}, errorText: null, lastError };
}
