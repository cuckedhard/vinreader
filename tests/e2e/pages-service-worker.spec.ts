import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { OCR_ASSET_LIST } from "../../src/lib/ocr/assets.generated";
import {
  OCR_ASSET_ROUTE,
  OCR_CACHE_NAME,
  OCR_MODEL_CONTENT_TYPE,
  OCR_SCRIPT_CONTENT_TYPE,
  ocrContentType,
} from "../../src/lib/ocr/constants";
import { encodePayload } from "../../src/lib/payload/codec";

/**
 * OCR against the artifact GitHub Pages actually serves: the `vite.pages.config.ts` build,
 * under the `/vinreader/` sub-path, with the service worker registered and controlling the
 * page.
 *
 * **This is the configuration a shipped feature could not start in.** Every other OCR test
 * in this repo either stubs the worker, or runs against the root build over the dev
 * certificate — and Chromium refuses to register a service worker fetched over a
 * self-signed one, which is why `constants.test.ts` says the worker "cannot be exercised in
 * this repo's e2e run". So it never was, and the engine died on the deployed build for the
 * one reason no test could see: `assets.ts` wrote its verified bytes into the same Cache
 * Storage bucket the worker's `OCR_ASSET_ROUTE` serves from, as a `Response` built from a
 * `Uint8Array` — which carries no `Content-Type`. The worker then handed that back to the
 * browser's own script loads, and Chromium refuses a JavaScript load with no JavaScript
 * MIME type: `import()` of the runtime fails the module MIME check on a controlled page,
 * and `importScripts` of the core throws `NetworkError` inside the tesseract worker on a
 * page that is not yet controlled. Both end at §6.4's "The reader stopped."
 *
 * `http://localhost` is what makes the worker reachable at all — it is a secure context
 * without a certificate, so the worker registers where the HTTPS preview server's
 * self-signed certificate stopped it.
 *
 * The server is a fresh Pages build (`playwright.config.ts`), not the committed `docs/`.
 * Same config, same `base`, same output — but `docs/` is a deployment artifact somebody
 * else refreshes, so a guard reading it would certify the last deploy rather than the tree
 * it is running in, and would be red for every commit between a fix and its deployment.
 *
 * Synthetic, and it stays synthetic (§13.7): this says the engine starts and reads a
 * rendered label, never that a scuffed sticker in a snowy door jamb does.
 */

const PAGES_DIR = resolve(import.meta.dirname, "../../dist-pages");
const VIN = "1HGCM82633A004352";
/** A GM paint code, and the token §5's crop box catches beside it on the same label line. */
const CODE = "WA8555";
const NEIGHBOUR = "PNT";
const PAYLOAD = encodePayload({ v: 1, vin: VIN, y: "2003", mk: "HONDA", md: "Accord" });
const Y4M = resolve(process.cwd(), "bench/fake-paint.y4m");
/** §6.4's `engine_failed` line — the sentence a real user got instead of a reader. */
const STOPPED = "The reader stopped. Try again, or type the code.";

test.use({
  launchOptions: {
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${Y4M}`,
    ],
  },
});

/**
 * Loads the app and waits for the service worker to be *active*, without reloading.
 *
 * `registerType: "prompt"` sets no `clientsClaim`, so a first visit registers the worker
 * and is not controlled by it — and that is a real user's first read, not an edge case.
 * The page's own fetches go straight to the network, but the tesseract worker it spawns is
 * a new client and Chromium routes *its* script loads through the worker anyway. That
 * asymmetry is what the reported failure was made of.
 */
async function withServiceWorkerActive(page: Page): Promise<void> {
  await page.goto("#/scan");
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
}

/**
 * The same, plus the reload that puts the page itself under the worker.
 *
 * Returns the controlling worker's URL, or `null` if it never took over — returned rather
 * than asserted here so a failure lands on the assertion that names the condition instead
 * of on a helper.
 */
async function underServiceWorker(page: Page): Promise<string | null> {
  await withServiceWorkerActive(page);
  await page.reload();
  await page
    .waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 30_000 })
    .catch(() => undefined);
  return page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null);
}

/** The vPIC answer this record already carries. Nothing here is a decode test. */
async function stubVpic(page: Page): Promise<void> {
  await page.route("**/api/vehicles/DecodeVinValues/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        Count: 1,
        Results: [{ ErrorCode: "0", Make: "HONDA", Model: "Accord", ModelYear: "2003" }],
      }),
    }),
  );
}

/** Taps "Read the code" and waits for whichever of the two outcomes arrives first. */
async function readTheCode(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Read the code" }).click();
  // Waiting only for the candidates would spend the whole timeout staring at an error that
  // was already on screen.
  await expect(page.getByTestId("paint-candidate").first().or(page.getByText(STOPPED))).toBeVisible(
    { timeout: 180_000 },
  );
}

/** A stored record to hang a paint code on, and the capture screen open over it. */
async function openCapture(page: Page): Promise<void> {
  await page.goto(`#/i?d=${PAYLOAD}`);
  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));
  await page.getByRole("button", { name: "Read the code with the camera" }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}/paint`));
}

/** Every entry in the engine's bucket, with the type it would be served under. */
async function cachedTypes(page: Page): Promise<Record<string, string | null>> {
  return page.evaluate(async (name) => {
    const cache = await caches.open(name);
    const out: Record<string, string | null> = {};
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      out[request.url.slice(request.url.lastIndexOf("/") + 1)] =
        response?.headers.get("content-type") ?? null;
    }
    return out;
  }, OCR_CACHE_NAME);
}

test("[S5 §3] the first read on the Pages sub-path starts the engine, worker registered", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 390, height: 844 }); // §6.1: one hand, a phone.
  await stubVpic(page);

  // The reported failure was a `pageerror` before it was a sentence on screen, and the
  // sentence is the same one a dead camera produces. Collecting them says which.
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await withServiceWorkerActive(page);
  await openCapture(page);
  await readTheCode(page);

  // Verbatim, because this is the string a real user's browser produced:
  // `NetworkError: Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at
  // '…/vinreader/ocr/tesseract-core-simd-lstm.wasm.js' failed to load.` Thrown inside the
  // tesseract worker, which the service worker serves even though the page that spawned it
  // is not yet controlled.
  expect(pageErrors, "the tesseract worker could not load its own core").toEqual([]);
  await expect(page.getByText(STOPPED), "§6.4's engine_failed line").toHaveCount(0);
  await expect(page.getByRole("button", { name: `Save ${CODE}` })).toBeVisible();
  await expect(page.getByRole("button", { name: `Save ${NEIGHBOUR}` })).toBeVisible();
});

test("[S5 §3] and it starts again once the worker is controlling the page", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await stubVpic(page);

  const controller = await underServiceWorker(page);
  expect(controller, "the service worker never took over, so this proves nothing").toBe(
    new URL("sw.js", baseURL!).href,
  );

  await openCapture(page);
  await readTheCode(page);
  await expect(page.getByText(STOPPED), "§6.4's engine_failed line").toHaveCount(0);
  await expect(page.getByRole("button", { name: `Save ${CODE}` })).toBeVisible();
  await expect(page.getByRole("button", { name: `Save ${NEIGHBOUR}` })).toBeVisible();

  // And the mechanism, named rather than inferred from the screen: what the worker has to
  // hand back is executable. No unit test can make this one — it takes a real `Cache` and
  // a real service worker in front of it.
  const types = await cachedTypes(page);
  for (const spec of OCR_ASSET_LIST) {
    expect(types[spec.file], `${spec.file} is cached with a type no browser will run`).toBe(
      ocrContentType(spec.file),
    );
  }
  // Named, not merely self-consistent: the core included, because it is emscripten's
  // base64-embedded `.wasm.js` and is script rather than `application/wasm`.
  expect(types["tesseract-core-simd-lstm.wasm.js"]).toBe(OCR_SCRIPT_CONTENT_TYPE);
  expect(types["eng.traineddata"]).toBe(OCR_MODEL_CONTENT_TYPE);
});

test("[S5 §3] the Pages build ships the engine, precaches none of it, and routes it", () => {
  // The same three properties `ocr-engine.spec.ts` pins on the root build, on the build
  // that is actually deployed. `vite.config.ts` and `vite.pages.config.ts` are separate
  // files that have to agree, and only this one is served from a sub-path.
  for (const spec of OCR_ASSET_LIST) {
    expect(statSync(join(PAGES_DIR, "ocr", spec.file)).size, spec.file).toBe(spec.bytes);
  }

  const sw = readFileSync(join(PAGES_DIR, "sw.js"), "utf8");
  const precached = [...sw.matchAll(/\{url:"([^"]+)",revision:/g)].map((match) => match[1]);
  expect(precached.length, "no precache entry was found in sw.js").toBeGreaterThan(0);
  expect(precached.filter((url) => url.includes("ocr/"))).toEqual([]);

  // One route, whole — the pattern, the handler and the bucket the warm-up writes into.
  expect(sw).toContain(
    `registerRoute(${String(OCR_ASSET_ROUTE)},` +
      `new e.CacheFirst({cacheName:${JSON.stringify(OCR_CACHE_NAME)},`,
  );
  // And the sub-path is in the one place the plugin does not prefix for us.
  expect(sw).toContain(`createHandlerBoundToURL("/vinreader/index.html")`);
});
