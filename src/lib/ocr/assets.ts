/**
 * The engine's four files, fetched once and kept in Cache Storage.
 *
 * They are deliberately not in the precache manifest. S5 addendum §3: both Vite configs
 * glob every `.js`, `.css`, `.html`, `.svg`, `.png` and `.woff2` in the build, and the
 * core is a base64-embedded `.wasm.js` that *ends in `.js` and matches*. `globIgnores`
 * keeps `ocr/` out of it (see `vite.config.ts` for what happens when it does not), and
 * this module is what puts the engine on the device instead: on first use, as a download
 * the user is shown, rather than 4.5 MB every install pays for whether or not anyone ever
 * reads a sticker.
 *
 * Every asset is checked against `assets.generated.ts` before it is stored and before it
 * is used. A 3.9 MB transfer on a dropping connection truncates, and a truncated entry in
 * Cache Storage is wrong for as long as the cache lives; a model that still carries a
 * dictionary is wrong in the direction N2 exists to prevent (§3).
 *
 * Not pure: it fetches and it writes to Cache Storage. Both arrive through `OcrAssetDeps`.
 */
import { OCR_ASSET_LIST, OCR_ASSETS, OCR_TOTAL_BYTES, type OcrAssetSpec } from "./assets.generated";
import { OCR_ASSET_DIR, OCR_CACHE_NAME } from "./constants";
import { dictionaryComponents } from "./traineddata";
import { OcrError, type OcrProgress } from "./types";

/** The subset of `Cache` this module uses, so a test can be a `Map` and not a browser. */
export interface OcrCacheLike {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
  delete(url: string): Promise<boolean>;
}

export interface OcrAssetDeps {
  fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  openCache: (name: string) => Promise<OcrCacheLike>;
  /** Lower-case hex SHA-256. */
  digest: (bytes: Uint8Array) => Promise<string>;
}

export interface EnsureOcrAssetsOptions {
  signal?: AbortSignal;
  onProgress?: (progress: OcrProgress) => void;
}

/** Where one asset lives, absolute, under whatever base this build was made for. */
export function ocrAssetUrl(baseUrl: string, file: string): string {
  return new URL(`${OCR_ASSET_DIR}${file}`, baseUrl).href;
}

/** The default digest. `crypto.subtle` is present wherever a service worker is. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copied rather than passed through: a `Uint8Array` may be backed by a
  // `SharedArrayBuffer`, which `BufferSource` does not admit, and this build has no
  // shared memory anywhere in it by design (§4).
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function abortIfAsked(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new OcrError("aborted");
}

/**
 * Reads a response body, reporting bytes as they land when the platform streams.
 *
 * `Content-Length` is not trusted for anything but the progress denominator — the size
 * that decides whether the transfer completed is the one in the manifest.
 */
async function readBody(response: Response, onChunk: (bytes: number) => void): Promise<Uint8Array> {
  const body = response.body;
  if (body === null || body === undefined) {
    const whole = new Uint8Array(await response.arrayBuffer());
    onChunk(whole.length);
    return whole;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    chunks.push(value);
    total += value.length;
    onChunk(value.length);
  }
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

async function verify(spec: OcrAssetSpec, bytes: Uint8Array, deps: OcrAssetDeps): Promise<void> {
  if (bytes.length !== spec.bytes) {
    throw new OcrError(
      "corrupt_asset",
      `${spec.file}: expected ${spec.bytes} bytes, got ${bytes.length}`,
    );
  }
  const actual = await deps.digest(bytes);
  if (actual !== spec.sha256) {
    throw new OcrError("corrupt_asset", `${spec.file}: digest ${actual}`);
  }
}

/**
 * A stored asset carries the length it was stored with, so a cache hit can be checked
 * without pulling 3.9 MB back through `crypto.subtle` on every run.
 */
const LENGTH_HEADER = "content-length";

async function fetchAndStore(
  cache: OcrCacheLike,
  url: string,
  spec: OcrAssetSpec,
  deps: OcrAssetDeps,
  options: EnsureOcrAssetsOptions,
  report: (bytes: number) => void,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await deps.fetch(url, { signal: options.signal });
  } catch (error) {
    abortIfAsked(options.signal);
    throw new OcrError("download_failed", `${spec.file}: ${String(error)}`);
  }
  if (!response.ok) {
    throw new OcrError("download_failed", `${spec.file}: HTTP ${response.status}`);
  }
  const bytes = await readBody(response, report);
  abortIfAsked(options.signal);
  await verify(spec, bytes, deps);
  // Only bytes that passed are ever stored, so a cache hit is never a truncated transfer.
  await cache.put(
    url,
    new Response(bytes as unknown as BodyInit, {
      headers: { [LENGTH_HEADER]: String(bytes.length) },
    }),
  );
  return bytes;
}

/**
 * Makes sure all four assets are in the cache, and returns the model's bytes.
 *
 * The model comes back because the caller hands it to tesseract.js directly rather than
 * letting tesseract.js fetch it: that is what makes `langPath` unreachable in practice as
 * well as overridden, and it is where the dictionary check below gets its bytes.
 */
export async function ensureOcrAssets(
  baseUrl: string,
  deps: OcrAssetDeps,
  options: EnsureOcrAssetsOptions = {},
): Promise<Uint8Array> {
  abortIfAsked(options.signal);
  const cache = await deps.openCache(OCR_CACHE_NAME);
  let loadedBytes = 0;
  let model: Uint8Array | null = null;

  for (const spec of OCR_ASSET_LIST) {
    abortIfAsked(options.signal);
    const url = ocrAssetUrl(baseUrl, spec.file);
    const wanted = spec === OCR_ASSETS.model;
    const report = (bytes: number): void => {
      loadedBytes += bytes;
      options.onProgress?.({ file: spec.file, loadedBytes, totalBytes: OCR_TOTAL_BYTES });
    };

    const hit = await cache.match(url);
    const storedLength = hit === undefined ? null : Number(hit.headers.get(LENGTH_HEADER));
    if (hit !== undefined && storedLength === spec.bytes) {
      if (wanted) {
        model = new Uint8Array(await hit.arrayBuffer());
        await verify(spec, model, deps);
      }
      report(spec.bytes);
      continue;
    }
    // A hit that does not match the manifest is a stale or truncated entry: drop it and
    // fetch, rather than serving it and letting the engine fail somewhere further away.
    if (hit !== undefined) await cache.delete(url);
    const bytes = await fetchAndStore(cache, url, spec, deps, options, report);
    if (wanted) model = bytes;
  }

  if (model === null) throw new OcrError("corrupt_asset", "the model is not in the asset list");
  // §3, N2: the second of two locks. The build strips the dictionary and the runtime
  // refuses a model that has one, because a dictionary bends `WA8555` toward a word.
  const dictionaries = dictionaryComponents(model);
  if (dictionaries.length > 0) {
    throw new OcrError("dictionary_present", `model carries components ${dictionaries.join(", ")}`);
  }
  options.onProgress?.({ file: null, loadedBytes, totalBytes: OCR_TOTAL_BYTES });
  return model;
}

/**
 * The real thing: this origin's `fetch`, this origin's Cache Storage, `crypto.subtle`.
 *
 * Every one of them is a global rather than an argument, which is exactly why they are
 * gathered into one function instead of being reached for inside the module.
 */
export function browserOcrAssetDeps(): OcrAssetDeps {
  return {
    fetch: (url, init) => fetch(url, init),
    openCache: (name) => caches.open(name),
    digest: sha256Hex,
  };
}
