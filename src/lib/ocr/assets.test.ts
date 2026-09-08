/**
 * The lazy download, and every way it is allowed to fail.
 *
 * The engine is not precached (S5 addendum §3), so this is the only path by which it ever
 * reaches a phone. Two properties carry the slice: what is stored is what was shipped —
 * a 3.9 MB transfer over a dropping connection truncates, and Cache Storage keeps a
 * truncated entry until something deletes it — and the model that is handed to tesseract
 * carries no dictionary, because a dictionary bends `WA8555` toward a word and nothing
 * downstream of a paint code can contradict a wrong one (N2).
 *
 * The bytes here are the real committed assets, so the digests are the real digests.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  browserOcrAssetDeps,
  ensureOcrAssets,
  ocrAssetUrl,
  sha256Hex,
  type OcrAssetDeps,
  type OcrCacheLike,
} from "./assets";
import { OCR_ASSETS, OCR_ASSET_LIST, OCR_TOTAL_BYTES } from "./assets.generated";
import {
  OCR_CACHE_NAME,
  OCR_MODEL_CONTENT_TYPE,
  OCR_SCRIPT_CONTENT_TYPE,
  ocrContentType,
} from "./constants";
import { TESSDATA } from "./traineddata";
import { OcrError, type OcrProgress } from "./types";

const DIR = fileURLToPath(new URL("../../../public/ocr/", import.meta.url));
const BASE = "https://vinrelay.example/app/";

const REAL: Record<string, Uint8Array<ArrayBuffer>> = Object.fromEntries(
  OCR_ASSET_LIST.map((spec) => [spec.file, Uint8Array.from(readFileSync(`${DIR}${spec.file}`))]),
);

/**
 * Cache Storage, as far as this module is concerned — and headers included.
 *
 * It keeps `content-type` as well as `content-length` because the real one does, and
 * because the type is what the service worker hands the browser's own script loads. A
 * fake that dropped it could not tell a stored entry the engine can run from one it
 * cannot, which is exactly the gap the deployed build fell through.
 *
 * `new Response(bytes, ...)` sets no `content-type` of its own, so an entry stored without
 * the header reads back as `null` here the same way it does in a browser.
 */
class FakeCache implements OcrCacheLike {
  readonly entries = new Map<
    string,
    { bytes: Uint8Array<ArrayBuffer>; length: string | null; type: string | null }
  >();
  readonly deleted: string[] = [];

  async match(url: string): Promise<Response | undefined> {
    const entry = this.entries.get(url);
    if (entry === undefined) return undefined;
    const headers: Record<string, string> = {};
    if (entry.length !== null) headers["content-length"] = entry.length;
    if (entry.type !== null) headers["content-type"] = entry.type;
    return new Response(entry.bytes, { headers });
  }

  async put(url: string, response: Response): Promise<void> {
    this.entries.set(url, {
      bytes: new Uint8Array(await response.arrayBuffer()) as Uint8Array<ArrayBuffer>,
      length: response.headers.get("content-length"),
      type: response.headers.get("content-type"),
    });
  }

  async delete(url: string): Promise<boolean> {
    this.deleted.push(url);
    return this.entries.delete(url);
  }
}

interface Harness {
  deps: OcrAssetDeps;
  cache: FakeCache;
  fetched: string[];
  openedNames: string[];
  serve: (file: string, bytes: Uint8Array<ArrayBuffer> | null, status?: number) => void;
}

function harness(): Harness {
  const cache = new FakeCache();
  const fetched: string[] = [];
  const openedNames: string[] = [];
  const overrides = new Map<string, { bytes: Uint8Array<ArrayBuffer> | null; status: number }>();

  return {
    cache,
    fetched,
    openedNames,
    serve(file, bytes, status = 200) {
      overrides.set(file, { bytes, status });
    },
    deps: {
      fetch: async (url) => {
        fetched.push(url);
        const file = url.slice(url.lastIndexOf("/") + 1);
        const override = overrides.get(file);
        if (override !== undefined) {
          if (override.status !== 200) return new Response("no", { status: override.status });
          if (override.bytes === null) throw new TypeError("network down");
          return new Response(override.bytes);
        }
        return new Response(REAL[file]);
      },
      openCache: async (name) => {
        openedNames.push(name);
        return cache;
      },
      digest: sha256Hex,
    },
  };
}

describe("ocrAssetUrl", () => {
  it("hangs the assets off the base this build was made for", () => {
    expect(ocrAssetUrl(BASE, "eng.traineddata")).toBe(
      "https://vinrelay.example/app/ocr/eng.traineddata",
    );
  });
});

describe("ensureOcrAssets", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("fetches all four into the cache the service worker reads, and returns the model", async () => {
    const model = await ensureOcrAssets(BASE, h.deps);

    expect(h.openedNames).toEqual([OCR_CACHE_NAME]);
    expect(h.fetched).toEqual(OCR_ASSET_LIST.map((spec) => ocrAssetUrl(BASE, spec.file)));
    expect([...h.cache.entries.keys()]).toEqual(h.fetched);
    expect(model.length).toBe(OCR_ASSETS.model.bytes);
    expect(await sha256Hex(model)).toBe(OCR_ASSETS.model.sha256);
  });

  it("reports progress that adds up to what the four cost", async () => {
    const seen: OcrProgress[] = [];
    await ensureOcrAssets(BASE, h.deps, { onProgress: (p) => seen.push(p) });

    expect(seen[0].totalBytes).toBe(OCR_TOTAL_BYTES);
    expect(seen.every((p) => p.loadedBytes <= p.totalBytes)).toBe(true);
    const last = seen[seen.length - 1];
    expect(last).toEqual({ file: null, loadedBytes: OCR_TOTAL_BYTES, totalBytes: OCR_TOTAL_BYTES });
  });

  it("reports the 3.9 MB core as it arrives, not once it has arrived", async () => {
    // A phone on a slow connection spends most of the wait here, and a bar that only
    // moves four times is a spinner with extra steps.
    const bytes = REAL[OCR_ASSETS.core.file];
    const chunkSize = Math.ceil(bytes.length / 8);
    const chunked: OcrAssetDeps = {
      ...h.deps,
      fetch: async (url) => {
        if (!url.endsWith(OCR_ASSETS.core.file)) return h.deps.fetch(url);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let at = 0; at < bytes.length; at += chunkSize) {
                controller.enqueue(bytes.subarray(at, at + chunkSize));
              }
              controller.close();
            },
          }),
        );
      },
    };

    const seen: OcrProgress[] = [];
    await ensureOcrAssets(BASE, chunked, { onProgress: (p) => seen.push(p) });
    const core = seen.filter((p) => p.file === OCR_ASSETS.core.file);
    expect(core.length).toBe(8);
    const loaded = core.map((p) => p.loadedBytes);
    expect(loaded).toEqual([...loaded].sort((a, b) => a - b));
    expect(loaded[0]).toBeLessThan(loaded[loaded.length - 1]);
  });

  it("touches the network not at all on a warm cache", async () => {
    await ensureOcrAssets(BASE, h.deps);
    const warm = harness();
    warm.cache.entries.clear();
    for (const [url, entry] of h.cache.entries) warm.cache.entries.set(url, entry);

    const model = await ensureOcrAssets(BASE, warm.deps);
    expect(warm.fetched).toEqual([]);
    expect(model.length).toBe(OCR_ASSETS.model.bytes);
  });

  it("drops a cached entry whose stored length is not the shipped one, and fetches again", async () => {
    await ensureOcrAssets(BASE, h.deps);
    const url = ocrAssetUrl(BASE, OCR_ASSETS.core.file);
    // What a truncated 3.9 MB transfer leaves behind, if one were ever stored.
    h.cache.entries.set(url, {
      bytes: Uint8Array.from(REAL[OCR_ASSETS.core.file].subarray(0, 100)),
      length: "100",
      type: ocrContentType(OCR_ASSETS.core.file),
    });
    h.fetched.length = 0;

    await ensureOcrAssets(BASE, h.deps);
    expect(h.cache.deleted).toEqual([url]);
    expect(h.fetched).toEqual([url]);
    expect(h.cache.entries.get(url)!.bytes.length).toBe(OCR_ASSETS.core.bytes);
  });

  it("refetches an entry stored without a length rather than trusting it", async () => {
    const url = ocrAssetUrl(BASE, OCR_ASSETS.runtime.file);
    h.cache.entries.set(url, {
      bytes: REAL[OCR_ASSETS.runtime.file],
      length: null,
      type: ocrContentType(OCR_ASSETS.runtime.file),
    });
    await ensureOcrAssets(BASE, h.deps);
    expect(h.fetched).toContain(url);
  });

  /**
   * The bug that shipped: OCR could not start at all on the deployed build.
   *
   * These entries are not private to this module. The service worker's `OCR_ASSET_ROUTE`
   * serves them cache-first to *the browser's own* script loads — the dynamic `import()`
   * of the runtime, and the `importScripts` the tesseract worker does for the core — and
   * neither of those goes through any `fetch` this repo controls, so there is no later
   * place to put the type back. `new Response(bytes)` sets none, and Chromium will not
   * execute a script whose response has no JavaScript MIME type.
   *
   * Measured against `docs/` under `/vinreader/` with the worker active: without this the
   * capture screen shows "The reader stopped." every time; with the same bytes typed, it
   * reads the label.
   */
  it("stores each asset with the type the service worker will serve it under", async () => {
    await ensureOcrAssets(BASE, h.deps);

    for (const spec of OCR_ASSET_LIST) {
      const entry = h.cache.entries.get(ocrAssetUrl(BASE, spec.file))!;
      expect(entry.type, spec.file).toBe(ocrContentType(spec.file));
    }
    // Named, not merely self-consistent: the three scripts are script — the core included,
    // because it is emscripten's base64-embedded `.wasm.js` and not `application/wasm` —
    // and the model is data.
    expect(h.cache.entries.get(ocrAssetUrl(BASE, OCR_ASSETS.runtime.file))!.type).toBe(
      OCR_SCRIPT_CONTENT_TYPE,
    );
    expect(h.cache.entries.get(ocrAssetUrl(BASE, OCR_ASSETS.worker.file))!.type).toBe(
      OCR_SCRIPT_CONTENT_TYPE,
    );
    expect(h.cache.entries.get(ocrAssetUrl(BASE, OCR_ASSETS.core.file))!.type).toBe(
      OCR_SCRIPT_CONTENT_TYPE,
    );
    expect(h.cache.entries.get(ocrAssetUrl(BASE, OCR_ASSETS.model.file))!.type).toBe(
      OCR_MODEL_CONTENT_TYPE,
    );
  });

  it("drops an entry stored without a type rather than serving one no browser will run", async () => {
    // What every install that ever tapped "Read the code" on the broken build is carrying:
    // the right bytes, the right length, and no `content-type`. Length alone said the hit
    // was good, so it would have been served — and refused — for the life of the install.
    const url = ocrAssetUrl(BASE, OCR_ASSETS.core.file);
    h.cache.entries.set(url, {
      bytes: REAL[OCR_ASSETS.core.file],
      length: String(OCR_ASSETS.core.bytes),
      type: null,
    });

    await ensureOcrAssets(BASE, h.deps);

    expect(h.cache.deleted).toContain(url);
    expect(h.fetched).toContain(url);
    expect(h.cache.entries.get(url)!.type).toBe(OCR_SCRIPT_CONTENT_TYPE);
  });

  it("drops an entry typed as something else, which is a different asset's bytes", async () => {
    const url = ocrAssetUrl(BASE, OCR_ASSETS.worker.file);
    h.cache.entries.set(url, {
      bytes: REAL[OCR_ASSETS.worker.file],
      length: String(OCR_ASSETS.worker.bytes),
      type: OCR_MODEL_CONTENT_TYPE,
    });

    await ensureOcrAssets(BASE, h.deps);

    expect(h.cache.deleted).toContain(url);
    expect(h.cache.entries.get(url)!.type).toBe(OCR_SCRIPT_CONTENT_TYPE);
  });

  it("refuses bytes that are not the bytes this build shipped, and stores nothing", async () => {
    const short = Uint8Array.from(REAL[OCR_ASSETS.worker.file].subarray(0, 1000));
    h.serve(OCR_ASSETS.worker.file, short);
    await expect(ensureOcrAssets(BASE, h.deps)).rejects.toMatchObject({
      reason: "corrupt_asset",
    });
    expect([...h.cache.entries.keys()]).not.toContain(ocrAssetUrl(BASE, OCR_ASSETS.worker.file));
  });

  it("refuses bytes of the right length whose digest is wrong", async () => {
    const tampered = Uint8Array.from(REAL[OCR_ASSETS.model.file]);
    tampered[tampered.length - 1] ^= 0xff;
    h.serve(OCR_ASSETS.model.file, tampered);
    await expect(ensureOcrAssets(BASE, h.deps)).rejects.toMatchObject({ reason: "corrupt_asset" });
  });

  it("says the download failed on an HTTP error and on a dead connection", async () => {
    h.serve(OCR_ASSETS.core.file, null, 404);
    await expect(ensureOcrAssets(BASE, h.deps)).rejects.toMatchObject({
      reason: "download_failed",
    });

    const dead = harness();
    dead.serve(OCR_ASSETS.runtime.file, null);
    await expect(ensureOcrAssets(BASE, dead.deps)).rejects.toMatchObject({
      reason: "download_failed",
    });
  });

  it("refuses a model that carries a dictionary, however well it downloaded", async () => {
    // The shipped model with an LSTM word dictionary spliced back into its table of
    // contents — the same length, so it takes a stubbed digest to get this far. That is
    // the point: the dictionary check is the second lock on the same door, and the only
    // way to reach it is to defeat the first. §3's 89.8%, and the reason `WA8555` would
    // come back as a word.
    const model = Uint8Array.from(REAL[OCR_ASSETS.model.file]);
    new DataView(model.buffer).setBigInt64(4 + 8 * TESSDATA.LSTM_WORD_DAWG, BigInt(200_000), true);
    expect(model.length).toBe(OCR_ASSETS.model.bytes);

    const h2 = harness();
    h2.serve(OCR_ASSETS.model.file, model);
    await expect(
      ensureOcrAssets(BASE, {
        ...h2.deps,
        digest: async (bytes) =>
          bytes.length === model.length ? OCR_ASSETS.model.sha256 : sha256Hex(bytes),
      }),
    ).rejects.toMatchObject({ reason: "dictionary_present" });
  });

  it("stops when the screen goes away, before it starts and part way through", async () => {
    const already = new AbortController();
    already.abort();
    await expect(ensureOcrAssets(BASE, h.deps, { signal: already.signal })).rejects.toMatchObject({
      reason: "aborted",
    });
    expect(h.fetched).toEqual([]);

    const mid = new AbortController();
    const h2 = harness();
    await expect(
      ensureOcrAssets(BASE, h2.deps, {
        signal: mid.signal,
        onProgress: (p) => {
          if (p.file === OCR_ASSETS.worker.file) mid.abort();
        },
      }),
    ).rejects.toMatchObject({ reason: "aborted" });
    expect(h2.fetched.length).toBeLessThan(OCR_ASSET_LIST.length);
  });

  it("reads a body that does not stream, which is what a cache-served response can be", async () => {
    const bytes = REAL[OCR_ASSETS.runtime.file];
    const noStream = {
      ok: true,
      status: 200,
      body: null,
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    } as unknown as Response;
    const deps: OcrAssetDeps = {
      ...h.deps,
      fetch: async (url) => (url.endsWith(OCR_ASSETS.runtime.file) ? noStream : h.deps.fetch(url)),
    };
    await expect(ensureOcrAssets(BASE, deps)).resolves.toBeInstanceOf(Uint8Array);
  });

  it("throws an OcrError and not a bare Error, so a caller can branch on the reason", async () => {
    h.serve(OCR_ASSETS.core.file, null, 500);
    await expect(ensureOcrAssets(BASE, h.deps)).rejects.toBeInstanceOf(OcrError);
  });
});

describe("browserOcrAssetDeps", () => {
  it("reaches for this origin's fetch, this origin's Cache Storage and crypto.subtle", async () => {
    const calls: string[] = [];
    const globals = globalThis as unknown as {
      fetch: unknown;
      caches: unknown;
    };
    const realFetch = globals.fetch;
    const realCaches = globals.caches;
    globals.fetch = (url: string) => {
      calls.push(`fetch ${url}`);
      return Promise.resolve(new Response("x"));
    };
    globals.caches = {
      open: (name: string) => {
        calls.push(`open ${name}`);
        return Promise.resolve({} as OcrCacheLike);
      },
    };
    try {
      const deps = browserOcrAssetDeps();
      await deps.fetch("https://example.test/ocr/x");
      await deps.openCache(OCR_CACHE_NAME);
      expect(await deps.digest(new Uint8Array([1, 2, 3]))).toBe(
        await sha256Hex(new Uint8Array([1, 2, 3])),
      );
    } finally {
      globals.fetch = realFetch;
      globals.caches = realCaches;
    }
    expect(calls).toEqual([`fetch https://example.test/ocr/x`, `open ${OCR_CACHE_NAME}`]);
  });
});
