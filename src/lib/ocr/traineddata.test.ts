/**
 * The dictionary strip, and the check that runs again at load time.
 *
 * S5 addendum §3 makes this the highest-value transform in the slice: the dictionary is
 * 89.8% of the file *and* it is the thing that turns `WA8555` into a confident word. N2 is
 * the reason the runtime re-checks rather than trusting the build — a paint code has no
 * check digit, no grammar and no downstream lookup, so a model quietly carrying a
 * dictionary would show up as nothing at all until someone mixed the wrong paint.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OCR_ASSETS } from "./assets.generated";
import {
  DICTIONARY_COMPONENTS,
  KEPT_COMPONENTS,
  TESSDATA,
  dictionaryComponents,
  readTrainedData,
  stripDictionaries,
} from "./traineddata";

const MODEL = fileURLToPath(
  new URL(`../../../public/ocr/${OCR_ASSETS.model.file}`, import.meta.url),
);

const ENTRIES = 24;
const HEADER_BYTES = 4 + 8 * ENTRIES;

/** A container carrying exactly the components asked for, in index order. */
function container(parts: { index: number; body: number[] }[], count = ENTRIES): Uint8Array {
  const header = 4 + 8 * count;
  const total = header + parts.reduce((sum, part) => sum + part.body.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setInt32(0, count, true);
  for (let i = 0; i < count; i += 1) view.setBigInt64(4 + 8 * i, BigInt(-1), true);
  let cursor = header;
  for (const part of parts) {
    view.setBigInt64(4 + 8 * part.index, BigInt(cursor), true);
    out.set(part.body, cursor);
    cursor += part.body.length;
  }
  return out;
}

/** The four an LSTM-only recognizer needs, with recognisable bodies. */
const KEPT_PARTS = [
  { index: TESSDATA.LSTM, body: [1, 1, 1, 1] },
  { index: TESSDATA.LSTM_UNICHARSET, body: [2, 2] },
  { index: TESSDATA.LSTM_RECODER, body: [3, 3, 3] },
  { index: TESSDATA.VERSION, body: [4] },
];

describe("readTrainedData", () => {
  it("reads offsets and derives each length from the next component", () => {
    const bytes = container([
      { index: TESSDATA.LSTM, body: [1, 2, 3, 4, 5] },
      { index: TESSDATA.VERSION, body: [9, 9] },
    ]);
    expect(readTrainedData(bytes)).toEqual([
      { index: TESSDATA.LSTM, offset: HEADER_BYTES, length: 5 },
      { index: TESSDATA.VERSION, offset: HEADER_BYTES + 5, length: 2 },
    ]);
  });

  it("refuses a file that is not one", () => {
    expect(() => readTrainedData(new Uint8Array(2))).toThrow(/too short/);
    expect(() => readTrainedData(container([], 0))).toThrow(/implausible entry count/);
    expect(() => readTrainedData(container([], 65))).toThrow(/implausible entry count/);
    // A plausible count with no room for the offsets it promises.
    const truncated = new Uint8Array(8);
    new DataView(truncated.buffer).setInt32(0, ENTRIES, true);
    expect(() => readTrainedData(truncated)).toThrow(/header runs past the end/);
    expect(() => readTrainedData(container([]))).toThrow(/no components/);
  });

  it("refuses an offset outside the file, and offsets that do not advance", () => {
    const outside = container([{ index: TESSDATA.LSTM, body: [1] }]);
    new DataView(outside.buffer).setBigInt64(4 + 8 * TESSDATA.LSTM, BigInt(1_000_000), true);
    expect(() => readTrainedData(outside)).toThrow(/outside the file/);

    const inHeader = container([{ index: TESSDATA.LSTM, body: [1] }]);
    new DataView(inHeader.buffer).setBigInt64(4 + 8 * TESSDATA.LSTM, BigInt(4), true);
    expect(() => readTrainedData(inHeader)).toThrow(/outside the file/);

    const backwards = container([
      { index: TESSDATA.LSTM, body: [1, 2] },
      { index: TESSDATA.VERSION, body: [3] },
    ]);
    new DataView(backwards.buffer).setBigInt64(
      4 + 8 * TESSDATA.VERSION,
      BigInt(HEADER_BYTES),
      true,
    );
    expect(() => readTrainedData(backwards)).toThrow(/does not advance/);
  });
});

describe("stripDictionaries", () => {
  const withDictionaries = container([
    { index: TESSDATA.LSTM, body: [1, 1, 1, 1] },
    { index: TESSDATA.LSTM_PUNC_DAWG, body: [7, 7, 7, 7, 7, 7, 7, 7] },
    { index: TESSDATA.LSTM_WORD_DAWG, body: new Array(64).fill(8) },
    { index: TESSDATA.LSTM_NUMBER_DAWG, body: [9, 9] },
    { index: TESSDATA.LSTM_UNICHARSET, body: [2, 2] },
    { index: TESSDATA.LSTM_RECODER, body: [3, 3, 3] },
    { index: TESSDATA.VERSION, body: [4] },
  ]);

  it("drops every dictionary and keeps every component the recognizer needs", () => {
    const stripped = stripDictionaries(withDictionaries);
    expect(readTrainedData(stripped).map((component) => component.index)).toEqual([
      ...KEPT_COMPONENTS,
    ]);
    expect(dictionaryComponents(withDictionaries)).toEqual([
      TESSDATA.LSTM_PUNC_DAWG,
      TESSDATA.LSTM_WORD_DAWG,
      TESSDATA.LSTM_NUMBER_DAWG,
    ]);
    expect(dictionaryComponents(stripped)).toEqual([]);
  });

  it("keeps the kept bodies byte for byte", () => {
    const stripped = stripDictionaries(withDictionaries);
    const lstm = readTrainedData(stripped)[0];
    expect([...stripped.subarray(lstm.offset, lstm.offset + lstm.length)]).toEqual([1, 1, 1, 1]);
  });

  it("shrinks by exactly the dictionaries, and by nothing else", () => {
    const dropped = 8 + 64 + 2;
    expect(stripDictionaries(withDictionaries).length).toBe(withDictionaries.length - dropped);
  });

  it("leaves an already stripped file alone", () => {
    const once = stripDictionaries(container(KEPT_PARTS));
    expect([...stripDictionaries(once)]).toEqual([...once]);
  });

  it("refuses a source that is missing something the recognizer needs", () => {
    const noRecoder = container(KEPT_PARTS.filter((p) => p.index !== TESSDATA.LSTM_RECODER));
    expect(() => stripDictionaries(noRecoder)).toThrow(
      new RegExp(`missing components ${TESSDATA.LSTM_RECODER}`),
    );
  });

  it("names every dictionary tesseract can carry, legacy ones included", () => {
    // `tessdata_fast` ships none of the legacy six, which is exactly why they are easy to
    // leave out of the list and never notice.
    for (const index of [
      TESSDATA.PUNC_DAWG,
      TESSDATA.WORD_DAWG,
      TESSDATA.NUMBER_DAWG,
      TESSDATA.FREQ_DAWG,
      TESSDATA.BIGRAM_DAWG,
      TESSDATA.UNAMBIG_DAWG,
    ]) {
      expect(DICTIONARY_COMPONENTS).toContain(index);
    }
  });
});

describe("the model this build ships", () => {
  const model = new Uint8Array(readFileSync(MODEL));

  it("carries no dictionary at all (§3: 89.8% of the file, and the wrong prior)", () => {
    expect(dictionaryComponents(model)).toEqual([]);
  });

  it("carries the LSTM model, its unicharset, its recoder and the version string", () => {
    expect(readTrainedData(model).map((component) => component.index)).toEqual([
      ...KEPT_COMPONENTS,
    ]);
  });

  it("is 409,234 bytes — the measured 10x of §3, not an approximation of it", () => {
    expect(model.length).toBe(409_234);
    expect(model.length).toBe(OCR_ASSETS.model.bytes);
  });

  it("still says which tesseract wrote it, so the engine can refuse a file it cannot read", () => {
    const version = readTrainedData(model).find((c) => c.index === TESSDATA.VERSION)!;
    const text = new TextDecoder().decode(
      model.subarray(version.offset, version.offset + version.length),
    );
    expect(text).toBe("4.00.00alpha:eng:synth20170629");
  });
});
