# Spec addendum — paint code capture (S5)

Status: **specified, ready to build.** Needs the three decisions in §D and a `start S5` trigger.

**Scope halved on 2026-09-05.** Zach: no JDM imports in the fleet. Katashiki is therefore out
entirely, and with it the whole second-identifier question — no chassis numbers, no non-VIN
records, no Dexie primary-key change, no Postgres primary-key change under RLS. **Project rule 9
stands untouched: records are keyed by VIN and upserted.** What remains is one nullable string on
an existing record.

## 0. Why this is capture, not decode

A paint code is not derivable from a VIN, and NHTSA does not carry it. `src/lib/vpic/fields.ts`
maps no colour key, and NHTSA's own position is that a missing value means they do not hold the
data — manufacturers keep full build data in dealer systems.

The consequence runs through every decision below. A misread VIN keeps failing loudly afterwards:
vPIC returns nothing, the check-digit chip stays warn on the sheet forever. **A misread paint code
is never contradicted by anything.** No check digit, no grammar, no downstream lookup. It renders
as confidently as a correct one, syncs, exports to CSV, rides the §4.9 handoff, and is read aloud
at a paint counter three weeks later. **The human is the only check.**

## 1. Two layers, in this order

**Layer 1 — typed capture.** One nullable `paint` string on the record; a sheet field; §5.3 upsert
behaviour on re-scan; a §4.9 payload slot; a CSV/TSV column.

**Layer 2 — OCR, on top.** Pre-fills the same field. Never replaces it.

Layer 1 is a prerequisite, not a fallback. Every OCR flow ends in a human confirming or
correcting, and the route when OCR returns nothing usable is typing. **iOS Lockdown Mode disables
WebAssembly outright** — the existing pure-JS ZXing path survives it, an OCR path does not — so
manual entry is load-bearing however well layer 2 works.

## 2. Payload budget — measured, not a concern

| payload | bytes | free |
|---|---|---|
| full Cascadia record, every vPIC field | 453 | 247 |
| + paint code | 473 | 227 |
| + verbose paint (`WA8555 Summit White`) | 484 | 216 |

§4.9's cap is 700. One field costs 20 bytes.

## 3. OCR, measured against tesseract.js 7.0.0

**The engine is larger than the app.** Production bundle 1.3 MB; self-hosted OCR ~4.48 MB raw /
~1.87 MB gzip, and Cache Storage holds the decompressed bytes. Stock defaults cost ~16 MB.

**The biggest saving is free.** 89.8% of `eng.traineddata` is an English word dictionary —
useless here and actively harmful, because it bends `WA8555` toward a word and returns it
*confidently wrong*. Stripping it: **4,113,088 → 409,234 bytes, 10x, zero accuracy loss** across
180 measured images. Set `load_system_dawg=false` and `load_freq_dawg=false` as well.

**The default setting is the broken one.** Tesseract's default PSM 3 returned *completely empty
text* on 4 of 10 realistic full-label images. PSM 6/11 recovered all ten; PSM 7 for a tight
single-line crop. The failure is layout analysis, not recognition.

**Accuracy is a ceiling.** 96.1% exact-match / 99.1% character with an `A-Z0-9-` whitelist, on
*synthetic* single-line crops. Rotation is the weak axis — 7° of tilt drops exact match to 83%.
Roughly **4 in 100 codes wrong, undetectably**. No published benchmark exists for this task; every
figure is transferred from licence plates and container codes.

**A landmine already in this repo.** `vite.config.ts:62` and `vite.pages.config.ts:104` both glob
`**/*.{js,css,html,svg,png,woff2}`. tesseract.js loads the base64-embedded `.wasm.js` core, which
**ends in `.js` and matches** — and workbox's `maximumFileSizeToCacheInBytes` default of 2 MiB then
**silently drops it with a warning, not an error**. That is OCR that works online and dies offline.
`.traineddata` and `.wasm` match no glob at all. Cache the model lazily in Cache Storage; keep it
out of the precache manifest.

**Try the barcode first — it is free and deterministic.** GM 2018+ certification labels carry a QR
payload documented to include the paint code, and `buildScanHints()` already enables `QR_CODE`.
That is a decoded fact rather than an OCR guess. Verify against a real vehicle before shipping a
parser, and fall through to OCR on any mismatch.

**"Point at the door jamb" is wrong for many vehicles.** VW/Audi use the vehicle data sticker in
the trunk or spare-wheel well; GM legacy is the SPID label in the glovebox or trunk. The capture
UI must not assume a location.

## 4. iOS — viable, with hard constraints

Each is a recorded failure mode, not a preference.

- **No threads, no `SharedArrayBuffer`.** GitHub Pages cannot set COOP/COEP and Safari does not
  support `COEP: credentialless`. Single-threaded, SIMD, LSTM-only.
- **Cap `MAXIMUM_MEMORY` at 256 MB.** WebKit reserves the declared maximum up front, which is the
  documented cause of OOM *at instantiation* rather than at use.
- **One worker, one instance, never while the barcode scanner is live.** iOS caps fast WASM
  memories at 3 per web-content process.
- **Backgrounding is cancellation.** ~7–8 s of grace, then suspension. Abort on
  `visibilitychange`; never require the user to stay on screen.
- **No torch** — WebKit ignores the constraint. Lean on stills, digital zoom, multi-frame voting.
- **No native OCR is reachable.** `TextDetector` has no MDN compat entry; WebKit's ShapeDetection
  preference is `status: testable`, default-false. VisionKit is user-invoked system UI only.

## 5. The interaction — propose, never assert

**Never auto-accept, at any confidence.** For a VIN there are two independent downstream checks
that fail in uncorrelated ways; for a paint code there are zero. Auto-accept saves one tap on an
optional field and deletes the last check in the system.

Frame agreement does not rescue it. ZXing's two-read rule works because a bad decode comes from a
bad *frame*; an OCR confusion (`B/8`, `0/O/D/Q`, `1/I/L`, `5/S`, `2/Z`, `6/G`) comes from the
*glyph shape*, identical on every frame of the same sticker in the same light. Voting kills
transient garbage — it bought 66.7% → 81% on plates — but it earns a better default string, not
the right to skip the human.

**The real risk is a human confirming without reading**, so the confirmation resists it:

- The value lives **inside** the primary control — `Save  NH-731P`, in `--vin-font` at VinDisplay
  size on a ≥56 px primary. Tap target and reading target are the same pixels. A pre-filled field
  with a Save button beside it is auto-accept with extra steps.
- The **cropped pixels the engine read** sit above the characters, memory-only, discarded on save
  (§12 forbids attaching the photo).
- Only the **≤2 lowest-confidence positions** are marked: *"Check the marked characters."*
  Marking everything marks nothing.
- Correction is a row of **per-character ≥56 px buttons** — tap a character, get its confusion
  set. No caret, no long-press (§6.1). A typed field is always present as the escape.
- 2–3 candidates render as **equal-weight ≥56 px buttons, nothing preselected**, differing
  characters highlighted. Never a `<select>`, never a radio with a default. Cap at 3.
- Persist `source: "ocr"` and the confidence so nothing downstream mistakes it for a decoded fact
  — the discipline `extractVin` already applies when it refuses an ambiguous run.
- **A user-aligned crop box, not template matching and not full-frame plus regex.** Ford's two
  letters and GM's four digits cannot be separated from GVWR/PSI/date tokens by pattern; it will
  fabricate. Make the box a generous single *line* so a gloved user can hit it.

## D. Decisions for Zach

1. **`DROP_ORDER` position (§4.9 constant — Zach only).** Currently
   `n → en → dr → fu → bc → tr → gv`. A paint code is often the reason a handoff goes to a body
   shop, so it arguably drops last or never. Overflow is unlikely at 473/700, but the order must
   be defined.
2. **§5.3 upsert on re-scan.** Does a re-scan overwrite an existing paint code, keep it, or prompt
   the way `unit`/`notes` do?
3. **Is a ~4.5 MB lazy download acceptable** for an optional field, given the app is 1.3 MB?

## §13.7 — what no agent can settle

Every accuracy figure here is synthetic or transferred from another domain. **There is no corpus
of real door-jamb stickers**, so no threshold, no preprocessing choice and no engine setting is
grounded in this task. Before layer 2 is tuned, `bench/` needs real labels across manufacturers,
lighting and angles with ground truth. Until that exists, any accuracy target is invented.

Also human-only: whether GM's 2018+ QR payload really carries the paint code on a real vehicle,
and where each manufacturer in this fleet actually puts its label.
