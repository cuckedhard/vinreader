/**
 * Builds the four self-hosted OCR assets in `public/ocr/`, and the manifest
 * `src/lib/ocr/assets.generated.ts` that the runtime downloads and verifies them against.
 *
 *     bun run build:ocr            # downloads the pinned tessdata_fast source
 *     bun run build:ocr <path>     # or reads it from a file already on disk
 *
 * Why the assets are self-hosted at all: tesseract.js resolves `workerPath`, `corePath` and
 * `langPath` to three separate `cdn.jsdelivr.net` URLs by default. Every one of those is a
 * request to a third party at OCR time, which N3 forbids outright, and none of them is
 * reachable from an installed app in a parking garage. All three are overridden, and this
 * script is what they are overridden to.
 *
 * The outputs are committed. This script is how they are reproduced and how the inputs are
 * pinned — every source is verified by digest before it is used, so a dependency bump that
 * moves any of them fails here rather than shipping something nobody measured.
 *
 * S5 addendum §3 and §4 carry the reasoning for each transform; `traineddata.ts`,
 * `wasmMemory.ts` and `coreBundle.ts` carry the transforms themselves and their tests.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { OCR_MAX_MEMORY_PAGES } from "../src/lib/ocr/constants";
import { capCoreMaximumMemory } from "../src/lib/ocr/coreBundle";
import { stripDictionaries } from "../src/lib/ocr/traineddata";

const ROOT = resolve(import.meta.dirname, "..");
const OUT_DIR = resolve(ROOT, "public/ocr");
const MANIFEST = resolve(ROOT, "src/lib/ocr/assets.generated.ts");

/**
 * `tessdata_fast`'s English model: the smallest LSTM tesseract publishes, and the file
 * S5 addendum §3's 4,113,088 → 409,234 measurement was taken on. Not on npm in this form,
 * so it is fetched once and pinned by digest.
 */
const TRAINEDDATA_URL =
  "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/eng.traineddata";
const TRAINEDDATA_SHA256 = "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2";

/**
 * The three files taken from node_modules, each pinned to the bytes this build measured.
 *
 * The core is the single-threaded, SIMD, LSTM-only variant, and that choice is §4's:
 * threads need COOP/COEP, which GitHub Pages cannot set and Safari cannot work around;
 * the legacy engine is dead weight next to an LSTM-only model.
 */
const SOURCES = {
  runtime: {
    from: "node_modules/tesseract.js/dist/tesseract.esm.min.js",
    sha256: "64871d76c75609fd5413b88a8171e2ef40deedd77d5875ba23df104b2d05eb29",
  },
  worker: {
    from: "node_modules/tesseract.js/dist/worker.min.js",
    sha256: "576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d",
  },
  core: {
    from: "node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js",
    sha256: "c58b46a4c796c0b8afccf77591d5b875b6896b45d402bbce8caa6f5362447b38",
  },
} as const;

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readPinned(from: string, expected: string): Buffer {
  const bytes = readFileSync(resolve(ROOT, from));
  const actual = sha256(bytes);
  if (expected !== "" && actual !== expected) {
    throw new Error(`${from}: expected sha256 ${expected}, found ${actual}`);
  }
  if (expected === "") console.log(`  (unpinned source ${from} — sha256 ${actual})`);
  return bytes;
}

async function readTrainedDataSource(): Promise<Uint8Array> {
  const path = process.argv[2];
  const bytes =
    path === undefined
      ? new Uint8Array(await (await fetch(TRAINEDDATA_URL)).arrayBuffer())
      : new Uint8Array(readFileSync(resolve(process.cwd(), path)));
  const actual = sha256(bytes);
  if (actual !== TRAINEDDATA_SHA256) {
    throw new Error(`traineddata: expected sha256 ${TRAINEDDATA_SHA256}, found ${actual}`);
  }
  return bytes;
}

interface Built {
  key: string;
  file: string;
  bytes: Uint8Array;
  note: string;
}

async function build(): Promise<Built[]> {
  const runtime = readPinned(SOURCES.runtime.from, SOURCES.runtime.sha256);
  const worker = readPinned(SOURCES.worker.from, SOURCES.worker.sha256);
  const coreSource = readPinned(SOURCES.core.from, SOURCES.core.sha256).toString("utf8");
  const trainedSource = await readTrainedDataSource();

  const core = capCoreMaximumMemory(coreSource, OCR_MAX_MEMORY_PAGES);
  const model = stripDictionaries(trainedSource);

  return [
    { key: "runtime", file: "tesseract.esm.min.js", bytes: runtime, note: "verbatim" },
    { key: "worker", file: "worker.min.js", bytes: worker, note: "verbatim" },
    {
      key: "core",
      file: "tesseract-core-simd-lstm.wasm.js",
      bytes: new TextEncoder().encode(core),
      note: `MAXIMUM_MEMORY capped to ${OCR_MAX_MEMORY_PAGES} pages`,
    },
    {
      key: "model",
      file: "eng.traineddata",
      bytes: model,
      note: `dictionaries stripped, ${trainedSource.length} -> ${model.length}`,
    },
  ];
}

function manifestSource(built: Built[]): string {
  const entries = built
    .map(
      (asset) =>
        `  ${asset.key}: {\n` +
        `    file: ${JSON.stringify(asset.file)},\n` +
        `    bytes: ${asset.bytes.length},\n` +
        `    sha256: ${JSON.stringify(sha256(asset.bytes))},\n` +
        `  },`,
    )
    .join("\n");
  return `/**
 * Generated by \`bun run build:ocr\` — do not edit.
 *
 * The size and digest of every file in \`public/ocr/\`. The runtime checks a lazily fetched
 * asset against these before it is used and before it is cached: a truncated 3.9 MB
 * download over a dropping connection is otherwise a Cache Storage entry that is wrong
 * forever, and a model carrying a dictionary is wrong in the direction N2 exists to
 * prevent. Knowing the sizes up front is also what lets the download be shown as a size
 * before it is started rather than as a spinner.
 */
export interface OcrAssetSpec {
  /** File name under the app's \`ocr/\` directory. */
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

export const OCR_ASSETS = {
${entries}
} as const satisfies Record<string, OcrAssetSpec>;

/** Fetch order: everything the worker needs before the model it will read. */
export const OCR_ASSET_LIST: readonly OcrAssetSpec[] = [
${built.map((asset) => `  OCR_ASSETS.${asset.key},`).join("\n")}
];

/** What "first OCR use" costs on the wire, before any transfer encoding. */
export const OCR_TOTAL_BYTES = ${built.reduce((total, asset) => total + asset.bytes.length, 0)};
`;
}

const built = await build();
mkdirSync(OUT_DIR, { recursive: true });
for (const asset of built) {
  writeFileSync(resolve(OUT_DIR, asset.file), asset.bytes);
  console.log(`  public/ocr/${asset.file}  ${asset.bytes.length} bytes  (${asset.note})`);
}
writeFileSync(MANIFEST, manifestSource(built));
console.log(`  src/lib/ocr/assets.generated.ts`);
