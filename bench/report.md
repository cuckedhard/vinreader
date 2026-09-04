# §13.4 scan-robustness bench

**FAIL** — 16 §13.6 thresholds missed.

## Run

| | |
|---|---|
| Run seed | `0x5eed1a7c` |
| VINs | 200 (full) |
| Symbologies | code_39, code_39_i, code_39_check, code_128, code_128_fnc1, data_matrix, qr_code |
| Tiers | clean, moderate, severe |
| Attempts | 12600 (4200 per path) |
| **Decode path (verdict)** | `canvas` — the app's path — Chromium, `BrowserMultiFormatReader.decodeFromCanvas`, `HTMLCanvasElementLuminanceSource`, `decodeWithState` |
| Also measured | `yuv` — `canvas`, with the frame first put through a **modelled** BT.601 studio-swing I420 round trip — the colour half of a camera capture, not a camera |
| Also measured | `rgb` — node, `RGBLuminanceSource` + `MultiFormatReader.decode` — the control, not the app |
| Browser pages | 4 |
| Chromium | /opt/pw-browsers/chromium-1194/chrome-linux/chrome |
| Decoder hints (§4.6) | CODE_39, CODE_128, DATA_MATRIX, QR_CODE; TRY_HARDER, ASSUME_GS1 |
| Severe extras (Z5) | 2 of warp, glare, low_light, jpeg, drawn per frame from the seed |
| ZXing per-reader warnings swallowed (`rgb` only) | 7934 |
| Reads carrying the §4.6 AIM identifier | 0 |

Every degradation seed is `runSeed ^ fnv1a("vin|symbology|tier")` — the decode path is deliberately not in the key, so every instrument reads the same pixels. This run reproduces exactly, and any single row below reproduces on its own.

Every rate, miss reason and false accept below is `canvas`'s unless it says otherwise. The instrument delta is its own section.

## Headline: false accepts (§13.6 requires 0)

**1 FALSE ACCEPT** in 4200 attempts on `canvas` (threshold 0). A wrong VIN accepted is an S1 blocker (§13.3).

| Expected VIN | Returned VIN | Symbology | Tier | Drawn extras | ZXing format | Check digit | Decoded text | Seed |
|---|---|---|---|---|---|---|---|---|
| `EH8U2YHX60HU8VGWD` | `EH8U2YHX60HU7VAWD` | code_128 | severe | low_light + jpeg | CODE_128 | invalid | `EH8U2YHX60HU7VAWD` | `0xc5d3691c` |

Reproduce:

```ts
degrade(await renderBarcode("EH8U2YHX60HU8VGWD", "code_128"), "severe", 0xc5d3691c)
```

Off the app's path, 2 further false accepts — a wrong VIN a *different* ZXing plumbing produced from the same frames. Not counted against §13.6, which is about the program that ships, and listed here because a bench that hid one would be the B2 defect again:

| Path | Expected VIN | Returned VIN | Symbology | Tier | Decoded text | Seed |
|---|---|---|---|---|---|---|
| yuv | `EH8U2YHX60HU8VGWD` | `EH8U2YHX60HU7VAWD` | code_128 | severe | `EH8U2YHX60HU7VAWD` | `0xc5d3691c` |
| rgb | `EH8U2YHX60HU8VGWD` | `EH8U2YHX60HU7VAWD` | code_128 | severe | `EH8U2YHX60HU7VAWD` | `0xc5d3691c` |

## Decode rate per symbology × tier

| Symbology | clean (>= 99.0%) | moderate (>= 90.0%) | severe (>= 70.0%) |
|---|---|---|---|
| code_39 | 100.0% PASS | 77.5% FAIL | 51.0% FAIL |
| code_39_i | 100.0% PASS | 79.0% FAIL | 45.5% FAIL |
| code_39_check | 24.0% FAIL | 18.5% FAIL | 12.5% FAIL |
| code_128 | 100.0% PASS | 81.0% FAIL | 59.0% FAIL |
| code_128_fnc1 | 100.0% PASS | 77.5% FAIL | 0.5% FAIL |
| data_matrix | 100.0% PASS | 99.0% PASS | 55.0% FAIL |
| qr_code | 98.5% FAIL | 97.5% PASS | 43.5% FAIL |

Decode rate is end to end: the fraction of frames that produced the **correct** VIN
through ZXing and §4.2 `extractVin`, not the fraction that merely decoded.

**Tier ordering holds** (§13.4): clean >= moderate >= severe in every cell.

### Detail

| Symbology | Tier | Attempts | Hits | Misses | Errors | False accepts | Rate | Threshold | Margin | Status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| code_39 | clean | 200 | 200 | 0 | 0 | 0 | 100.0% | 99.0% | +1.0 pp | PASS |
| code_39 | moderate | 200 | 155 | 45 | 0 | 0 | 77.5% | 90.0% | -12.5 pp | FAIL |
| code_39 | severe | 200 | 102 | 98 | 0 | 0 | 51.0% | 70.0% | -19.0 pp | FAIL |
| code_39_i | clean | 200 | 200 | 0 | 0 | 0 | 100.0% | 99.0% | +1.0 pp | PASS |
| code_39_i | moderate | 200 | 158 | 42 | 0 | 0 | 79.0% | 90.0% | -11.0 pp | FAIL |
| code_39_i | severe | 200 | 91 | 109 | 0 | 0 | 45.5% | 70.0% | -24.5 pp | FAIL |
| code_39_check | clean | 200 | 48 | 152 | 0 | 0 | 24.0% | 99.0% | -75.0 pp | FAIL |
| code_39_check | moderate | 200 | 37 | 163 | 0 | 0 | 18.5% | 90.0% | -71.5 pp | FAIL |
| code_39_check | severe | 200 | 25 | 175 | 0 | 0 | 12.5% | 70.0% | -57.5 pp | FAIL |
| code_128 | clean | 200 | 200 | 0 | 0 | 0 | 100.0% | 99.0% | +1.0 pp | PASS |
| code_128 | moderate | 200 | 162 | 38 | 0 | 0 | 81.0% | 90.0% | -9.0 pp | FAIL |
| code_128 | severe | 200 | 118 | 81 | 0 | 1 | 59.0% | 70.0% | -11.0 pp | FAIL |
| code_128_fnc1 | clean | 200 | 200 | 0 | 0 | 0 | 100.0% | 99.0% | +1.0 pp | PASS |
| code_128_fnc1 | moderate | 200 | 155 | 45 | 0 | 0 | 77.5% | 90.0% | -12.5 pp | FAIL |
| code_128_fnc1 | severe | 200 | 1 | 199 | 0 | 0 | 0.5% | 70.0% | -69.5 pp | FAIL |
| data_matrix | clean | 200 | 200 | 0 | 0 | 0 | 100.0% | 99.0% | +1.0 pp | PASS |
| data_matrix | moderate | 200 | 198 | 2 | 0 | 0 | 99.0% | 90.0% | +9.0 pp | PASS |
| data_matrix | severe | 200 | 110 | 90 | 0 | 0 | 55.0% | 70.0% | -15.0 pp | FAIL |
| qr_code | clean | 200 | 197 | 3 | 0 | 0 | 98.5% | 99.0% | -0.5 pp | FAIL |
| qr_code | moderate | 200 | 195 | 5 | 0 | 0 | 97.5% | 90.0% | +7.5 pp | PASS |
| qr_code | severe | 200 | 87 | 113 | 0 | 0 | 43.5% | 70.0% | -26.5 pp | FAIL |

### Severe: what each frame drew

| Drawn extras | Frames | code_39 | code_39_i | code_39_check | code_128 | code_128_fnc1 | data_matrix | qr_code |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| glare + jpeg | 234 | 74.2% | 64.5% | 10.5% | 61.8% | 0.0% | 89.3% | 97.1% |
| glare + low_light | 255 | 9.4% | 7.3% | 2.9% | 10.0% | 0.0% | 7.3% | 63.9% |
| low_light + jpeg | 203 | 57.6% | 72.7% | 11.1% | 86.7% | 0.0% | 96.9% | 100.0% |
| warp + glare | 236 | 60.6% | 44.8% | 8.3% | 63.3% | 0.0% | 75.0% | 0.0% |
| warp + jpeg | 229 | 72.7% | 57.1% | 26.2% | 74.2% | 3.2% | 86.7% | 0.0% |
| warp + low_light | 243 | 34.2% | 35.5% | 12.5% | 71.4% | 0.0% | 2.7% | 0.0% |

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
| code_39 | severe | 51.0% | 50.5% | +0.5 | 5 | 4 | 97 | 94 |
| code_39_i | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| code_39_i | moderate | 79.0% | 79.0% | +0.0 | 0 | 0 | 158 | 42 |
| code_39_i | severe | 45.5% | 46.0% | -0.5 | 3 | 4 | 88 | 105 |
| code_39_check | clean | 24.0% | 24.0% | +0.0 | 0 | 0 | 48 | 152 |
| code_39_check | moderate | 18.5% | 18.5% | +0.0 | 0 | 0 | 37 | 163 |
| code_39_check | severe | 12.5% | 12.0% | +0.5 | 2 | 1 | 23 | 174 |
| code_128 | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| code_128 | moderate | 81.0% | 81.0% | +0.0 | 0 | 0 | 162 | 38 |
| code_128 | severe | 59.0% | 57.5% | +1.5 | 3 | 0 | 115 | 82 |
| code_128_fnc1 | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| code_128_fnc1 | moderate | 77.5% | 77.5% | +0.0 | 1 | 1 | 154 | 44 |
| code_128_fnc1 | severe | 0.5% | 0.5% | +0.0 | 0 | 0 | 1 | 199 |
| data_matrix | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| data_matrix | moderate | 99.0% | 99.0% | +0.0 | 0 | 0 | 198 | 2 |
| data_matrix | severe | 55.0% | 55.5% | -0.5 | 0 | 1 | 110 | 89 |
| qr_code | clean | 98.5% | 98.5% | +0.0 | 0 | 0 | 197 | 3 |
| qr_code | moderate | 97.5% | 98.0% | -0.5 | 0 | 1 | 195 | 4 |
| qr_code | severe | 43.5% | 44.0% | -0.5 | 1 | 2 | 86 | 111 |

Over 4200 frames: `canvas` 2839 correct, `yuv` 2838 correct — 15 read only by `canvas`, 14 read only by `yuv`.

### `canvas` vs `rgb`

`rgb`: node, `RGBLuminanceSource` + `MultiFormatReader.decode` — the control, not the app.

| Symbology | Tier | canvas | rgb | Δ pp | canvas only | rgb only | both | neither |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| code_39 | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| code_39 | moderate | 77.5% | 77.5% | +0.0 | 0 | 0 | 155 | 45 |
| code_39 | severe | 51.0% | 51.0% | +0.0 | 0 | 0 | 102 | 98 |
| code_39_i | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| code_39_i | moderate | 79.0% | 79.0% | +0.0 | 0 | 0 | 158 | 42 |
| code_39_i | severe | 45.5% | 45.5% | +0.0 | 0 | 0 | 91 | 109 |
| code_39_check | clean | 24.0% | 24.0% | +0.0 | 0 | 0 | 48 | 152 |
| code_39_check | moderate | 18.5% | 18.5% | +0.0 | 0 | 0 | 37 | 163 |
| code_39_check | severe | 12.5% | 12.5% | +0.0 | 0 | 0 | 25 | 175 |
| code_128 | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| code_128 | moderate | 81.0% | 81.0% | +0.0 | 0 | 0 | 162 | 38 |
| code_128 | severe | 59.0% | 59.0% | +0.0 | 0 | 0 | 118 | 82 |
| code_128_fnc1 | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| code_128_fnc1 | moderate | 77.5% | 77.5% | +0.0 | 0 | 0 | 155 | 45 |
| code_128_fnc1 | severe | 0.5% | 0.5% | +0.0 | 0 | 0 | 1 | 199 |
| data_matrix | clean | 100.0% | 100.0% | +0.0 | 0 | 0 | 200 | 0 |
| data_matrix | moderate | 99.0% | 99.0% | +0.0 | 0 | 0 | 198 | 2 |
| data_matrix | severe | 55.0% | 55.0% | +0.0 | 0 | 0 | 110 | 90 |
| qr_code | clean | 98.5% | 98.5% | +0.0 | 0 | 0 | 197 | 3 |
| qr_code | moderate | 97.5% | 97.5% | +0.0 | 0 | 0 | 195 | 5 |
| qr_code | severe | 43.5% | 43.5% | +0.0 | 0 | 0 | 87 | 113 |

Over 4200 frames: `canvas` 2839 correct, `rgb` 2839 correct — 0 read only by `canvas`, 0 read only by `rgb`.

### The 44 frames that read differently (first 20)

| Path | VIN | Symbology | Tier | Drawn extras | app | other | Seed |
|---|---|---|---|---|---|---|---|
| yuv | `S9VUY70G2REGA0ABB` | code_39 | severe | glare + low_light | miss (no decode) | hit `S9VUY70G2REGA0ABB` | `0x617d883` |
| yuv | `RB8A3PC47V2V34HR7` | code_39 | severe | glare + low_light | miss (no decode) | miss `RB8A3PC47$2V34HR7` | `0x57393bf` |
| yuv | `YEKPKTE13B04VXLL9` | code_39 | severe | warp + glare | miss `YEKPKTE1%04VXLL9` | miss (no decode) | `0x48182941` |
| yuv | `L58SMKD8437CUANSG` | code_39 | severe | warp + low_light | miss (no decode) | hit `L58SMKD8437CUANSG` | `0x1ac20f04` |
| yuv | `4AUKWDWM27PBS1U8P` | code_39 | severe | warp + glare | hit `4AUKWDWM27PBS1U8P` | miss (no decode) | `0x473f98db` |
| yuv | `2HP17JK7X7PJTFMBM` | code_39 | severe | warp + glare | miss (no decode) | hit `2HP17JK7X7PJTFMBM` | `0x498f4ad2` |
| yuv | `510FT7G86F0D7V641` | code_39 | severe | warp + glare | hit `510FT7G86F0D7V641` | miss (no decode) | `0x834069a3` |
| yuv | `Z7T9GZZD0VMFK9M65` | code_39 | severe | glare + low_light | hit `Z7T9GZZD0VMFK9M65` | miss `Z7T9GZ+D0VMFK9M65` | `0x84717b2b` |
| yuv | `12F074JV0ULJR8CE7` | code_39 | severe | glare + low_light | miss (no decode) | hit `12F074JV0ULJR8CE7` | `0x6d36fb25` |
| yuv | `N86ZEF3D4K4WDWJM5` | code_39 | severe | warp + glare | miss `N86Z+F3D4K4WDWJM5` | miss `N86+EF3D4K4WDWJM5` | `0x49196d0c` |
| yuv | `MCM48HWY79NC3T20M` | code_39 | severe | warp + jpeg | hit `MCM48HWY79NC3T20M` | miss (no decode) | `0x64a09ed1` |
| yuv | `FZLZRF8C53G2BYUB0` | code_39 | severe | glare + low_light | hit `FZLZRF8C53G2BYUB0` | miss (no decode) | `0xd8b55f73` |
| yuv | `HYEXFVXD1HUY41KYU` | code_39_i | moderate | - | miss (no decode) | miss `EXFVXD1HUY41KYU` | `0x8d4812dd` |
| yuv | `1HGCM82633A004352` | code_39_i | severe | warp + low_light | miss (no decode) | hit `I1HGCM82633A004352` | `0xc8135248` |
| yuv | `MUUW9H4N0DSL1S1KV` | code_39_i | severe | warp + low_light | hit `IMUUW9H4N0DSL1S1KV` | miss (no decode) | `0x4cfd6cd3` |
| yuv | `DNUDA92B2W9V0SN9G` | code_39_i | severe | warp + low_light | hit `IDNUDA92B2W9V0SN9G` | miss (no decode) | `0x4f12f4ed` |
| yuv | `UY0UL1LJ04EVH6KYG` | code_39_i | severe | warp + low_light | miss (no decode) | hit `IUY0UL1LJ04EVH6KYG` | `0xc057f485` |
| yuv | `YDKU00AD5JDBRYVNR` | code_39_i | severe | low_light + jpeg | miss (no decode) | hit `IYDKU00AD5JDBRYVNR` | `0x993584d9` |
| yuv | `EE37XVLL3E7XTYSNH` | code_39_i | severe | glare + low_light | miss `IEE37XVLL%7XTYSNH` | hit `IEE37XVLL3E7XTYSNH` | `0xe200c184` |
| yuv | `M4C0PA4H68976FS0B` | code_39_i | severe | low_light + jpeg | hit `IM4C0PA4H68976FS0B` | miss (no decode) | `0x2a3cdc85` |

### Why the misses missed

| Symbology | Tier | no_decode | no_vin | carrier |
|---|---|---:|---:|---:|
| code_39 | clean | 0 | 0 | 0 |
| code_39 | moderate | 45 | 0 | 0 |
| code_39 | severe | 94 | 4 | 0 |
| code_39_i | clean | 0 | 0 | 0 |
| code_39_i | moderate | 42 | 0 | 0 |
| code_39_i | severe | 103 | 6 | 0 |
| code_39_check | clean | 0 | 152 | 0 |
| code_39_check | moderate | 49 | 114 | 0 |
| code_39_check | severe | 92 | 83 | 0 |
| code_128 | clean | 0 | 0 | 0 |
| code_128 | moderate | 38 | 0 | 0 |
| code_128 | severe | 80 | 1 | 0 |
| code_128_fnc1 | clean | 0 | 0 | 0 |
| code_128_fnc1 | moderate | 45 | 0 | 0 |
| code_128_fnc1 | severe | 199 | 0 | 0 |
| data_matrix | clean | 0 | 0 | 0 |
| data_matrix | moderate | 2 | 0 | 0 |
| data_matrix | severe | 90 | 0 | 0 |
| qr_code | clean | 3 | 0 | 0 |
| qr_code | moderate | 5 | 0 | 0 |
| qr_code | severe | 113 | 0 | 0 |

`no_decode` — ZXing found no symbol. `no_vin` — text decoded but §4.2 named no VIN. `carrier` — a §4.9 handoff payload, which §6.3 never extracts; nothing in this corpus is one, so any non-zero value here is itself a finding.

## Decode time

| Scope | Decodes | Mean ms | p95 ms |
|---|---:|---:|---:|
| canvas: all | 4200 | 21.4 | 87.9 |
| canvas: clean | 1400 | 7.7 | 11.7 |
| canvas: moderate | 1400 | 21.5 | 107.4 |
| canvas: severe | 1400 | 34.9 | 76.1 |
| yuv: all | 4200 | 21.0 | 87.6 |
| yuv: clean | 1400 | 7.1 | 10.6 |
| yuv: moderate | 1400 | 21.1 | 109.2 |
| yuv: severe | 1400 | 34.8 | 73.7 |
| rgb: all | 4200 | 16.2 | 80.7 |
| rgb: clean | 1400 | 4.0 | 4.9 |
| rgb: moderate | 1400 | 17.3 | 93.9 |
| rgb: severe | 1400 | 27.2 | 59.0 |

Times cover the ZXing read only — binarisation and the decode — and exclude getting the frame onto the canvas, because the app never parses a PNG either: it draws a video frame it already has. Timings are the one part of this report that is not bit-reproducible; no threshold rides on them. §13.4's mean **time-to-confirm** is not here: confirmation is two agreeing reads inside §6.3's window, which run (b) — the Playwright fake-camera pass — is what exercises. This run measures one frame at a time.

## §13.6 verdict

- false accepts: 1 (§13.6 requires 0) — code_128/severe EH8U2YHX60HU8VGWD -> EH8U2YHX60HU7VAWD
- false accepts off the app's path: 2 — yuv code_128/severe EH8U2YHX60HU8VGWD -> EH8U2YHX60HU7VAWD; rgb code_128/severe EH8U2YHX60HU8VGWD -> EH8U2YHX60HU7VAWD
- code_39 moderate: 77.5% < 90.0% (155/200 correct, -12.5 pp)
- code_39 severe: 51.0% < 70.0% (102/200 correct, -19.0 pp)
- code_39_i moderate: 79.0% < 90.0% (158/200 correct, -11.0 pp)
- code_39_i severe: 45.5% < 70.0% (91/200 correct, -24.5 pp)
- code_39_check clean: 24.0% < 99.0% (48/200 correct, -75.0 pp)
- code_39_check moderate: 18.5% < 90.0% (37/200 correct, -71.5 pp)
- code_39_check severe: 12.5% < 70.0% (25/200 correct, -57.5 pp)
- code_128 moderate: 81.0% < 90.0% (162/200 correct, -9.0 pp)
- code_128 severe: 59.0% < 70.0% (118/200 correct, -11.0 pp)
- code_128_fnc1 moderate: 77.5% < 90.0% (155/200 correct, -12.5 pp)
- code_128_fnc1 severe: 0.5% < 70.0% (1/200 correct, -69.5 pp)
- data_matrix severe: 55.0% < 70.0% (110/200 correct, -15.0 pp)
- qr_code clean: 98.5% < 99.0% (197/200 correct, -0.5 pp)
- qr_code severe: 43.5% < 70.0% (87/200 correct, -26.5 pp)

These numbers came out of `canvas` — the app's path — Chromium, `BrowserMultiFormatReader.decodeFromCanvas`, `HTMLCanvasElementLuminanceSource`, `decodeWithState`. That is the app's decoder in the app's engine, which the bench's node path was not (B2). What it still is not is a **camera frame**: the app draws a `<video>` element whose pixels came off a sensor through an ISP and YUV 4:2:0; this draws a PNG. `bench/camera-probe.ts` measures that last step on a subset — the same frames through Chromium's own fake capture device and a real `<video>` — and finds the camera reads slightly *worse*, deterministically, so these rates are a ceiling on the capture path and not a floor. Nothing here models a lens, and nothing here is a label.

Synthetic is not real (§13.4, §13.7). This bench tunes hints, ROI cropping and confirmation logic; real door-jamb labels on real trucks stay §7 item 4, and stay human.
