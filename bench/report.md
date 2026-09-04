# §13.4 scan-robustness bench

**FAIL** — 10 §13.6 thresholds missed.

## Run

| | |
|---|---|
| Run seed | `0x5eed1a7c` |
| VINs | 200 (full) |
| Symbologies | code_39, code_39_i, code_128, data_matrix, qr_code |
| Tiers | clean, moderate, severe |
| Attempts | 3000 |
| Decoder hints (§4.6) | CODE_39, CODE_128, DATA_MATRIX, QR_CODE; TRY_HARDER |
| Severe extras (Z5) | 2 of warp, glare, low_light, jpeg, drawn per frame from the seed |
| ZXing per-reader warnings swallowed | 5149 |

Every degradation seed is `runSeed ^ fnv1a("vin|symbology|tier")`, so this run reproduces exactly, and any single row below reproduces on its own.

## Headline: false accepts (§13.6 requires 0)

**1 FALSE ACCEPT** in 3000 attempts (threshold 0). A wrong VIN accepted is an S1 blocker (§13.3).

| Expected VIN | Returned VIN | Symbology | Tier | Drawn extras | ZXing format | Check digit | Decoded text | Seed |
|---|---|---|---|---|---|---|---|---|
| `EH8U2YHX60HU8VGWD` | `EH8U2YHX60HU7VAWD` | code_128 | severe | low_light + jpeg | CODE_128 | invalid | `EH8U2YHX60HU7VAWD` | `0xc5d3691c` |

Reproduce:

```ts
degrade(await renderBarcode("EH8U2YHX60HU8VGWD", "code_128"), "severe", 0xc5d3691c)
```

## Decode rate per symbology × tier

| Symbology | clean (>= 99.0%) | moderate (>= 90.0%) | severe (>= 70.0%) |
|---|---|---|---|
| code_39 | 100.0% PASS | 77.5% FAIL | 51.0% FAIL |
| code_39_i | 100.0% PASS | 79.0% FAIL | 45.5% FAIL |
| code_128 | 100.0% PASS | 81.0% FAIL | 59.0% FAIL |
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
| code_128 | clean | 200 | 200 | 0 | 0 | 0 | 100.0% | 99.0% | +1.0 pp | PASS |
| code_128 | moderate | 200 | 162 | 38 | 0 | 0 | 81.0% | 90.0% | -9.0 pp | FAIL |
| code_128 | severe | 200 | 118 | 81 | 0 | 1 | 59.0% | 70.0% | -11.0 pp | FAIL |
| data_matrix | clean | 200 | 200 | 0 | 0 | 0 | 100.0% | 99.0% | +1.0 pp | PASS |
| data_matrix | moderate | 200 | 198 | 2 | 0 | 0 | 99.0% | 90.0% | +9.0 pp | PASS |
| data_matrix | severe | 200 | 110 | 90 | 0 | 0 | 55.0% | 70.0% | -15.0 pp | FAIL |
| qr_code | clean | 200 | 197 | 3 | 0 | 0 | 98.5% | 99.0% | -0.5 pp | FAIL |
| qr_code | moderate | 200 | 195 | 5 | 0 | 0 | 97.5% | 90.0% | +7.5 pp | PASS |
| qr_code | severe | 200 | 87 | 113 | 0 | 0 | 43.5% | 70.0% | -26.5 pp | FAIL |

### Severe: what each frame drew

| Drawn extras | Frames | code_39 | code_39_i | code_128 | data_matrix | qr_code |
|---|---:|---:|---:|---:|---:|---:|
| glare + jpeg | 158 | 74.2% | 64.5% | 61.8% | 89.3% | 97.1% |
| glare + low_light | 190 | 9.4% | 7.3% | 10.0% | 7.3% | 63.9% |
| low_light + jpeg | 159 | 57.6% | 72.7% | 86.7% | 96.9% | 100.0% |
| warp + glare | 161 | 60.6% | 44.8% | 63.3% | 75.0% | 0.0% |
| warp + jpeg | 156 | 72.7% | 57.1% | 74.2% | 86.7% | 0.0% |
| warp + low_light | 176 | 34.2% | 35.5% | 71.4% | 2.7% | 0.0% |

§13.4 lists six degradations for `severe`; two of them — 50% scale and heavier grain — are harder settings of degradations `moderate` already applies, so they are on for every frame and the tier stays a strict superset of `moderate` whatever is drawn. The other four are drawn 2 at a time (Z5): all four at once is not one bad photo, it is every bad photo, and it left no cell above 57%.

### Why the misses missed

| Symbology | Tier | no_decode | no_vin | carrier |
|---|---|---:|---:|---:|
| code_39 | clean | 0 | 0 | 0 |
| code_39 | moderate | 45 | 0 | 0 |
| code_39 | severe | 94 | 4 | 0 |
| code_39_i | clean | 0 | 0 | 0 |
| code_39_i | moderate | 42 | 0 | 0 |
| code_39_i | severe | 103 | 6 | 0 |
| code_128 | clean | 0 | 0 | 0 |
| code_128 | moderate | 38 | 0 | 0 |
| code_128 | severe | 80 | 1 | 0 |
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
| all | 3000 | 10.5 | 49.6 |
| clean | 1000 | 3.1 | 4.8 |
| moderate | 1000 | 10.6 | 66.6 |
| severe | 1000 | 17.9 | 45.2 |

Times cover the ZXing pipeline only — luminance packing, binarisation and the read — because the app hands ZXing canvas pixels and never parses a PNG. Timings are the one part of this report that is not bit-reproducible; no threshold rides on them.

## §13.6 verdict

- false accepts: 1 (§13.6 requires 0) — code_128/severe EH8U2YHX60HU8VGWD -> EH8U2YHX60HU7VAWD
- code_39 moderate: 77.5% < 90.0% (155/200 correct, -12.5 pp)
- code_39 severe: 51.0% < 70.0% (102/200 correct, -19.0 pp)
- code_39_i moderate: 79.0% < 90.0% (158/200 correct, -11.0 pp)
- code_39_i severe: 45.5% < 70.0% (91/200 correct, -24.5 pp)
- code_128 moderate: 81.0% < 90.0% (162/200 correct, -9.0 pp)
- code_128 severe: 59.0% < 70.0% (118/200 correct, -11.0 pp)
- data_matrix severe: 55.0% < 70.0% (110/200 correct, -15.0 pp)
- qr_code clean: 98.5% < 99.0% (197/200 correct, -0.5 pp)
- qr_code severe: 43.5% < 70.0% (87/200 correct, -26.5 pp)

Synthetic is not real (§13.4, §13.7). This bench tunes hints, ROI cropping and confirmation logic; real door-jamb labels on real trucks stay §7 item 4, and stay human.
