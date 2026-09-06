/**
 * The tessdata container, read and rebuilt without its dictionaries.
 *
 * S5 addendum §3: 89.8% of `eng.traineddata` is an English word dictionary, and here it is
 * not merely dead weight. A dictionary is a prior over sequences of letters, and a paint
 * code is not a word — so it bends `WA8555` toward something pronounceable and returns it
 * *confidently wrong*, which is the one failure N2 exists to prevent, because nothing
 * downstream of a paint code can contradict it. Stripping it is 4,113,088 → 409,234 bytes
 * at zero measured accuracy loss over 180 images.
 *
 * The file format is a table of contents followed by the components it names: an
 * `int32` count, then one `int64` offset per component (`-1` where the component is
 * absent), then the component bodies. A component's length is the distance to the next
 * present offset, and the last one runs to the end of the file. `combine_tessdata -u`
 * followed by a recombine without the `*-dawg` files produces the same result; doing it
 * on the bytes needs no tesseract on the build machine and can be asserted in a test.
 *
 * The runtime reads this too. `dictionaryComponents()` is run against the model actually
 * fetched, so a model that carries a dictionary — a stale cache entry, a mis-copied
 * asset — fails loudly (P7) instead of quietly degrading into wrong answers.
 *
 * Pure: bytes in, bytes out. No DOM, no I/O.
 */

/** Bytes of the count field that opens the table of contents. */
const COUNT_BYTES = 4;

/** Bytes of one offset entry. */
const OFFSET_BYTES = 8;

/** The offset written for a component the file does not carry. */
const ABSENT = -1;

/**
 * Component indices, from tesseract's `TessdataType`. The three this build drops are the
 * LSTM dictionaries; the six legacy dictionaries are named too because `tessdata_fast`
 * omitting them today is not a reason for the check to miss them tomorrow.
 */
export const TESSDATA = {
  LANG_CONFIG: 0,
  UNICHARSET: 1,
  AMBIGS: 2,
  INTTEMP: 3,
  PFFMTABLE: 4,
  NORMPROTO: 5,
  PUNC_DAWG: 6,
  WORD_DAWG: 7,
  NUMBER_DAWG: 8,
  FREQ_DAWG: 9,
  FIXED_LENGTH_DAWGS: 10,
  CUBE_UNICHARSET: 11,
  CUBE_SYSTEM_DAWG: 12,
  SHAPE_TABLE: 13,
  BIGRAM_DAWG: 14,
  UNAMBIG_DAWG: 15,
  PARAMS_MODEL: 16,
  LSTM: 17,
  LSTM_PUNC_DAWG: 18,
  LSTM_WORD_DAWG: 19,
  LSTM_NUMBER_DAWG: 20,
  LSTM_UNICHARSET: 21,
  LSTM_RECODER: 22,
  VERSION: 23,
} as const;

/** Every component that is a dictionary, legacy or LSTM. None of these may ship (§3). */
export const DICTIONARY_COMPONENTS: readonly number[] = [
  TESSDATA.PUNC_DAWG,
  TESSDATA.WORD_DAWG,
  TESSDATA.NUMBER_DAWG,
  TESSDATA.FREQ_DAWG,
  TESSDATA.FIXED_LENGTH_DAWGS,
  TESSDATA.CUBE_SYSTEM_DAWG,
  TESSDATA.BIGRAM_DAWG,
  TESSDATA.UNAMBIG_DAWG,
  TESSDATA.LSTM_PUNC_DAWG,
  TESSDATA.LSTM_WORD_DAWG,
  TESSDATA.LSTM_NUMBER_DAWG,
];

/**
 * What an LSTM-only recognizer needs, and nothing else: the model, the character set it
 * was trained over, the recoder that maps codes back to characters, and the version
 * string tesseract prints when it refuses to load a file it does not understand.
 */
export const KEPT_COMPONENTS: readonly number[] = [
  TESSDATA.LSTM,
  TESSDATA.LSTM_UNICHARSET,
  TESSDATA.LSTM_RECODER,
  TESSDATA.VERSION,
];

export interface TrainedDataComponent {
  index: number;
  offset: number;
  length: number;
}

/**
 * The components a `.traineddata` carries, in file order.
 *
 * Throws on anything that is not one: an implausible entry count, an offset outside the
 * file, or offsets that do not increase. A `.traineddata` is fetched over the network at
 * runtime, so "this is not the file we shipped" has to be an error and not a shrug.
 */
export function readTrainedData(bytes: Uint8Array): TrainedDataComponent[] {
  if (bytes.length < COUNT_BYTES) throw new Error("traineddata: too short for a header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getInt32(0, true);
  // Tesseract has never shipped a container with more than a few dozen components; the
  // bound is what stops a garbage first word from asking for a gigabyte of offsets.
  if (count <= 0 || count > 64) throw new Error(`traineddata: implausible entry count ${count}`);
  const headerBytes = COUNT_BYTES + OFFSET_BYTES * count;
  if (bytes.length < headerBytes) throw new Error("traineddata: header runs past the end");

  const present: TrainedDataComponent[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = Number(view.getBigInt64(COUNT_BYTES + OFFSET_BYTES * index, true));
    if (offset === ABSENT) continue;
    if (offset < headerBytes || offset > bytes.length) {
      throw new Error(`traineddata: component ${index} offset ${offset} is outside the file`);
    }
    const previous = present[present.length - 1];
    if (previous !== undefined && offset <= previous.offset) {
      throw new Error(`traineddata: component ${index} offset ${offset} does not advance`);
    }
    present.push({ index, offset, length: 0 });
  }
  if (present.length === 0) throw new Error("traineddata: no components");

  for (let i = 0; i < present.length; i += 1) {
    const end = i + 1 < present.length ? present[i + 1].offset : bytes.length;
    present[i].length = end - present[i].offset;
  }
  return present;
}

/** The indices of every dictionary the file carries. Empty is the only shippable answer. */
export function dictionaryComponents(bytes: Uint8Array): number[] {
  return readTrainedData(bytes)
    .map((component) => component.index)
    .filter((index) => DICTIONARY_COMPONENTS.includes(index));
}

/**
 * The same file with every component outside `KEPT_COMPONENTS` removed.
 *
 * The table of contents keeps its original length, so the arithmetic is the source's minus
 * the dropped bodies: on `tessdata_fast/eng.traineddata` that is 4,113,088 → 409,234.
 */
export function stripDictionaries(bytes: Uint8Array): Uint8Array {
  const components = readTrainedData(bytes);
  const kept = components.filter((component) => KEPT_COMPONENTS.includes(component.index));
  const missing = KEPT_COMPONENTS.filter(
    (index) => !kept.some((component) => component.index === index),
  );
  if (missing.length > 0) {
    throw new Error(`traineddata: source is missing components ${missing.join(", ")}`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getInt32(0, true);
  const headerBytes = COUNT_BYTES + OFFSET_BYTES * count;
  const bodyBytes = kept.reduce((total, component) => total + component.length, 0);

  const out = new Uint8Array(headerBytes + bodyBytes);
  const outView = new DataView(out.buffer);
  outView.setInt32(0, count, true);
  for (let index = 0; index < count; index += 1) {
    outView.setBigInt64(COUNT_BYTES + OFFSET_BYTES * index, BigInt(ABSENT), true);
  }
  let cursor = headerBytes;
  for (const component of kept) {
    outView.setBigInt64(COUNT_BYTES + OFFSET_BYTES * component.index, BigInt(cursor), true);
    out.set(bytes.subarray(component.offset, component.offset + component.length), cursor);
    cursor += component.length;
  }
  return out;
}
