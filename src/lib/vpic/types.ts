/**
 * §4.7 NHTSA vPIC contract. These types describe the wire shape and the single
 * value the client hands back; `client.ts` is the only file in this folder that
 * performs I/O, and it takes its fetch, its sleep and its timeout by injection.
 */

/** The envelope returned by `DecodeVinValues`. Every field inside `Results[0]` is a string. */
export interface VpicRawResponse {
  Count: number;
  Message: string;
  SearchCriteria: string | null;
  Results: Array<Record<string, string>>;
}

export interface VpicResult {
  status: "ok" | "partial" | "unsupported" | "pending";
  /** `Results[0]` with empty values removed — §4.7: an empty string means unknown (N2). */
  fields: Record<string, string>;
  /** `ErrorText` when present, for the sheet's notice area. */
  errorText: string | null;
  /** Transport or parse failure detail; set only when `status` is `"pending"`. */
  lastError: string | null;
}

export interface VpicDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}
