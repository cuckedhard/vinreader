# §13.4 scan-robustness bench

**FAIL** — 14 §13.6 thresholds missed.

## Run

| | |
|---|---|
| Run seed | `0x5eed1a7c` |
| VINs | 200 (full) |
| Symbologies | code_39, code_39_i, code_39_check, code_128, code_128_fnc1, data_matrix, qr_code |
| Tiers | clean, moderate, severe |
| Attempts | 12600 (4200 per path) |
| **Decode path (verdict)** | `canvas` — the app's path — Chromium, `ScanFrameReader.decodeFromCanvas` — §9-S1's ROI band (90% x 40%, SB-3) first and the whole frame after it — `FrameLuminanceSource`, `decodeWithState` |
| **Frame (SB-2)** | `frame` — the symbol composited unscaled and centred on a white 1920x1080 field — what `@zxing/browser` draws from the `<video>` (SB-2) |
| Symbol fill | 33.6% of the frame width, mean over 4200 frames |
| Also measured | `yuv` — `canvas`, with the frame first put through a **modelled** BT.601 studio-swing I420 round trip — the colour half of a camera capture, not a camera |
| Also measured | `rgb` — node, `RGBLuminanceSource` + `MultiFormatReader.decode` — the control, not the app |
| Browser pages | 4 |
| Chromium | /opt/pw-browsers/chromium-1194/chrome-linux/chrome |
| Decoder hints (§4.6) | CODE_39, CODE_128, DATA_MATRIX, QR_CODE; TRY_HARDER, ASSUME_GS1 |
| Severe extras (Z5) | 2 of warp, glare, low_light, jpeg, drawn per frame from the seed |
| ZXing per-reader warnings swallowed (`rgb` only) | 8232 |
| Reads carrying the §4.6 AIM identifier | 0 — no row in this corpus opens with FNC1, so §4.6's strip is inert here and these rates do not depend on it; it is exercised by the probe quoted below (SB-8) |

Every degradation seed is `runSeed ^ fnv1a("vin|symbology|tier")` — the decode path is deliberately not in the key, so every instrument reads the same pixels. This run reproduces exactly, and any single row below reproduces on its own.

Every rate, miss reason and false accept below is `canvas`'s unless it says otherwise. The instrument delta is its own section.

**These numbers are measured on the frame the app decodes (SB-2), and they are much worse than the ones this report used to carry.** The bench used to hand ZXing a tight crop — a ~1050 px symbol in a ~1100 px image. `useScanner` calls `decodeFromStream`, and `@zxing/browser` draws the whole `<video>` onto its capture canvas at `videoWidth` x `videoHeight`, so under §6.3's `ideal` constraints the decoder gets 1920x1080 with the symbol filling 33.6% of the width and the rest of the field empty. The symbol pixels are byte-identical either way — the degraded image is composited unscaled and centred, never resampled — so the whole difference between the old table and this one is the field around the symbol. Nothing about the corpus, the tiers or the §4.6 hints changed. The old numbers were a measurement of an easier problem than the product solves, and they were optimistic in the direction that matters. `--layout crop` reproduces them, as a diagnostic that cannot write this file.

## Headline: false accepts (§13.6 requires 0)

**0 false accepts** in 4200 attempts on `canvas`. Threshold 0.

Zero at one seed is not zero (SB-7). §13.6's zero is a claim about the whole corpus, and a run is one draw from it: R4-F was found at one seed, and SB-1 only turned up on the fourth seed of a five-seed sweep, at 2 in 21,000. A clean headline here means this run produced none — nothing more.

### Quoted, not measured by this run (SB-11)

Everything above this line is this run's own count over its own attempts. What follows is a **record of a measurement taken once and not re-taken here**: no part of this run recomputes those 21,000 attempts, and this block will go on printing until someone does.

| | |
|---|---|
| Quoted result | **0 false accepts in 21,000 attempts** |
| Seeds | `0x5eed1a7c`, `0x11111111`, `0x2bad5eed`, `0x7f3ac91d`, `0xdecafbad` — 200 VINs each |
| Taken at | `harden S1` round 2, re-taken after SB-2 moved the bench onto the app's frame; ledger rows SB-1 and SB-7 |
| Re-take with | `bun run bench/run.ts --seed <s> --paths canvas` |
| Still comparable? | **Yes** — this run matches the sweep's configuration on layout, verdict path, corpus size, symbology set, §4.6 formats and hints, and the Z5 severe draw. |

**What that check cannot see.** It compares the bench's configuration, not the program: a change inside `src/lib/vin`, in `bwip-js`'s rendering, in `sharp`'s degradations or in ZXing itself moves decodes without moving a single axis above. Nothing short of re-running the command covers that, and a quote is never evidence that a **current** run is clean.

### Replayed by this run: the known Code 128 collisions (SB-11)

Both mod-103-valid misreads this slice has found, re-decoded on this run's `frame` layout through `canvas`. Fixed seeds, so `--seed` and `--severe-extras` do not move them; they are recorded frames, not corpus attempts, and they are counted nowhere above.

| Ledger | Expected VIN | Collision reads | Symbology | Drawn extras | This run | Decoded text |
|---|---|---|---|---|---|---|
| R4-F | `EH8U2YHX60HU8VGWD` | `EH8U2YHX60HU7VAWD` | code_128 | low_light + jpeg | reads nothing | - |
| SB-1 | `KB7BWYDJ6TW0808Z3` | `KB7BWYDJ6TW0874Z3` | code_128_fnc1 | warp + low_light | reads nothing | - |

Neither reads on this instrument, which is what the quoted sweep's explanation rests on: the frame changed which frames decode at all, and a decode that no longer happens cannot be wrong. **That is not a disproof.** The collisions are arithmetic in Code 128's own check, not artefacts of a crop, and the quoted 21,000 attempts bound the rate at roughly 1 in 7,000 at 95% — which is not zero.

**If you are about to crop the frame (SB-3), this is the number you are about to change.** Both rows above read as nothing because of the frame the app decodes; an ROI band recovers marginal Code 128 frames, which is the population they came from. Read *What ROI risks* below before writing it.

## Decode rate per symbology × tier

| Symbology | clean (>= 99.0%) | moderate (>= 90.0%) | severe (>= 70.0%) |
|---|---|---|---|
| code_39 | 100.0% exact PASS | 77.5% ±5.8 FAIL | 34.0% ±6.5 FAIL |
| code_39_i | 100.0% exact PASS | 79.0% ±5.6 FAIL | 28.5% ±6.2 FAIL |
| code_39_check | 24.0% exact FAIL | 18.5% ±5.4 FAIL | 8.5% ±3.9 FAIL |
| code_128 | 100.0% exact PASS | 81.0% ±5.4 FAIL | 31.0% ±6.4 FAIL |
| code_128_fnc1 | 100.0% exact PASS | 75.5% ±5.9 FAIL | 0.0% ±0.9 FAIL |
| data_matrix | 100.0% exact PASS | 99.5% ±1.3 PASS | 40.0% ±6.7 FAIL |
| qr_code | 98.5% exact FAIL | 98.0% ±2.1 PASS | 45.5% ±6.8 FAIL |

Decode rate is end to end: the fraction of frames that produced the **correct** VIN
through ZXing and §4.2 `extractVin`, not the fraction that merely decoded.

Each cell reads `rate ±band PASS/FAIL`. **The band is how far this cell moves when the run seed moves** — see *What a cell is worth* below. `exact` means the cell cannot move: the clean tier applies no seeded randomness, so a clean-tier miss is structural and re-running will never fix it.

**Tier ordering holds** (§13.4): clean >= moderate >= severe in every cell.

### Detail

| Symbology | Tier | Attempts | Hits | Misses | Errors | False accepts | Rate | Seed band | Threshold | Margin | Status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| code_39 | clean | 200 | 200 | 0 | 0 | 0 | 100.0% | exact (no randomness) | 99.0% | +1.0 pp | PASS |
| code_39 | moderate | 200 | 155 | 45 | 0 | 0 | 77.5% | 71.2%-82.7% | 90.0% | -12.5 pp | FAIL |
| code_39 | severe | 200 | 68 | 132 | 0 | 0 | 34.0% | 27.8%-40.8% | 70.0% | -36.0 pp | FAIL |
| code_39_i | clean | 200 | 200 | 0 | 0 | 0 | 100.0% | exact (no randomness) | 99.0% | +1.0 pp | PASS |
| code_39_i | moderate | 200 | 158 | 42 | 0 | 0 | 79.0% | 72.8%-84.1% | 90.0% | -11.0 pp | FAIL |
| code_39_i | severe | 200 | 57 | 143 | 0 | 0 | 28.5% | 22.7%-35.1% | 70.0% | -41.5 pp | FAIL |
| code_39_check | clean | 200 | 48 | 152 | 0 | 0 | 24.0% | exact (no randomness) | 99.0% | -75.0 pp | FAIL |
| code_39_check | moderate | 200 | 37 | 163 | 0 | 0 | 18.5% | 13.7%-24.5% | 90.0% | -71.5 pp | FAIL |
| code_39_check | severe | 200 | 17 | 183 | 0 | 0 | 8.5% | 5.4%-13.2% | 70.0% | -61.5 pp | FAIL |
| code_128 | clean | 200 | 200 | 0 | 0 | 0 | 100.0% | exact (no randomness) | 99.0% | +1.0 pp | PASS |
| code_128 | moderate | 200 | 162 | 38 | 0 | 0 | 81.0% | 75.0%-85.8% | 90.0% | -9.0 pp | FAIL |
| code_128 | severe | 200 | 62 | 138 | 0 | 0 | 31.0% | 25.0%-37.7% | 70.0% | -39.0 pp | FAIL |
| code_128_fnc1 | clean | 200 | 200 | 0 | 0 | 0 | 100.0% | exact (no randomness) | 99.0% | +1.0 pp | PASS |
| code_128_fnc1 | moderate | 200 | 151 | 49 | 0 | 0 | 75.5% | 69.1%-80.9% | 90.0% | -14.5 pp | FAIL |
| code_128_fnc1 | severe | 200 | 0 | 200 | 0 | 0 | 0.0% | 0.0%-1.9% | 70.0% | -70.0 pp | FAIL |
| data_matrix | clean | 200 | 200 | 0 | 0 | 0 | 100.0% | exact (no randomness) | 99.0% | +1.0 pp | PASS |
| data_matrix | moderate | 200 | 199 | 1 | 0 | 0 | 99.5% | 97.2%-99.9% | 90.0% | +9.5 pp | PASS |
| data_matrix | severe | 200 | 80 | 120 | 0 | 0 | 40.0% | 33.5%-46.9% | 70.0% | -30.0 pp | FAIL |
| qr_code | clean | 200 | 197 | 3 | 0 | 0 | 98.5% | exact (no randomness) | 99.0% | -0.5 pp | FAIL |
| qr_code | moderate | 200 | 196 | 4 | 0 | 0 | 98.0% | 95.0%-99.2% | 90.0% | +8.0 pp | PASS |
| qr_code | severe | 200 | 91 | 109 | 0 | 0 | 45.5% | 38.7%-52.4% | 70.0% | -24.5 pp | FAIL |

### Severe: what each frame drew

| Drawn extras | Frames | code_39 | code_39_i | code_39_check | code_128 | code_128_fnc1 | data_matrix | qr_code |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| glare + jpeg | 234 | 74.2% | 67.7% | 10.5% | 61.8% | 0.0% | 100.0% | 100.0% |
| glare + low_light | 255 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 2.4% | 83.3% |
| low_light + jpeg | 203 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 87.1% |
| warp + glare | 236 | 69.7% | 55.2% | 8.3% | 60.0% | 0.0% | 75.0% | 0.0% |
| warp + jpeg | 229 | 66.7% | 57.1% | 23.8% | 74.2% | 0.0% | 90.0% | 0.0% |
| warp + low_light | 243 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |

§13.4 lists six degradations for `severe`; two of them — 50% scale and heavier grain — are harder settings of degradations `moderate` already applies, so they are on for every frame and the tier stays a strict superset of `moderate` whatever is drawn. The other four are drawn 2 at a time (Z5): all four at once is not one bad photo, it is every bad photo, and it left no cell above 57%.

## Instrument delta (finding B2)

Same corpus, same seed, **same degraded pixels** — the frame is warped once and offered to each instrument. `canvas` is the app's decode path; the columns beside it are what the other instruments made of the identical frames. A positive Δ means the app reads more than the other instrument did.

**What is different between the instruments, and what is not.** Not colour: on a grey frame the two luminance sources reduce to the same bytes — `RGBLuminanceSource` takes the green-favouring average `(r + 2g + b) / 4` and the app's `FrameLuminanceSource` takes ZXing's `(306r + 601g + 117b + 512) >> 10`, and at `r = g = b = v` both are exactly `v`. This corpus renders grey. Three things do differ. **(1)** The app decodes §9-S1's ROI band before it decodes the whole frame (SB-3) and the `rgb` control decodes the frame only, which is where a `rgb` delta on this corpus comes from. **(2)** The app's source can rotate, so `OneDReader` takes `TRY_HARDER`'s 90° retry (R6-SA-1, where it used to throw once per miss frame); `RGBLuminanceSource` answers `isRotateSupported()` with false and never takes it. That retry cannot help a symbol which is already horizontal, and every symbol in this corpus is, so it moves no cell here — it is named because it is a real difference between the two instruments, not because it explains a number. **(3)** `decodeWithState` against `decode(bitmap, hints)`, which rebuild the same readers from the same hints. The `yuv` column is the control: it is the one path that moves frames, so a delta table that shows it moving is a table that can see a difference when there is one.

### `canvas` vs `yuv`

`yuv`: `canvas`, with the frame first put through a **modelled** BT.601 studio-swing I420 round trip — the colour half of a camera capture, not a camera.

| Symbology | Tier | canvas | yuv | Δ pp | canvas only | yuv only | both | neither |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| code_39 | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| code_39 | moderate | 77.5% | 77.5% | +0.0 | 0 | 0 | 155 | 45 |
| code_39 | severe | 34.0% | 34.5% | -0.5 | 0 | 1 | 68 | 131 |
| code_39_i | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| code_39_i | moderate | 79.0% | 79.0% | +0.0 | 0 | 0 | 158 | 42 |
| code_39_i | severe | 28.5% | 29.5% | -1.0 | 2 | 4 | 55 | 139 |
| code_39_check | clean | 24.0% | 24.0% | +0.0 | 0 | 0 | 48 | 152 |
| code_39_check | moderate | 18.5% | 18.5% | +0.0 | 0 | 0 | 37 | 163 |
| code_39_check | severe | 8.5% | 8.5% | +0.0 | 1 | 1 | 16 | 182 |
| code_128 | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| code_128 | moderate | 81.0% | 81.0% | +0.0 | 0 | 0 | 162 | 38 |
| code_128 | severe | 31.0% | 30.0% | +1.0 | 2 | 0 | 60 | 138 |
| code_128_fnc1 | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| code_128_fnc1 | moderate | 75.5% | 76.5% | -1.0 | 0 | 2 | 151 | 47 |
| code_128_fnc1 | severe | 0.0% | 0.0% | +0.0 | 0 | 0 | 0 | 200 |
| data_matrix | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| data_matrix | moderate | 99.5% | 99.5% | +0.0 | 0 | 0 | 199 | 1 |
| data_matrix | severe | 40.0% | 39.5% | +0.5 | 1 | 0 | 79 | 120 |
| qr_code | clean | 98.5% | 98.5% | +0.0 | 0 | 0 | 197 | 3 |
| qr_code | moderate | 98.0% | 98.0% | +0.0 | 0 | 0 | 196 | 4 |
| qr_code | severe | 45.5% | 45.5% | +0.0 | 0 | 0 | 91 | 109 |

Over 4200 frames: `canvas` 2678 correct, `yuv` 2680 correct — 6 read only by `canvas`, 8 read only by `yuv`.

### `canvas` vs `rgb`

`rgb`: node, `RGBLuminanceSource` + `MultiFormatReader.decode` — the control, not the app.

| Symbology | Tier | canvas | rgb | Δ pp | canvas only | rgb only | both | neither |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| code_39 | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| code_39 | moderate | 77.5% | 77.5% | +0.0 | 0 | 0 | 155 | 45 |
| code_39 | severe | 34.0% | 30.0% | +4.0 | 8 | 0 | 60 | 132 |
| code_39_i | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| code_39_i | moderate | 79.0% | 79.0% | +0.0 | 0 | 0 | 158 | 42 |
| code_39_i | severe | 28.5% | 23.5% | +5.0 | 11 | 1 | 46 | 142 |
| code_39_check | clean | 24.0% | 24.0% | +0.0 | 0 | 0 | 48 | 152 |
| code_39_check | moderate | 18.5% | 18.5% | +0.0 | 0 | 0 | 37 | 163 |
| code_39_check | severe | 8.5% | 7.0% | +1.5 | 3 | 0 | 14 | 183 |
| code_128 | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| code_128 | moderate | 81.0% | 80.5% | +0.5 | 1 | 0 | 161 | 38 |
| code_128 | severe | 31.0% | 25.0% | +6.0 | 12 | 0 | 50 | 138 |
| code_128_fnc1 | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| code_128_fnc1 | moderate | 75.5% | 71.0% | +4.5 | 9 | 0 | 142 | 49 |
| code_128_fnc1 | severe | 0.0% | 0.0% | +0.0 | 0 | 0 | 0 | 200 |
| data_matrix | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| data_matrix | moderate | 99.5% | 99.0% | +0.5 | 1 | 0 | 198 | 1 |
| data_matrix | severe | 40.0% | 37.0% | +3.0 | 6 | 0 | 74 | 120 |
| qr_code | clean | 98.5% | 98.5% | +0.0 | 0 | 0 | 197 | 3 |
| qr_code | moderate | 98.0% | 98.0% | +0.0 | 0 | 0 | 196 | 4 |
| qr_code | severe | 45.5% | 43.0% | +2.5 | 5 | 0 | 86 | 109 |

Over 4200 frames: `canvas` 2678 correct, `rgb` 2623 correct — 56 read only by `canvas`, 1 read only by `rgb`.

### The 87 frames that read differently (first 20)

| Path | VIN | Symbology | Tier | Drawn extras | app | other | Seed |
|---|---|---|---|---|---|---|---|
| yuv | `0W4B348U890HX2JC1` | code_39 | severe | warp + jpeg | miss (no decode) | hit `0W4B348U890HX2JC1` | `0xf1e22a9b` |
| yuv | `1FUJA6CK14LM12345` | code_39_i | severe | warp + glare | hit `I1FUJA6CK14LM12345` | miss (no decode) | `0xbdc8545d` |
| yuv | `B33ZSLFN0H2NHWFEE` | code_39_i | severe | warp + glare | miss `IB33ZSLF$0H2NHWFEE` | hit `IB33ZSLFN0H2NHWFEE` | `0x9567ad0b` |
| yuv | `MYTVHJ2823YBUYKE0` | code_39_i | severe | warp + jpeg | miss (no decode) | hit `IMYTVHJ2823YBUYKE0` | `0xfbafea79` |
| yuv | `4LY6BDTG2RPG54RKP` | code_39_i | severe | glare + jpeg | hit `I4LY6BDTG2RPG54RKP` | miss (no decode) | `0x8bcc2e44` |
| yuv | `VSJ0D0W00NXMJZ916` | code_39_i | severe | warp + jpeg | miss (no decode) | hit `IVSJ0D0W00NXMJZ916` | `0xba3e696c` |
| yuv | `ZNCNNV4N0XSW7LSGF` | code_39_i | severe | warp + jpeg | miss (no decode) | hit `IZNCNNV4N0XSW7LSGF` | `0xbc5dfbc9` |
| yuv | `YDKU00AD5JDBRYVNR` | code_39_check | severe | warp + glare | miss `YDKU00AD5JDBRYVNR9` | miss (no decode) | `0xb7857b84` |
| yuv | `1AN1P0C26RBSXXCVL` | code_39_check | severe | glare + jpeg | hit `1AN1P0C26RBSXXCVLI` | miss (no decode) | `0xf22a5f0a` |
| yuv | `VAJ260MW4Z4JC1L7G` | code_39_check | severe | warp + jpeg | miss (no decode) | hit `VAJ260MW4Z4JC1L7GQ` | `0xbcf4f7fb` |
| yuv | `ZNCNNV4N0XSW7LSGF` | code_39_check | severe | warp + glare | miss `ZNCNNV4N0XSW7LSGFA` | miss (no decode) | `0x91afa7f4` |
| yuv | `K8TBG7DT77102AAC8` | code_128 | severe | glare + jpeg | miss `K8TBG"D177102A,C8` | miss (no decode) | `0xa99e1dc1` |
| yuv | `EE37XVLL3E7XTYSNH` | code_128 | severe | glare + jpeg | hit `EE37XVLL3E7XTYSNH` | miss (no decode) | `0x3283a3eb` |
| yuv | `MDM8MX585CNH40H0K` | code_128 | severe | glare + jpeg | hit `MDM8MX585CNH40H0K` | miss (no decode) | `0x8ff2c72d` |
| yuv | `8YUR04UN0VBADRZFF` | code_128_fnc1 | moderate | - | miss (no decode) | hit `8YUR04UN0VBADRZFF1P84203911` | `0x868a6b5c` |
| yuv | `R5MLG5KM7FCG14EDZ` | code_128_fnc1 | moderate | - | miss (no decode) | hit `R5MLG5KM7FCG14EDZ1P84203911` | `0x12afca55` |
| yuv | `90DMJDGR15GNNNB4H` | data_matrix | severe | glare + low_light | hit `90DMJDGR15GNNNB4H` | miss (no decode) | `0xa3067205` |
| rgb | `1HTMMAAL67H412345` | code_39 | severe | warp + jpeg | hit `1HTMMAAL67H412345` | miss (no decode) | `0x1e703dec` |
| rgb | `4B31UKKD5LXDZ8GV9` | code_39 | severe | warp + glare | hit `4B31UKKD5LXDZ8GV9` | miss (no decode) | `0x2a6c4b95` |
| rgb | `XFEBNVLS708P97PF0` | code_39 | severe | warp + glare | hit `XFEBNVLS708P97PF0` | miss (no decode) | `0x336f282e` |

### Why the misses missed

| Symbology | Tier | no_decode | no_vin | carrier |
|---|---|---:|---:|---:|
| code_39 | clean | 0 | 0 | 0 |
| code_39 | moderate | 45 | 0 | 0 |
| code_39 | severe | 132 | 0 | 0 |
| code_39_i | clean | 0 | 0 | 0 |
| code_39_i | moderate | 42 | 0 | 0 |
| code_39_i | severe | 141 | 2 | 0 |
| code_39_check | clean | 0 | 152 | 0 |
| code_39_check | moderate | 49 | 114 | 0 |
| code_39_check | severe | 124 | 59 | 0 |
| code_128 | clean | 0 | 0 | 0 |
| code_128 | moderate | 38 | 0 | 0 |
| code_128 | severe | 137 | 1 | 0 |
| code_128_fnc1 | clean | 0 | 0 | 0 |
| code_128_fnc1 | moderate | 49 | 0 | 0 |
| code_128_fnc1 | severe | 200 | 0 | 0 |
| data_matrix | clean | 0 | 0 | 0 |
| data_matrix | moderate | 1 | 0 | 0 |
| data_matrix | severe | 120 | 0 | 0 |
| qr_code | clean | 3 | 0 | 0 |
| qr_code | moderate | 4 | 0 | 0 |
| qr_code | severe | 109 | 0 | 0 |

`no_decode` — ZXing found no symbol. `no_vin` — text decoded but §4.2 named no VIN. `carrier` — a §4.9 handoff payload, which §6.3 never extracts; nothing in this corpus is one, so any non-zero value here is itself a finding.

## What a cell is worth (SB-7)

A cell above is 200 frames at **one run seed**. Change the seed and every `moderate` and `severe` frame draws a different rotation, warp, glare, grain and JPEG quality, so the cell moves.

**Quoted, not measured by this run (SB-11).** The five-seed sweep recorded at `harden S1` round 2, re-taken after SB-2 moved the bench onto the app's frame; ledger rows SB-1 and SB-7 — 200 VINs at `0x5eed1a7c`, `0x11111111`, `0x2bad5eed`, `0x7f3ac91d`, `0xdecafbad` — spread `code_128` moderate over 75.0%-83.5% and `qr_code` severe over 37.5%-46.0% — 8.5 pp each — with `code_128` severe and `data_matrix` severe at 8.0 pp. (On the pre-SB-2 crop layout the widest was `code_128` severe at 11.5 pp.) Its configuration still matches this run's, so those spreads describe these cells. Re-take it with `bun run bench/run.ts --seed <s> --paths canvas`. None of it was ever stated here, so a fixer who moved a moderate cell by 5 pp on one seed and called it a fix had measured noise.

**`clean` is exact.** The clean tier applies no seeded randomness at all — `degrade` returns the rendered symbol untouched — so a clean cell is byte-identical at every seed, and its measured spread across those five runs was 0.0 pp in every symbology. That is not a small band, it is no band: **a clean-tier miss is structural** (SB-4). The same three `qr_code` VINs fail at every seed and no re-run will move them.

**This run measured one seed**, so the band on each `moderate` and `severe` cell is estimated from that cell's own sample: a 95% Wilson interval on `hits / attempts`. It estimates the same thing a sweep measures — a cell is n independent frames either way — and it was checked against the sweep rather than trusted. A 95% interval is about 3.9 standard errors wide and the range of five draws is about 2.3, so a five-seed spread should come out near 0.6 of this band; over the twenty-one cells swept it came out at 0.24-1.06, median 0.48. The band is therefore honest and, for a five-run comparison, slightly generous — which is the safe direction. Wilson rather than the normal approximation because cells sit near 0 and near 1 here. To measure it instead of estimating it: `bun run bench/run.ts --seeds a,b,c --paths canvas` — a diagnostic, n runs, which never writes this file.

**The operating rule.** The widest band in this run is `qr_code` severe, 13.7 pp wide. Comparing two runs carries that uncertainty twice, so a before/after difference has to clear roughly 1.4x the band — about 19.3 pp on that cell — before it is a claim rather than a coincidence. Below that, sweep three seeds before it goes in a ledger row. It cuts both ways: a regression inside the band is not a regression either.

**No verdict changes inside these bands.** Not one failing cell reaches its threshold at the top of its band; the closest is `code_128` moderate at 81.0%, whose band tops out at 85.8% against 90.0%. And the false-accept threshold is a count, not a rate, so no band applies to it at all: one is one.

## The frame, and the ROI crop somebody is about to write (SB-2 / SB-3 / SB-10)

Measured by `bun run bench/frame-probe.ts --count 40` at seed `0x5eed1a7c` — **not by this run** — on identical symbol pixels across four layouts. `crop` is what this bench measured before SB-2; `frame` is what it measures now and what the app decodes; `roi` and `roi_tall` are two crops the app could apply to that frame.

| Layout | What it is | Overall | Mean decode |
|---|---|---:|---:|
| `crop` | the tight crop — the pre-SB-2 bench, an image the app never sees | 571/840 (68.0%) | 14.3 ms |
| `frame` | 1920x1080, symbol unscaled and centred — **what the app decodes** | 535/840 (63.7%) | 40.0 ms |
| `roi` | that frame cropped to §6.1's guide box **as drawn**, 90% x 22% = 1728x238 | 392/840 (46.7%) | - |
| `roi_tall` | that frame cropped to a taller band, 90% x 40% = 1728x432 | 547/840 (65.1%) | 29.0 ms |

**Do not crop to the guide box as drawn.** §6.1's box is `h-[22%] w-[90%]` (`CameraView.tsx:92`); at 1080 px tall that is a 238 px band, and a label-realistic Data Matrix or QR is ~480-500 px tall. Cropping to it takes `data_matrix` clean from 100% to **0%** and `qr_code` clean from 95% to **0%** — it does not degrade 2D, it deletes it. The taller 90% x 40% band is the one that helps: `code_128` severe 27.5% -> 40.0% (+12.5 pp), `code_39_i` severe 30.0% -> 40.0% (+10.0), `code_39` severe 37.5% -> 40.0%, 2D fully restored, and mean decode time 40.0 ms -> 29.0 ms (-27%). **Those 1D severe cells are 40 frames each and are superseded by the 200-frame measurement below (SB-10); the 2D result is not.**

So an ROI crop buys back about a third of what the frame costs — it does not reach the tight crop's 68.0%, and no ROI band turns a failing §13.6 cell into a passing one. It is a `useScanner` change (SB-3) and it is a fixer's to make, not the bench's; the bench measures it and stops there. Separately, and independently of any of this: §6.1 draws a box telling the field user where to put the label and nothing downstream uses it.

### What ROI risks — the part that is not a decode rate (SB-10)

**An ROI crop does not decode better. It makes _different frames_ decode.** It raises a rate by turning frames that currently read as nothing into frames that read as something — and a marginal Code 128 frame is precisely where both of this slice's known checksum collisions were found. R4-F and SB-1 are mod-103-valid misreads, which Code 128's own check cannot catch, and the zero-false-accept headline at the top of this report holds on the `frame` layout **because** those two frames read as nothing on it. That is measured every run, in the replay table under the headline.

Recorded, not taken by this run — `bun run bench/frame-probe.ts --count 200 --symbologies code_39,code_39_i,code_128,code_128_fnc1 --tiers severe` at seed `0x5eed1a7c`, the four 1D severe rows, 800 frames per layout:

| Layout | Correct | False accepts | Frames dark on `frame` that this layout decodes |
|---|---:|---:|---|
| `frame` (the app) | 157/800 (19.6%) | 0 | - |
| `roi` (guide box as drawn) | 187/800 (23.4%) | 0 | 33 |
| `roi_tall` (90% x 40%) | 187/800 (23.4%) | 0 | 33 — 31 correct, **0 wrong VIN**, 2 decoded without naming a VIN, 0 frames lost |

Three things follow, and the third is the one that matters.

1. **The gain is smaller than SB-3 recorded.** At 200 VINs, `roi_tall` moves `code_128` severe 25.0% -> 31.0% (+6.0 pp), `code_39` 30.0% -> 34.0%, `code_39_i` 23.5% -> 28.5%, and leaves `code_128_fnc1` at 0.0%. SB-3's +12.5 pp on `code_128` severe was a 40-VIN cell, which is a ±15 pp measurement — see *What a cell is worth*. ROI is still worth having; it is worth about half of what the ledger row claims. The -27% decode time is the drawn box's, not the tall band's: in the same 200-VIN run, on the same machine under the same load, `frame` cost 141.2 ms, `roi` 103.7 ms (-27%) and `roi_tall` 131.1 ms (-7%).

2. **On 1D rows the two bands are the same measurement.** `roi` and `roi_tall` decode identically here, because a severe 1D symbol fits inside the 238 px drawn box. SB-3's difference between them is entirely 2D, where the drawn box deletes the symbol outright. A fixer testing an ROI crop on Code 39 alone will not see the failure mode that matters.

3. **Zero false accepts in the recovered population is not the reassurance it looks like.** 33 recovered frames, against a phenomenon this bench has measured at 2 in 21,000 attempts, is roughly 300x too small a sample to contain one; the rule of three puts the 95% upper bound on the recovered-frame rate at 3/33, about 9%. The measurement cannot see the thing ROI risks.

**Therefore: implementing ROI (SB-3) requires re-taking the five-seed sweep before this report's false-accept headline may be believed.** `bun run bench/run.ts --seed <s> --paths canvas` at `0x5eed1a7c`, `0x11111111`, `0x2bad5eed`, `0x7f3ac91d`, `0xdecafbad`, 200 VINs each — the same 21,000 attempts the headline quotes. The headline is a count over the frames the current layout decodes; ROI changes which frames those are, so afterwards it is a count about a different population and the old one says nothing. A decode rate that goes up while the false-accept count goes unmeasured is not an improvement, it is an unmeasured trade — and §13.3 grades the losing side of that trade S1.

## The leading FNC1, and what §4.6's strip is worth (SB-8)

This run's corpus produced **0** reads carrying the §4.6 AIM identifier, because no row in it opens with FNC1. That is not the strip passing a test; it is the strip never being asked. §13.7's R5 list keeps the *frequency* question — do the fleet's labels carry this shape — as §7 item 4, and it is the cost question that a bench can answer.

**Quoted, not measured by this run (SB-11).** `bun run bench/fnc1-probe.ts --count 60 --seed 0x5eed1a7c --tiers clean,moderate,severe --layouts frame,crop`, 60 VINs, decode path `canvas`, §4.6 hints TRY_HARDER, ASSUME_GS1, at build `9eaa432` (dirty tree). **3 commits have touched `src/lib/vin` or `src/features/scan` since — re-take it with `bun run bench/fnc1-probe.ts --count 60 --seed 0x5eed1a7c --tiers clean,moderate,severe --layouts frame,crop`.**

On the layout the app decodes (`frame`, SB-2). `shipped` is `extractVin` over the bytes the app sees, `]C1` already removed; `unstripped` is the same bytes with the identifier put back — §4.2 as it was before `stripAimIdentifier` existed.

| Row | Tier | Decoded | `]C1` seen | shipped | unstripped |
|---|---|---:|---:|---:|---:|
| code_128 | clean | 100.0% | 0 | 100.0% | 100.0% |
| code_128 | moderate | 78.3% | 0 | 78.3% | 78.3% |
| code_128 | severe | 33.3% | 0 | 31.7% | 31.7% |
| code_128_fnc1 | clean | 100.0% | 0 | 100.0% | 100.0% |
| code_128_fnc1 | moderate | 75.0% | 0 | 75.0% | 75.0% |
| code_128_fnc1 | severe | 0.0% | 0 | 0.0% | 0.0% |
| code_128_fnc1_lead | clean | 100.0% | 60 | 100.0% | 0.0% |
| code_128_fnc1_lead | moderate | 81.7% | 49 | 81.7% | 0.0% |
| code_128_fnc1_lead | severe | 35.0% | 21 | 35.0% | 0.0% |
| code_128_fnc1_lead2 | clean | 100.0% | 60 | 100.0% | 0.0% |
| code_128_fnc1_lead2 | moderate | 85.0% | 51 | 85.0% | 0.0% |
| code_128_fnc1_lead2 | severe | 1.7% | 1 | 0.0% | 0.0% |

**The strip is the whole difference.** On the 2 leading-FNC1 rows, 242 of 360 frames decoded and `]C1` was present on 242 of those reads; §4.2 named the right VIN on 241 of 360 with the strip and 0 without it. Zero without it, at every tier: `]C1` fuses `C1` onto the front of the first field, §4.2 sees a 19-character run and refuses it, so the cost of not stripping is total rather than partial.

Against the plain Code 128 control on the same frames — 126/180 (70.0%) versus the lead rows' 241/360 (66.9%) — a leading-FNC1 label with the strip in place is neither better nor worse than an ordinary one. §4.6's guard closes the whole gap it was added for.

**0 false accepts, on either scoring.** The strip recovers reads without inventing any: every frame it rescued produced the VIN that was printed on it, and the unstripped scoring produced no wrong VIN either — its failures are all refusals.

On `crop` — the symbol alone, which the app never sees — the same rows read 261/360 shipped against 241/360 on `frame`. The SB-8 ledger row's percentages were taken on that layout, before this probe composited the frame; the frame is the number that describes the product.

A leading-FNC1 read, verbatim, after the strip: `1HGCM82633A004352`.

What this cannot say is how many real labels open with FNC1. That is §13.7's R5 question (b) and it stays §7 item 4: one photographed door-jamb label settles it.

## Decode time

| Scope | Decodes | Mean ms | p95 ms |
|---|---:|---:|---:|
| canvas: all | 4200 | 122.8 | 412.7 |
| canvas: clean | 1400 | 29.3 | 60.0 |
| canvas: moderate | 1400 | 85.6 | 426.9 |
| canvas: severe | 1400 | 253.6 | 433.0 |
| yuv: all | 4200 | 117.8 | 392.6 |
| yuv: clean | 1400 | 24.6 | 46.2 |
| yuv: moderate | 1400 | 82.0 | 395.5 |
| yuv: severe | 1400 | 246.7 | 418.8 |
| rgb: all | 4200 | 39.7 | 75.9 |
| rgb: clean | 1400 | 27.8 | 39.4 |
| rgb: moderate | 1400 | 36.5 | 80.1 |
| rgb: severe | 1400 | 54.8 | 75.5 |

Times cover the ZXing read only — binarisation and the decode — and exclude getting the frame onto the canvas, because the app never parses a PNG either: it draws a video frame it already has. Timings are the one part of this report that is not bit-reproducible; no threshold rides on them. This run measures one frame at a time, so §13.4's mean **time-to-confirm** is not one of these numbers: it is two agreeing reads inside §6.3's window, which run (b) exercises — the section below (SB-5).

## Time to confirm (§13.4 run b, SB-5)

**Quoted, not measured by this run (SB-11).** Confirmation is a property of a stream, not of a frame: §6.3 confirms on two agreeing reads inside 1500 ms, so the number below comes from run (b) — the built app, Chromium's fake capture device, a fresh browser context per repeat so the 10 s cooldown is not what gets timed, and the clock running from the first frame the `<video>` can supply to the hash change only the `confirmed` transition performs.

| | |
|---|---|
| Taken by | `bun run bench/confirm-probe.ts --repeats 8 --symbologies code_39_i,code_128 --tiers clean,moderate,severe` |
| Build measured | `88306a7` |
| Scene | VIN `1HGCM82633A004352`, 12 distinct degraded poses at 10 fps, 1920x1080, 8 contexts per cell, giving up at 25000 ms |
| Machine | 4 cores, load 0.6 / 2.3 / 3.4 at recording — milliseconds here are wall clock on a shared box, and only the comparison between cells is load-free |
| Still current? | no commit has touched `src/` since that build |

| Symbology | Tier | Confirmed | Mean ms | Min ms | Max ms | Harness faults |
|---|---|---:|---:|---:|---:|---:|
| code_39_i | clean | 8/8 | 271 | 261 | 276 | 0 |
| code_39_i | moderate | 8/8 | 1149 | 1112 | 1237 | 0 |
| code_39_i | severe | 8/8 | 1429 | 1047 | 1558 | 0 |
| code_128 | clean | 8/8 | 272 | 265 | 293 | 0 |
| code_128 | moderate | 8/8 | 284 | 272 | 354 | 0 |
| code_128 | severe | 8/8 | 1786 | 1007 | 2198 | 0 |

**Overall: 48 of 48 confirmed, mean 865 ms.** No harness faults.

**A mean here is a tail statistic.** The widest cell in this recording is `code_128` severe, 1007-2198 ms over 8 repeats — a 2.2x spread on one scene at one build. Confirmation needs *two* decodable poses inside one window, so on a hard label it waits for a coincidence, and the mean is set by how long that takes. Read these as orders of magnitude; a 20% move between recordings is noise, the same way a 5 pp move in a severe decode cell is (SB-7).

**`code_128` severe sits above §6.3's 1500 ms agreement window** — mean 1786 ms. A candidate that old has lapsed, so confirmation on those labels typically restarts at least once: the user holds the phone still through more than one window. That is the number a confirmation change (§6.3) would be aiming at.

A y4m loop is not a hand (§13.7): fixed frame rate, repeating poses, nobody moving the phone toward the label. This bounds the confirmation logic; it does not close §7 item 4.

## §13.6 verdict

- code_39 moderate: 77.5% < 90.0% (155/200 correct, -12.5 pp)
- code_39 severe: 34.0% < 70.0% (68/200 correct, -36.0 pp)
- code_39_i moderate: 79.0% < 90.0% (158/200 correct, -11.0 pp)
- code_39_i severe: 28.5% < 70.0% (57/200 correct, -41.5 pp)
- code_39_check clean: 24.0% < 99.0% (48/200 correct, -75.0 pp)
- code_39_check moderate: 18.5% < 90.0% (37/200 correct, -71.5 pp)
- code_39_check severe: 8.5% < 70.0% (17/200 correct, -61.5 pp)
- code_128 moderate: 81.0% < 90.0% (162/200 correct, -9.0 pp)
- code_128 severe: 31.0% < 70.0% (62/200 correct, -39.0 pp)
- code_128_fnc1 moderate: 75.5% < 90.0% (151/200 correct, -14.5 pp)
- code_128_fnc1 severe: 0.0% < 70.0% (0/200 correct, -70.0 pp)
- data_matrix severe: 40.0% < 70.0% (80/200 correct, -30.0 pp)
- qr_code clean: 98.5% < 99.0% (197/200 correct, -0.5 pp)
- qr_code severe: 45.5% < 70.0% (91/200 correct, -24.5 pp)

These numbers came out of `canvas` — the app's path — Chromium, `ScanFrameReader.decodeFromCanvas` — §9-S1's ROI band (90% x 40%, SB-3) first and the whole frame after it — `FrameLuminanceSource`, `decodeWithState` — on the 1920x1080 field the app's decoder is handed (SB-2). That is the app's decoder, in the app's engine, on the app's frame geometry; the bench's node path was none of those (B2) and the crop layout was not the last of them. What it still is not is a **camera frame**. The app draws a `<video>` whose pixels came off a sensor through an ISP and YUV 4:2:0; this composites a PNG onto a uniform white field. A real jamb is a darker, textured surround, and a clean white field is the *easier* of the two for a row-histogram binariser, so even these rates are a ceiling and not a floor. `bench/camera-probe.ts` measures the colour step on a subset — the same frames through Chromium's own fake capture device and a real `<video>` — and finds the camera reads slightly *worse*, deterministically. Nothing here models a lens, and nothing here is a label.

Synthetic is not real (§13.4, §13.7). This bench tunes hints, ROI cropping and confirmation logic; real door-jamb labels on real trucks stay §7 item 4, and stay human.
