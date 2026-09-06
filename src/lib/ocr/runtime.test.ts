/**
 * The three CDN defaults, and the settings that keep a dictionary out of the answer.
 *
 * tesseract.js resolves `workerPath`, `corePath` and `langPath` to three separate
 * `cdn.jsdelivr.net` URLs unless every one of them is overridden. Overriding two of three
 * is the failure mode worth testing for: it works in the office, sends a request to a
 * third party at OCR time (N3), and dies in a parking garage.
 */
import { describe, expect, it } from "vitest";
import {
  OCR_CHAR_WHITELIST,
  OCR_INIT_CONFIG,
  OCR_LANG,
  OCR_OEM,
  OCR_PAGE_SEG_MODE,
} from "./constants";
import {
  createTesseractWorker,
  RECOGNIZE_OUTPUT,
  resolveTesseractModule,
  tesseractOptions,
  tesseractPaths,
  toOcrLine,
  type TesseractPage,
  type TesseractWorkerLike,
} from "./runtime";
import { OcrError } from "./types";

const ROOT = "https://vinrelay.example/";
const PAGES = "https://zach.github.io/vinreader/";
const FILES = { worker: "worker.min.js", core: "tesseract-core-simd-lstm.wasm.js" };

describe("tesseractPaths", () => {
  it("puts all three under this origin, at the root and under a sub-path alike", () => {
    expect(tesseractPaths(ROOT, FILES)).toEqual({
      workerUrl: "https://vinrelay.example/ocr/worker.min.js",
      coreUrl: "https://vinrelay.example/ocr/tesseract-core-simd-lstm.wasm.js",
      langPath: "https://vinrelay.example/ocr",
    });
    expect(tesseractPaths(PAGES, FILES)).toEqual({
      workerUrl: "https://zach.github.io/vinreader/ocr/worker.min.js",
      coreUrl: "https://zach.github.io/vinreader/ocr/tesseract-core-simd-lstm.wasm.js",
      langPath: "https://zach.github.io/vinreader/ocr",
    });
  });

  it("leaves langPath without a trailing slash, because tesseract.js appends one", () => {
    // `${langPath}/${lang}.traineddata` — a trailing slash here asks for `//eng…`.
    expect(tesseractPaths(ROOT, FILES).langPath.endsWith("/")).toBe(false);
  });
});

describe("tesseractOptions", () => {
  const options = tesseractOptions(tesseractPaths(PAGES, FILES));

  it("overrides all three paths that would otherwise reach a CDN", () => {
    expect(options.workerPath).toBe("https://zach.github.io/vinreader/ocr/worker.min.js");
    expect(options.corePath).toBe(
      "https://zach.github.io/vinreader/ocr/tesseract-core-simd-lstm.wasm.js",
    );
    expect(options.langPath).toBe("https://zach.github.io/vinreader/ocr");
  });

  it("leaves no value pointing anywhere but this origin", () => {
    for (const [key, value] of Object.entries(options)) {
      if (typeof value !== "string" || !value.startsWith("http")) continue;
      expect(value, `${key} leaves the origin`).toMatch(/^https:\/\/zach\.github\.io\/vinreader\//);
    }
  });

  it("spawns the worker from a real URL, so the service worker controls it offline", () => {
    expect(options.workerBlobURL).toBe(false);
  });

  it("asks for the model uncompressed and does not copy it into a second store", () => {
    expect(options.gzip).toBe(false);
    expect(options.cacheMethod).toBe("none");
  });
});

describe("createTesseractWorker", () => {
  function fakeWorker() {
    const calls: { params: Record<string, string>[] } = { params: [] };
    const worker: TesseractWorkerLike = {
      setParameters: async (params) => {
        calls.params.push(params);
        return params;
      },
      recognize: async () => ({ data: { text: "", confidence: 0, blocks: [] } }),
      terminate: async () => {},
    };
    return { worker, calls };
  }

  it("initializes LSTM-only English with both dictionary loads off", async () => {
    const seen: unknown[] = [];
    const { worker, calls } = fakeWorker();
    const created = await createTesseractWorker(
      {
        createWorker: async (langs, oem, options, config) => {
          seen.push({ langs, oem, options, config });
          return worker;
        },
      },
      tesseractPaths(ROOT, FILES),
    );

    expect(created).toBe(worker);
    expect(seen[0]).toMatchObject({
      langs: OCR_LANG,
      oem: OCR_OEM,
      config: { ...OCR_INIT_CONFIG },
    });
    // §3: `load_system_dawg` and `load_freq_dawg` are `*_INIT_MEMBER` parameters, so this
    // is the only call that can set them. `setParameters` would be ignored.
    expect(OCR_INIT_CONFIG).toEqual({ load_system_dawg: "false", load_freq_dawg: "false" });
    expect(calls.params).toEqual([
      { tessedit_char_whitelist: OCR_CHAR_WHITELIST, tessedit_pageseg_mode: OCR_PAGE_SEG_MODE },
    ]);
  });

  it("runs at PSM 7, because §3 measured the default returning nothing at all", () => {
    expect(OCR_PAGE_SEG_MODE).toBe("7");
  });

  it("whitelists exactly the characters paint codes are made of", () => {
    for (const code of ["1F7", "NH-731P", "UG", "LC9X", "WA8555"]) {
      for (const char of code) expect(OCR_CHAR_WHITELIST).toContain(char);
    }
    expect(OCR_CHAR_WHITELIST).not.toContain(" ");
    expect(OCR_CHAR_WHITELIST).not.toContain("a");
  });
});

describe("toOcrLine", () => {
  function page(symbols: { text: string; confidence: number }[]): TesseractPage {
    return {
      text: symbols.map((s) => s.text).join(""),
      confidence: 71,
      blocks: [{ paragraphs: [{ lines: [{ words: [{ symbols }] }] }] }],
    };
  }

  it("keeps a confidence per character, which is what §5 marks", () => {
    const line = toOcrLine(
      page([
        { text: "W", confidence: 96 },
        { text: "A", confidence: 41 },
        { text: "8", confidence: 88 },
      ]),
    );
    expect(line.text).toBe("WA8");
    expect(line.chars).toEqual([
      { char: "W", confidence: 96 },
      { char: "A", confidence: 41 },
      { char: "8", confidence: 88 },
    ]);
    expect(line.confidence).toBe(71);
  });

  it("drops whatever the whitelist does not allow, including the spaces tesseract adds", () => {
    const line = toOcrLine(
      page([
        { text: "N", confidence: 90 },
        { text: " ", confidence: 10 },
        { text: "H", confidence: 90 },
        { text: "-", confidence: 80 },
        { text: "7", confidence: 70 },
      ]),
    );
    expect(line.text).toBe("NH-7");
  });

  it("survives a page with no blocks at all rather than throwing at the caller", () => {
    expect(toOcrLine({ text: "", confidence: 0, blocks: null })).toEqual({
      text: "",
      confidence: 0,
      chars: [],
    });
    expect(toOcrLine({ text: "", confidence: 0 }).chars).toEqual([]);
    expect(toOcrLine({ text: "", confidence: 0, blocks: [{}] }).chars).toEqual([]);
    expect(toOcrLine({ text: "", confidence: 0, blocks: [{ paragraphs: [{}] }] }).chars).toEqual(
      [],
    );
    expect(
      toOcrLine({ text: "", confidence: 0, blocks: [{ paragraphs: [{ lines: [{}] }] }] }).chars,
    ).toEqual([]);
    expect(
      toOcrLine({
        text: "",
        confidence: 0,
        blocks: [{ paragraphs: [{ lines: [{ words: [{}] }] }] }],
      }).chars,
    ).toEqual([]);
  });

  it("asks tesseract for the symbols it walks, not only for the text", () => {
    // `data.text` alone cannot say which position was the doubtful one, and §5 marks the
    // two lowest-confidence positions and no others.
    expect(RECOGNIZE_OUTPUT).toEqual({ text: true, blocks: true });
  });
});

describe("resolveTesseractModule", () => {
  const module = { createWorker: async () => ({}) as never };

  it("unwraps the default export, which is the only one the shipped bundle has", () => {
    // `dist/tesseract.esm.min.js` is a CommonJS bundle wrapped for ESM: one export, and it
    // is `default`. Reading `createWorker` off the namespace gets `undefined`, and the
    // only place that shows up is a browser.
    expect(resolveTesseractModule({ default: module })).toBe(module);
  });

  it("accepts a namespace that carries createWorker itself", () => {
    expect(resolveTesseractModule(module)).toBe(module);
  });

  it("fails loudly on anything else rather than returning something unusable", () => {
    for (const value of [null, undefined, {}, { default: {} }, { createWorker: 1 }]) {
      expect(() => resolveTesseractModule(value)).toThrow(/createWorker/);
    }
    expect(() => resolveTesseractModule(null)).toThrow(OcrError);
  });
});
