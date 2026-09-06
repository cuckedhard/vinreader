/**
 * The service worker's route for the engine, which is the engine's entire offline story.
 *
 * Nothing precaches these four files (S5 addendum §3), so a URL this pattern does not
 * match is a URL that fails as soon as the network does — and the failure is invisible
 * until someone is standing in a parking garage. The service worker itself cannot be
 * exercised in this repo's e2e run (the dev certificate is self-signed, and Chromium
 * refuses to register a worker fetched over one), so the pattern is checked here against
 * the URLs `assets.ts` actually builds.
 */
import { describe, expect, it } from "vitest";
import { ocrAssetUrl } from "./assets";
import { OCR_ASSET_LIST } from "./assets.generated";
import {
  OCR_ASSET_ROUTE,
  OCR_CHAR_WHITELIST,
  OCR_PAGE_SEG_MODE,
  OCR_PARAMS,
  OCR_WHITELIST_PARAM,
  OCR_MAX_MEMORY_BYTES,
  OCR_MAX_MEMORY_PAGES,
  OCR_OEM,
} from "./constants";

const ROOT = "https://vinrelay.example/";
const PAGES = "https://zach.github.io/vinreader/";

describe("OCR_ASSET_ROUTE", () => {
  it("matches every asset, at the site root and under a Pages sub-path", () => {
    for (const base of [ROOT, PAGES]) {
      for (const spec of OCR_ASSET_LIST) {
        expect(OCR_ASSET_ROUTE.test(ocrAssetUrl(base, spec.file)), `${base}${spec.file}`).toBe(
          true,
        );
      }
    }
  });

  it("matches nothing in the shell, which the precache manifest already owns", () => {
    for (const url of [
      `${ROOT}index.html`,
      `${ROOT}assets/index-iVNkh3a4.js`,
      `${PAGES}assets/session-C66zmmnm.js`,
      `${ROOT}sw.js`,
      `${ROOT}icon-512.png`,
      `${ROOT}manifest.webmanifest`,
    ]) {
      expect(OCR_ASSET_ROUTE.test(url), url).toBe(false);
    }
  });

  it("does not reach past one path segment", () => {
    // `ocr/` is flat. A pattern that swallowed sub-paths would start serving anything
    // filed under a directory of that name from a cache that never expires.
    expect(OCR_ASSET_ROUTE.test(`${ROOT}ocr/nested/thing.js`)).toBe(false);
    expect(OCR_ASSET_ROUTE.test(`${ROOT}ocr/`)).toBe(false);
  });

  it("is not anchored on the site root, because a Pages install is not at one", () => {
    expect(OCR_ASSET_ROUTE.source.startsWith("^")).toBe(false);
  });
});

describe("the pinned engine settings", () => {
  it("caps memory at 256 MB, which is 4096 pages (§4)", () => {
    expect(OCR_MAX_MEMORY_BYTES).toBe(268_435_456);
    expect(OCR_MAX_MEMORY_PAGES).toBe(4096);
  });

  it("runs LSTM only: the core carries no legacy engine and the model no legacy data", () => {
    // `OEM.LSTM_ONLY`. `OEM.DEFAULT` (3) would ask for a legacy model that is not there.
    expect(OCR_OEM).toBe(1);
  });

  it("whitelists uppercase, digits and the hyphen, and nothing else", () => {
    expect(OCR_CHAR_WHITELIST).toBe("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-");
  });

  /**
   * Measured in Chromium on `PNT WA8555`, which is the shape §5's crop box produces: with
   * `A-Z0-9-` the engine returns one word `PNTWA8555` at page confidence 0 and drops the
   * `W` to 15; with a space it returns two words at 91 with every symbol at 98–99. The
   * space is the separator, not a character that can fabricate a code, and §5's pattern
   * step is the word boundaries it buys.
   */
  it("gives the engine a space as well, and keeps it out of what a proposal may contain", () => {
    expect(OCR_PARAMS.tessedit_char_whitelist).toBe(`${OCR_CHAR_WHITELIST} `);
    expect(OCR_WHITELIST_PARAM).toContain(" ");
    // The set a *proposal* is filtered against is still the measured one: a space in a
    // paint code would be two tokens, and `keepable` is what says so.
    expect(OCR_CHAR_WHITELIST).not.toContain(" ");
    expect(OCR_PARAMS.tessedit_pageseg_mode).toBe(OCR_PAGE_SEG_MODE);
  });
});
