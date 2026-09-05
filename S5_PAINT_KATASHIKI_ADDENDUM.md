# Spec addendum — paint code and katashiki capture

Status: **proposed, not built.** Nothing here is implemented. It needs Zach's decisions in §D
and then a `start S5` trigger (CLAUDE.md rule 1). Two of the decisions touch §4 constants, so
they are his alone (§13.6).

## 0. Why this is not a decode

Neither value is derivable from a VIN, and NHTSA does not carry either.

- **Paint code** is printed on a separate sticker. No check digit, no grammar shared across
  manufacturers: Toyota `1F7`, Honda `NH-731P`, Ford `UG`, VW `LC9X`, GM `WA8555`.
- **Katashiki** (型式) is the Japanese type designation off a JDM manufacturer plate — `ZRE212`,
  `JZX100`, `GF-JZX100`. Not part of ISO 3779.

`src/lib/vpic/fields.ts` maps no colour or paint key, and NHTSA's own position is that a missing
value means they do not hold the data — manufacturers keep full build data in dealer systems.

So this is **capture**, not decode. The consequence runs through everything below: a VIN that is
misread keeps failing loudly afterwards — vPIC returns nothing, the check-digit chip stays warn on
the sheet forever. **A misread paint code is never contradicted by anything.** It renders as
confidently as a correct one, syncs, exports to CSV, rides the §4.9 handoff, and is read aloud at
a paint counter three weeks later. There is no downstream check. The human is the check digit.

## 1. Two layers, built in this order

**Layer 1 — typed capture.** Two nullable strings on the record, a sheet field for each, §5.3
upsert behaviour on re-scan, §4.9 payload slots, CSV/TSV columns.

**Layer 2 — OCR, on top.** Pre-fills the same form. Never replaces it.

Layer 1 is not a fallback; it is a prerequisite. Every OCR flow ends in a human confirming or
correcting, and the route when OCR returns nothing usable is typing. **Lockdown Mode on iOS
disables WebAssembly outright** — the existing pure-JS ZXing path survives it, an OCR path does
not — so manual entry is load-bearing regardless of how well layer 2 works.

## 2. Payload budget — measured, not a concern

A fully-populated heavy-truck record is **453 bytes** against §4.9's 700-byte cap. Both new fields
cost **48 bytes**.

| payload | bytes | free |
|---|---|---|
| full Cascadia record, every vPIC field | 453 | 247 |
| + paint + katashiki | 501 | 199 |
| + verbose paint (`WA8555 Summit White`) | 512 | 188 |

## 3. What the OCR research established

Measured against tesseract.js 7.0.0, not recalled.

**The engine is larger than the app.** Current production bundle: 1.3 MB. Self-hosted OCR:
**~4.48 MB raw / ~1.87 MB gzip**, and Cache Storage holds the decompressed bytes. Using stock
defaults instead costs ~16 MB.

**The biggest single lever is free.** 89.8% of `eng.traineddata` is an English word dictionary —
useless here and actively harmful, because it bends `WA8555` toward a word and returns it
*confidently wrong*. Stripping it: **4,113,088 → 409,234 bytes, a 10x reduction, with zero
accuracy loss** measured across 180 images.

**No Japanese data needed.** The katashiki value is Latin; it read 5/5 correctly even while the
型式 label itself OCR'd as garbage. Saves 2.47 MB.

**The default setting is the broken one.** Tesseract's default PSM 3 returned *completely empty
text* on 4 of 10 realistic full-label images. PSM 6/11 recovered all of them. The failure is
layout analysis, not recognition.

**Accuracy, and read this as a ceiling.** 96.1% exact-match / 99.1% character with a charset
whitelist, on *synthetic* single-line crops. Rotation is the weak axis — 7° of tilt drops exact
match to 83%. Roughly **4 in 100 codes wrong, undetectably**. There is no published benchmark for
this task; every figure is transferred from licence plates and container codes.

**A landmine already in this repo.** `vite.config.ts:62` and `vite.pages.config.ts:104` both set
`globPatterns: ["**/*.{js,css,html,svg,png,woff2}"]`. tesseract.js loads the base64-embedded
`.wasm.js` core, which **ends in `.js` and therefore matches** — and then workbox's
`maximumFileSizeToCacheInBytes` default of 2 MiB **silently drops it with a warning, not an
error**. Result: OCR that works online and dies offline. Separately, `.traineddata` and `.wasm`
match no glob at all. Cache the model lazily in Cache Storage; keep it out of the precache
manifest entirely.

**A free win worth trying before OCR.** GM 2018+ certification labels carry a QR payload
documented to include the paint code, and `buildScanHints()` already enables `QR_CODE`. That is a
decoded fact rather than a guess. Verify against a real vehicle before shipping a parser.

**"Point at the door jamb" is wrong for many vehicles.** VW/Audi use the vehicle data sticker in
the trunk or spare-wheel well; GM legacy is the SPID label in the glovebox or trunk; JDM caution
plates are typically in the engine bay — and that same plate carries the colour code, so one
capture can fill both fields.

## 4. iOS — viable, with hard constraints

None of these are style preferences; each is a recorded failure mode.

- **No threads, no `SharedArrayBuffer`.** GitHub Pages cannot set COOP/COEP, and Safari does not
  support `COEP: credentialless`. Single-threaded, SIMD, LSTM-only.
- **Cap `MAXIMUM_MEMORY` at 256 MB.** WebKit reserves the whole declared maximum up front, which
  is the documented cause of OOM *at instantiation* rather than at use.
- **One worker, one instance, never while the barcode scanner is live.** iOS caps fast WASM
  memories at 3 per web-content process.
- **Backgrounding is cancellation, not pause.** ~7–8 seconds of grace, then suspension. Abort on
  `visibilitychange`; never require the user to stay on screen.
- **No torch.** WebKit ignores the torch constraint, so iOS leans on stills, digital zoom and
  multi-frame voting instead.
- **No native OCR is reachable.** `TextDetector` has no MDN compat entry; WebKit's ShapeDetection
  preference is `status: testable`, default-false. VisionKit is user-invoked system UI only, with
  no JS trigger and no confidence.

## 5. The interaction — propose, never assert

**Never auto-accept, at any confidence.** The argument, not the assertion: for a VIN there are two
independent downstream checks that fail in uncorrelated ways; for a paint code there are zero.
Auto-accept saves one tap on an optional field and deletes the last check in the system.

Frame agreement does not rescue it. ZXing's two-read rule works because a bad decode comes from a
bad *frame*; an OCR confusion (`B/8`, `0/O/D/Q`, `1/I/L`, `5/S`, `2/Z`, `6/G`) comes from the
*glyph shape*, which is identical on every frame of the same sticker in the same light. Use voting
— it kills transient garbage and bought 66.7% → 81% on plates — but it earns a better default
string, not the right to skip the human.

**The real risk is a human confirming without reading**, so the confirmation is designed to
resist that:

- The value lives **inside** the primary control — the button reads `Save  NH-731P`, in
  `--vin-font` at VinDisplay size on a ≥56 px primary. Tap target and reading target are the same
  pixels. A pre-filled field with a Save button beside it is auto-accept with extra steps.
- The **cropped pixels the engine read** sit directly above the characters, memory-only, discarded
  on save (§12 forbids attaching the photo).
- Only the **≤2 lowest-confidence positions** are marked, with one line: *"Check the marked
  characters."* Marking everything marks nothing.
- Correction is a row of **per-character ≥56 px buttons** — tap a character, get its confusion
  set. No caret, no long-press (§6.1). A plain typed field is always present as the escape.
- 2–3 candidates render as **equal-weight ≥56 px buttons, nothing preselected**, with the
  differing characters highlighted. Never a `<select>`, never a radio with a default. Cap at 3.
- `source: "ocr"` and the confidence are persisted so nothing downstream mistakes it for a decoded
  fact — the same discipline `extractVin` already applies when it refuses an ambiguous run.

## D. Decisions for Zach

1. **JDM imports in the fleet — yes or no?** If yes, those vehicles have no 17-character VIN, only
   a chassis number like `JZX100-0012345`. That is a **second identifier type** alongside VIN and
   PIN, not a new field, and it is a materially bigger change than everything else here.
2. **`DROP_ORDER` position (§4.9 constant — Zach only).** Currently
   `n → en → dr → fu → bc → tr → gv`. A paint code is often the reason a handoff is sent to a body
   shop, so it arguably drops last or never. Overflow is unlikely at 501/700 bytes, but the order
   must be defined.
3. **§5.3 upsert on re-scan.** Does a re-scan overwrite an existing paint code, keep it, or prompt
   the way `unit`/`notes` do?
4. **Is a ~4.5 MB lazy download acceptable** for an optional field, given the app is 1.3 MB?
5. **Layer 1 alone first, or both together?** Layer 1 is small and unblocks the feature; layer 2
   is the larger half and carries every risk above.

## §13.7 — what no agent can settle

Every accuracy number here is synthetic or transferred from other domains. **There is no corpus of
real door-jamb stickers**, so no threshold, no preprocessing choice and no engine setting is yet
grounded in this task. Before layer 2 is tuned, `bench/` needs real labels across manufacturers,
lighting and angles with ground truth. Until it exists, any accuracy target is invented.

Also human-only: whether GM's 2018+ QR payload really carries the paint code on a real vehicle,
and where each manufacturer in this fleet actually puts its label.
