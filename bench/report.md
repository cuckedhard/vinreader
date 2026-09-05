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
| **Decode path (verdict)** | `canvas` — the app's path — Chromium, `BrowserMultiFormatReader.decodeFromCanvas`, `HTMLCanvasElementLuminanceSource`, `decodeWithState` |
| **Frame (SB-2)** | `frame` — the symbol composited unscaled and centred on a white 1920x1080 field — what `@zxing/browser` draws from the `<video>` (SB-2) |
| Symbol fill | 33.6% of the frame width, mean over 4200 frames |
| Also measured | `yuv` — `canvas`, with the frame first put through a **modelled** BT.601 studio-swing I420 round trip — the colour half of a camera capture, not a camera |
| Also measured | `rgb` — node, `RGBLuminanceSource` + `MultiFormatReader.decode` — the control, not the app |
| Browser pages | 4 |
| Chromium | /opt/pw-browsers/chromium-1194/chrome-linux/chrome |
| Decoder hints (§4.6) | CODE_39, CODE_128, DATA_MATRIX, QR_CODE; TRY_HARDER, ASSUME_GS1 |
| Severe extras (Z5) | 2 of warp, glare, low_light, jpeg, drawn per frame from the seed |
| ZXing per-reader warnings swallowed (`rgb` only) | 8232 |
| Reads carrying the §4.6 AIM identifier | 0 |

Every degradation seed is `runSeed ^ fnv1a("vin|symbology|tier")` — the decode path is deliberately not in the key, so every instrument reads the same pixels. This run reproduces exactly, and any single row below reproduces on its own.

Every rate, miss reason and false accept below is `canvas`'s unless it says otherwise. The instrument delta is its own section.

**These numbers are measured on the frame the app decodes (SB-2), and they are much worse than the ones this report used to carry.** The bench used to hand ZXing a tight crop — a ~1050 px symbol in a ~1100 px image. `useScanner` calls `decodeFromStream`, and `@zxing/browser` draws the whole `<video>` onto its capture canvas at `videoWidth` x `videoHeight`, so under §6.3's `ideal` constraints the decoder gets 1920x1080 with the symbol filling 33.6% of the width and the rest of the field empty. The symbol pixels are byte-identical either way — the degraded image is composited unscaled and centred, never resampled — so the whole difference between the old table and this one is the field around the symbol. Nothing about the corpus, the tiers or the §4.6 hints changed. The old numbers were a measurement of an easier problem than the product solves, and they were optimistic in the direction that matters. `--layout crop` reproduces them, as a diagnostic that cannot write this file.

## Headline: false accepts (§13.6 requires 0)

**0 false accepts** in 4200 attempts on `canvas`. Threshold 0.

## Decode rate per symbology × tier

| Symbology | clean (>= 99.0%) | moderate (>= 90.0%) | severe (>= 70.0%) |
|---|---|---|---|
| code_39 | 100.0% PASS | 77.5% FAIL | 30.0% FAIL |
| code_39_i | 100.0% PASS | 79.0% FAIL | 23.5% FAIL |
| code_39_check | 24.0% FAIL | 18.5% FAIL | 7.0% FAIL |
| code_128 | 100.0% PASS | 80.5% FAIL | 25.0% FAIL |
| code_128_fnc1 | 100.0% PASS | 71.0% FAIL | 0.0% FAIL |
| data_matrix | 100.0% PASS | 99.0% PASS | 37.0% FAIL |
| qr_code | 98.5% FAIL | 98.0% PASS | 43.0% FAIL |

Decode rate is end to end: the fraction of frames that produced the **correct** VIN
through ZXing and §4.2 `extractVin`, not the fraction that merely decoded.

**Tier ordering holds** (§13.4): clean >= moderate >= severe in every cell.

### Detail

| Symbology | Tier | Attempts | Hits | Misses | Errors | False accepts | Rate | Threshold | Margin | Status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| code_39 | clean | 200 | 200 | 0 | 0 | 0 | 100.0% | 99.0% | +1.0 pp | PASS |
| code_39 | moderate | 200 | 155 | 45 | 0 | 0 | 77.5% | 90.0% | -12.5 pp | FAIL |
| code_39 | severe | 200 | 60 | 140 | 0 | 0 | 30.0% | 70.0% | -40.0 pp | FAIL |
| code_39_i | clean | 200 | 200 | 0 | 0 | 0 | 100.0% | 99.0% | +1.0 pp | PASS |
| code_39_i | moderate | 200 | 158 | 42 | 0 | 0 | 79.0% | 90.0% | -11.0 pp | FAIL |
| code_39_i | severe | 200 | 47 | 153 | 0 | 0 | 23.5% | 70.0% | -46.5 pp | FAIL |
| code_39_check | clean | 200 | 48 | 152 | 0 | 0 | 24.0% | 99.0% | -75.0 pp | FAIL |
| code_39_check | moderate | 200 | 37 | 163 | 0 | 0 | 18.5% | 90.0% | -71.5 pp | FAIL |
| code_39_check | severe | 200 | 14 | 186 | 0 | 0 | 7.0% | 70.0% | -63.0 pp | FAIL |
| code_128 | clean | 200 | 200 | 0 | 0 | 0 | 100.0% | 99.0% | +1.0 pp | PASS |
| code_128 | moderate | 200 | 161 | 39 | 0 | 0 | 80.5% | 90.0% | -9.5 pp | FAIL |
| code_128 | severe | 200 | 50 | 150 | 0 | 0 | 25.0% | 70.0% | -45.0 pp | FAIL |
| code_128_fnc1 | clean | 200 | 200 | 0 | 0 | 0 | 100.0% | 99.0% | +1.0 pp | PASS |
| code_128_fnc1 | moderate | 200 | 142 | 58 | 0 | 0 | 71.0% | 90.0% | -19.0 pp | FAIL |
| code_128_fnc1 | severe | 200 | 0 | 200 | 0 | 0 | 0.0% | 70.0% | -70.0 pp | FAIL |
| data_matrix | clean | 200 | 200 | 0 | 0 | 0 | 100.0% | 99.0% | +1.0 pp | PASS |
| data_matrix | moderate | 200 | 198 | 2 | 0 | 0 | 99.0% | 90.0% | +9.0 pp | PASS |
| data_matrix | severe | 200 | 74 | 126 | 0 | 0 | 37.0% | 70.0% | -33.0 pp | FAIL |
| qr_code | clean | 200 | 197 | 3 | 0 | 0 | 98.5% | 99.0% | -0.5 pp | FAIL |
| qr_code | moderate | 200 | 196 | 4 | 0 | 0 | 98.0% | 90.0% | +8.0 pp | PASS |
| qr_code | severe | 200 | 86 | 114 | 0 | 0 | 43.0% | 70.0% | -27.0 pp | FAIL |

### Severe: what each frame drew

| Drawn extras | Frames | code_39 | code_39_i | code_39_check | code_128 | code_128_fnc1 | data_matrix | qr_code |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| glare + jpeg | 234 | 74.2% | 61.3% | 5.3% | 41.2% | 0.0% | 96.4% | 100.0% |
| glare + low_light | 255 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 80.6% |
| low_light + jpeg | 203 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 74.2% |
| warp + glare | 236 | 51.5% | 31.0% | 5.6% | 46.7% | 0.0% | 62.5% | 0.0% |
| warp + jpeg | 229 | 60.6% | 54.3% | 23.8% | 71.0% | 0.0% | 90.0% | 0.0% |
| warp + low_light | 243 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |

§13.4 lists six degradations for `severe`; two of them — 50% scale and heavier grain — are harder settings of degradations `moderate` already applies, so they are on for every frame and the tier stays a strict superset of `moderate` whatever is drawn. The other four are drawn 2 at a time (Z5): all four at once is not one bad photo, it is every bad photo, and it left no cell above 57%.

## Instrument delta (finding B2)

Same corpus, same seed, **same degraded pixels** — the frame is warped once and offered to each instrument. `canvas` is the app's decode path; the columns beside it are what the other instruments made of the identical frames. A positive Δ means the app reads more than the other instrument did.

**Why a column can come out identical, and how to tell that is a result rather than a harness fault.** On a grey frame the two luminance sources reduce to the same bytes: `RGBLuminanceSource` takes the green-favouring average `(r + 2g + b) / 4` and `HTMLCanvasElementLuminanceSource` takes `(306r + 601g + 117b + 512) >> 10`, and at `r = g = b = v` both are exactly `v`. This corpus renders grey. What is left between them is `isRotateSupported()` — true only on the canvas source, so `OneDReader` gets a 90°-rotated retry under `TRY_HARDER`, which cannot help a symbol that is already horizontal — and `decodeWithState` against `decode(bitmap, hints)`, which rebuild the same readers from the same hints. The `yuv` column is the control: it is the one path that moves frames, so a delta table that shows it moving is a table that can see a difference when there is one.

### `canvas` vs `yuv`

`yuv`: `canvas`, with the frame first put through a **modelled** BT.601 studio-swing I420 round trip — the colour half of a camera capture, not a camera.

| Symbology | Tier | canvas | yuv | Δ pp | canvas only | yuv only | both | neither |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| code_39 | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| code_39 | moderate | 77.5% | 77.5% | +0.0 | 0 | 0 | 155 | 45 |
| code_39 | severe | 30.0% | 30.0% | +0.0 | 1 | 1 | 59 | 139 |
| code_39_i | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| code_39_i | moderate | 79.0% | 79.0% | +0.0 | 0 | 0 | 158 | 42 |
| code_39_i | severe | 23.5% | 23.5% | +0.0 | 2 | 2 | 45 | 151 |
| code_39_check | clean | 24.0% | 24.0% | +0.0 | 0 | 0 | 48 | 152 |
| code_39_check | moderate | 18.5% | 18.5% | +0.0 | 0 | 0 | 37 | 163 |
| code_39_check | severe | 7.0% | 7.0% | +0.0 | 0 | 0 | 14 | 186 |
| code_128 | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| code_128 | moderate | 80.5% | 80.5% | +0.0 | 0 | 0 | 161 | 39 |
| code_128 | severe | 25.0% | 24.5% | +0.5 | 1 | 0 | 49 | 150 |
| code_128_fnc1 | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| code_128_fnc1 | moderate | 71.0% | 72.0% | -1.0 | 0 | 2 | 142 | 56 |
| code_128_fnc1 | severe | 0.0% | 0.0% | +0.0 | 0 | 0 | 0 | 200 |
| data_matrix | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| data_matrix | moderate | 99.0% | 99.0% | +0.0 | 0 | 0 | 198 | 2 |
| data_matrix | severe | 37.0% | 37.0% | +0.0 | 0 | 0 | 74 | 126 |
| qr_code | clean | 98.5% | 98.5% | +0.0 | 0 | 0 | 197 | 3 |
| qr_code | moderate | 98.0% | 98.0% | +0.0 | 0 | 0 | 196 | 4 |
| qr_code | severe | 43.0% | 43.5% | -0.5 | 1 | 2 | 85 | 112 |

Over 4200 frames: `canvas` 2623 correct, `yuv` 2625 correct — 5 read only by `canvas`, 7 read only by `yuv`.

### `canvas` vs `rgb`

`rgb`: node, `RGBLuminanceSource` + `MultiFormatReader.decode` — the control, not the app.

| Symbology | Tier | canvas | rgb | Δ pp | canvas only | rgb only | both | neither |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| code_39 | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| code_39 | moderate | 77.5% | 77.5% | +0.0 | 0 | 0 | 155 | 45 |
| code_39 | severe | 30.0% | 30.0% | +0.0 | 0 | 0 | 60 | 140 |
| code_39_i | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| code_39_i | moderate | 79.0% | 79.0% | +0.0 | 0 | 0 | 158 | 42 |
| code_39_i | severe | 23.5% | 23.5% | +0.0 | 0 | 0 | 47 | 153 |
| code_39_check | clean | 24.0% | 24.0% | +0.0 | 0 | 0 | 48 | 152 |
| code_39_check | moderate | 18.5% | 18.5% | +0.0 | 0 | 0 | 37 | 163 |
| code_39_check | severe | 7.0% | 7.0% | +0.0 | 0 | 0 | 14 | 186 |
| code_128 | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| code_128 | moderate | 80.5% | 80.5% | +0.0 | 0 | 0 | 161 | 39 |
| code_128 | severe | 25.0% | 25.0% | +0.0 | 0 | 0 | 50 | 150 |
| code_128_fnc1 | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| code_128_fnc1 | moderate | 71.0% | 71.0% | +0.0 | 0 | 0 | 142 | 58 |
| code_128_fnc1 | severe | 0.0% | 0.0% | +0.0 | 0 | 0 | 0 | 200 |
| data_matrix | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| data_matrix | moderate | 99.0% | 99.0% | +0.0 | 0 | 0 | 198 | 2 |
| data_matrix | severe | 37.0% | 37.0% | +0.0 | 0 | 0 | 74 | 126 |
| qr_code | clean | 98.5% | 98.5% | +0.0 | 0 | 0 | 197 | 3 |
| qr_code | moderate | 98.0% | 98.0% | +0.0 | 0 | 0 | 196 | 4 |
| qr_code | severe | 43.0% | 43.0% | +0.0 | 0 | 0 | 86 | 114 |

Over 4200 frames: `canvas` 2623 correct, `rgb` 2623 correct — 0 read only by `canvas`, 0 read only by `rgb`.

### The 19 frames that read differently

| Path | VIN | Symbology | Tier | Drawn extras | app | other | Seed |
|---|---|---|---|---|---|---|---|
| yuv | `XU0XKN2C8N93SLYFA` | code_39 | severe | glare + jpeg | hit `XU0XKN2C8N93SLYFA` | miss (no decode) | `0x5254edc9` |
| yuv | `0W4B348U890HX2JC1` | code_39 | severe | warp + jpeg | miss (no decode) | hit `0W4B348U890HX2JC1` | `0xf1e22a9b` |
| yuv | `J5XW697S5ZPFJL4RA` | code_39_i | severe | glare + jpeg | hit `IJ5XW697S5ZPFJL4RA` | miss (no decode) | `0xdfc8e604` |
| yuv | `L9TV9RC15W5ABHG1U` | code_39_i | severe | warp + jpeg | miss (no decode) | hit `IL9TV9RC15W5ABHG1U` | `0x24f81328` |
| yuv | `MYTVHJ2823YBUYKE0` | code_39_i | severe | warp + jpeg | miss (no decode) | hit `IMYTVHJ2823YBUYKE0` | `0xfbafea79` |
| yuv | `4LY6BDTG2RPG54RKP` | code_39_i | severe | glare + jpeg | hit `I4LY6BDTG2RPG54RKP` | miss (no decode) | `0x8bcc2e44` |
| yuv | `DNUDA92B2W9V0SN9G` | code_39_check | severe | warp + jpeg | miss (no decode) | miss `DNUDA92B2W9V0SN9G3` | `0xaf7adea0` |
| yuv | `YW7Y7WHY16E85C9HE` | code_39_check | severe | warp + jpeg | miss (no decode) | miss `YW7Y7WHY16E85C9HEP` | `0x67e16e39` |
| yuv | `40WF0NRH3TRUXSNF2` | code_39_check | severe | glare + jpeg | miss `40WF0NRH3TRUXSNF27` | miss (no decode) | `0x55513946` |
| yuv | `JG1HZGN1XCZMJTYAN` | code_39_check | severe | warp + glare | miss `JG1HZGN1XCZMJTYAN1` | miss (no decode) | `0x9a40579c` |
| yuv | `ZNCNNV4N0XSW7LSGF` | code_39_check | severe | warp + glare | miss `ZNCNNV4N0XSW7LSGFA` | miss (no decode) | `0x91afa7f4` |
| yuv | `HC1G7NUM1NCCFZJTZ` | code_39_check | severe | warp + glare | miss (no decode) | miss `HC1G7NUM1NCCFZJTZ8` | `0xb053d5c1` |
| yuv | `EDAE3UP78M3612D3E` | code_39_check | severe | glare + jpeg | miss `EDAE3UP78M3612D3EG` | miss (no decode) | `0xca5dbded` |
| yuv | `74J7N9M86K6S0AUTE` | code_128 | severe | glare + jpeg | hit `74J7N9M86K6S0AUTE` | miss (no decode) | `0x10ae87ff` |
| yuv | `6LTYUHPR0V8E05RZX` | code_128_fnc1 | moderate | - | miss (no decode) | hit `6LTYUHPR0V8E05RZX1P84203911` | `0x155ba210` |
| yuv | `EH8U2YHX60HU8VGWD` | code_128_fnc1 | moderate | - | miss `!H8U2Y!X60HU8VGWD1P84203911` | hit `EH8U2YHX60HU8VGWD1P84203911` | `0x145f60e` |
| yuv | `B33ZSLFN0H2NHWFEE` | qr_code | severe | glare + low_light | miss (no decode) | hit `B33ZSLFN0H2NHWFEE` | `0x581c3172` |
| yuv | `CKSP99BH62U3XH21L` | qr_code | severe | low_light + jpeg | miss (no decode) | hit `CKSP99BH62U3XH21L` | `0x3ba6997a` |
| yuv | `L6E30VGM0F2A6YULH` | qr_code | severe | glare + low_light | hit `L6E30VGM0F2A6YULH` | miss (no decode) | `0xeb9e3db1` |

### Why the misses missed

| Symbology | Tier | no_decode | no_vin | carrier |
|---|---|---:|---:|---:|
| code_39 | clean | 0 | 0 | 0 |
| code_39 | moderate | 45 | 0 | 0 |
| code_39 | severe | 140 | 0 | 0 |
| code_39_i | clean | 0 | 0 | 0 |
| code_39_i | moderate | 42 | 0 | 0 |
| code_39_i | severe | 153 | 0 | 0 |
| code_39_check | clean | 0 | 152 | 0 |
| code_39_check | moderate | 49 | 114 | 0 |
| code_39_check | severe | 138 | 48 | 0 |
| code_128 | clean | 0 | 0 | 0 |
| code_128 | moderate | 39 | 0 | 0 |
| code_128 | severe | 150 | 0 | 0 |
| code_128_fnc1 | clean | 0 | 0 | 0 |
| code_128_fnc1 | moderate | 57 | 1 | 0 |
| code_128_fnc1 | severe | 200 | 0 | 0 |
| data_matrix | clean | 0 | 0 | 0 |
| data_matrix | moderate | 2 | 0 | 0 |
| data_matrix | severe | 126 | 0 | 0 |
| qr_code | clean | 3 | 0 | 0 |
| qr_code | moderate | 4 | 0 | 0 |
| qr_code | severe | 114 | 0 | 0 |

`no_decode` — ZXing found no symbol. `no_vin` — text decoded but §4.2 named no VIN. `carrier` — a §4.9 handoff payload, which §6.3 never extracts; nothing in this corpus is one, so any non-zero value here is itself a finding.

## The frame, and the ROI crop somebody is about to write (SB-2 / SB-3)

Measured by `bun run bench/frame-probe.ts --count 40` at seed `0x5eed1a7c` — **not by this run** — on identical symbol pixels across four layouts. `crop` is what this bench measured before SB-2; `frame` is what it measures now and what the app decodes; `roi` and `roi_tall` are two crops the app could apply to that frame.

| Layout | What it is | Overall | Mean decode |
|---|---|---:|---:|
| `crop` | the tight crop — the pre-SB-2 bench, an image the app never sees | 571/840 (68.0%) | 14.3 ms |
| `frame` | 1920x1080, symbol unscaled and centred — **what the app decodes** | 535/840 (63.7%) | 40.0 ms |
| `roi` | that frame cropped to §6.1's guide box **as drawn**, 90% x 22% = 1728x238 | 392/840 (46.7%) | - |
| `roi_tall` | that frame cropped to a taller band, 90% x 40% = 1728x432 | 547/840 (65.1%) | 29.0 ms |

**Do not crop to the guide box as drawn.** §6.1's box is `h-[22%] w-[90%]` (`CameraView.tsx:92`); at 1080 px tall that is a 238 px band, and a label-realistic Data Matrix or QR is ~480-500 px tall. Cropping to it takes `data_matrix` clean from 100% to **0%** and `qr_code` clean from 95% to **0%** — it does not degrade 2D, it deletes it. The taller 90% x 40% band is the one that helps: `code_128` severe 27.5% -> 40.0% (+12.5 pp), `code_39_i` severe 30.0% -> 40.0% (+10.0), `code_39` severe 37.5% -> 40.0%, 2D fully restored, and mean decode time 40.0 ms -> 29.0 ms (-27%).

So an ROI crop buys back about a third of what the frame costs — it does not reach the tight crop's 68.0%, and no ROI band turns a failing §13.6 cell into a passing one. It is a `useScanner` change (SB-3) and it is a fixer's to make, not the bench's; the bench measures it and stops there. Separately, and independently of any of this: §6.1 draws a box telling the field user where to put the label and nothing downstream uses it.

## Decode time

| Scope | Decodes | Mean ms | p95 ms |
|---|---:|---:|---:|
| canvas: all | 4200 | 46.6 | 98.6 |
| canvas: clean | 1400 | 35.7 | 74.5 |
| canvas: moderate | 1400 | 41.3 | 93.3 |
| canvas: severe | 1400 | 63.0 | 111.4 |
| yuv: all | 4200 | 45.1 | 95.0 |
| yuv: clean | 1400 | 32.1 | 58.6 |
| yuv: moderate | 1400 | 40.6 | 88.5 |
| yuv: severe | 1400 | 62.8 | 113.7 |
| rgb: all | 4200 | 20.6 | 41.5 |
| rgb: clean | 1400 | 13.6 | 18.5 |
| rgb: moderate | 1400 | 18.8 | 44.3 |
| rgb: severe | 1400 | 29.4 | 42.0 |

Times cover the ZXing read only — binarisation and the decode — and exclude getting the frame onto the canvas, because the app never parses a PNG either: it draws a video frame it already has. Timings are the one part of this report that is not bit-reproducible; no threshold rides on them. §13.4's mean **time-to-confirm** is not here: confirmation is two agreeing reads inside §6.3's window, which run (b) — the Playwright fake-camera pass — is what exercises. This run measures one frame at a time.

## §13.6 verdict

- code_39 moderate: 77.5% < 90.0% (155/200 correct, -12.5 pp)
- code_39 severe: 30.0% < 70.0% (60/200 correct, -40.0 pp)
- code_39_i moderate: 79.0% < 90.0% (158/200 correct, -11.0 pp)
- code_39_i severe: 23.5% < 70.0% (47/200 correct, -46.5 pp)
- code_39_check clean: 24.0% < 99.0% (48/200 correct, -75.0 pp)
- code_39_check moderate: 18.5% < 90.0% (37/200 correct, -71.5 pp)
- code_39_check severe: 7.0% < 70.0% (14/200 correct, -63.0 pp)
- code_128 moderate: 80.5% < 90.0% (161/200 correct, -9.5 pp)
- code_128 severe: 25.0% < 70.0% (50/200 correct, -45.0 pp)
- code_128_fnc1 moderate: 71.0% < 90.0% (142/200 correct, -19.0 pp)
- code_128_fnc1 severe: 0.0% < 70.0% (0/200 correct, -70.0 pp)
- data_matrix severe: 37.0% < 70.0% (74/200 correct, -33.0 pp)
- qr_code clean: 98.5% < 99.0% (197/200 correct, -0.5 pp)
- qr_code severe: 43.0% < 70.0% (86/200 correct, -27.0 pp)

These numbers came out of `canvas` — the app's path — Chromium, `BrowserMultiFormatReader.decodeFromCanvas`, `HTMLCanvasElementLuminanceSource`, `decodeWithState` — on the 1920x1080 field the app's decoder is handed (SB-2). That is the app's decoder, in the app's engine, on the app's frame geometry; the bench's node path was none of those (B2) and the crop layout was not the last of them. What it still is not is a **camera frame**. The app draws a `<video>` whose pixels came off a sensor through an ISP and YUV 4:2:0; this composites a PNG onto a uniform white field. A real jamb is a darker, textured surround, and a clean white field is the *easier* of the two for a row-histogram binariser, so even these rates are a ceiling and not a floor. `bench/camera-probe.ts` measures the colour step on a subset — the same frames through Chromium's own fake capture device and a real `<video>` — and finds the camera reads slightly *worse*, deterministically. Nothing here models a lens, and nothing here is a label.

Synthetic is not real (§13.4, §13.7). This bench tunes hints, ROI cropping and confirmation logic; real door-jamb labels on real trucks stay §7 item 4, and stay human.
